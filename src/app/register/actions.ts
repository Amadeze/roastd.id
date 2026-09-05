"use server";

import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { getIronSession } from "iron-session";
import { SESSION_OPTIONS, type SessionUser } from "@/lib/session";
import { getCurrentDate } from "@/lib/date-utils";
import {
  enforceRateLimit,
  RateLimitError,
} from "@/lib/rate-limit";
import { isReservedTenantSubdomain } from "@/lib/tenant-host";
import { sendEmailVerificationEmail } from "@/lib/notifications";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  createEmailVerificationToken,
  hashEmailVerificationToken,
} from "@/lib/email-verification";
import {
  emailIdentifier,
  layeredIdentifiers,
  resolveClientIdentity,
} from "@/lib/client-identity";

export async function registerTenant(data: {
  roasteryName: string;
  subdomain: string;
  email: string;
  password: string;
  tier?: "TRIAL" | "BASIC" | "PRO" | "ENTERPRISE";
}) {
  try {
    const roasteryName = data.roasteryName.trim();
    const subdomain = data.subdomain.toLowerCase().trim();
    const email = data.email.toLowerCase().trim();
    const password = data.password;
    const requestHeaders = await headers();
    const identity = resolveClientIdentity(requestHeaders);
    await enforceRateLimit({
      scope: "register",
      identifiers: layeredIdentifiers(identity, [emailIdentifier(email)]),
      limit: 5,
      windowSeconds: 60 * 60,
    });

    // 1. Basic validations
    if (!roasteryName || !subdomain || !email || !password) {
      return { success: false, error: "All fields are required" };
    }

    if (roasteryName.length > 100) {
      return { success: false, error: "Roastery name is too long" };
    }

    if (
      subdomain.length < 3 ||
      subdomain.length > 40 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain)
    ) {
      return { success: false, error: "Subdomain can only contain lowercase letters, numbers, and hyphens" };
    }

    if (isReservedTenantSubdomain(subdomain)) {
      return { success: false, error: "Subdomain is reserved" };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: "Email is invalid" };
    }

    if (password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters" };
    }

    if (!/[A-Z]/.test(password)) {
      return { success: false, error: "Password must contain at least one uppercase letter" };
    }

    if (!/[0-9]/.test(password)) {
      return { success: false, error: "Password must contain at least one number" };
    }

    // 2. Check if subdomain exists
    const existingTenant = await prisma.tenant.findUnique({
      where: { subdomain },
    });
    if (existingTenant) {
      return { success: false, error: "Subdomain is already taken" };
    }

    // 3. Check if email exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      return { success: false, error: "Email is already registered" };
    }

    // 4. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 5. Create Tenant and User in transaction
    // Set 21 days trial
    const trialEndsAt = getCurrentDate();
    trialEndsAt.setDate(trialEndsAt.getDate() + 21);

    const result = await prisma.$transaction(async (tx) => {
      const newTenant = await tx.tenant.create({
        data: {
          code: subdomain.toUpperCase(), // basic code generation
          name: roasteryName,
          subdomain: subdomain,
          subscriptionTier: "TRIAL",
          subscriptionStatus: "ACTIVE",
          trialEndsAt: trialEndsAt,
        },
      });

      // emailVerifiedAt sengaja null: kepemilikan email belum terbukti.
      // Login diblokir sampai verifikasi selesai (lihat loginAction).
      const newUser = await tx.user.create({
        data: {
          tenantId: newTenant.id,
          name: email.split("@")[0],
          email: email,
          password: hashedPassword,
          role: "OWNER",
        },
      });

      return { tenant: newTenant, user: newUser };
    });

    // Token verifikasi disimpan sebagai hash; tautan berisi token mentah.
    // Gagal kirim email tidak membatalkan pendaftaran — user bisa minta
    // ulang tautan dari halaman verifikasi (rate-limited).
    const verificationToken = createEmailVerificationToken();
    await prisma.emailVerificationToken.deleteMany({
      where: { userId: result.user.id },
    });
    await prisma.emailVerificationToken.create({
      data: {
        userId: result.user.id,
        tokenHash: hashEmailVerificationToken(verificationToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      },
    });

    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error("APP_URL environment variable is required");
    await sendEmailVerificationEmail(
      result.user.email,
      result.user.name,
      `${appUrl}/verify-email?token=${encodeURIComponent(verificationToken)}`,
    );

    return { success: true, checkEmail: true as const };
  } catch (error) {
    console.error("Registration error:", error);
    return {
      success: false,
      // Jangan bocorkan error internal (Prisma/env) ke klien.
      error:
        error instanceof RateLimitError
          ? error.message
          : "Something went wrong. Please try again.",
    };
  }
}

export async function registerTenantWithGoogle(data: {
  roasteryName: string;
  subdomain: string;
}) {
  try {
    const roasteryName = data.roasteryName.trim();
    const subdomain = data.subdomain.toLowerCase().trim();
    const requestHeaders = await headers();
    const identity = resolveClientIdentity(requestHeaders);

    if (!roasteryName || !subdomain) {
      return { success: false, error: "Nama Roastery and Subdomain are required" };
    }

    if (
      subdomain.length < 3 ||
      subdomain.length > 40 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain)
    ) {
      return { success: false, error: "Subdomain can only contain lowercase letters, numbers, and hyphens" };
    }

    if (isReservedTenantSubdomain(subdomain)) {
      return { success: false, error: "Subdomain is reserved" };
    }

    const cookieStore = await cookies();
    const signupSession = await getIronSession<{ googleUser?: { sub: string, email: string, name: string } }>(cookieStore, {
      password: SESSION_OPTIONS.password,
      cookieName: "ros_google_signup",
      cookieOptions: SESSION_OPTIONS.cookieOptions
    });

    if (!signupSession.googleUser) {
      return { success: false, error: "Sesi Google tidak valid atau kedaluwarsa. Silakan ulangi Sign in dengan Google." };
    }

    const { sub: googleId, email, name } = signupSession.googleUser;

    await enforceRateLimit({
      scope: "register",
      identifiers: layeredIdentifiers(identity, [emailIdentifier(email)]),
      limit: 5,
      windowSeconds: 60 * 60,
    });

    const existingTenant = await prisma.tenant.findUnique({
      where: { subdomain },
    });
    if (existingTenant) {
      return { success: false, error: "Subdomain is already taken" };
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      return { success: false, error: "Email is already registered" };
    }

    const trialEndsAt = getCurrentDate();
    trialEndsAt.setDate(trialEndsAt.getDate() + 21);

    const result = await prisma.$transaction(async (tx) => {
      const newTenant = await tx.tenant.create({
        data: {
          code: subdomain.toUpperCase(),
          name: roasteryName,
          subdomain: subdomain,
          subscriptionTier: "TRIAL",
          subscriptionStatus: "ACTIVE",
          trialEndsAt: trialEndsAt,
        },
      });

      const newUser = await tx.user.create({
        data: {
          tenantId: newTenant.id,
          name: name || email.split("@")[0],
          email: email,
          googleId: googleId,
          // Google sudah memverifikasi kepemilikan email ini (callback
          // menolak email_verified=false), jadi akun langsung terverifikasi.
          emailVerifiedAt: getCurrentDate(),
          role: "OWNER",
        },
      });

      return { tenant: newTenant, user: newUser };
    });

    // Destroy signup session
    signupSession.destroy();

    const session = await getIronSession<{ user?: SessionUser }>(cookieStore, SESSION_OPTIONS);
    session.user = {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      tenantId: result.tenant.id,
      sessionVersion: result.user.sessionVersion,
    };
    await session.save();

    return { success: true, tenantId: result.tenant.id };
  } catch (error) {
    console.error("Google Registration error:", error);
    return {
      success: false,
      // Jangan bocorkan error internal (Prisma/env) ke klien.
      error:
        error instanceof RateLimitError
          ? error.message
          : "Something went wrong. Please try again.",
    };
  }
}
