"use server";

import { getIronSession, type IronSession } from "iron-session";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { SESSION_OPTIONS, type SessionUser } from "@/lib/session";
import {
  enforceRateLimit,
  RateLimitError,
} from "@/lib/rate-limit";
import {
  emailIdentifier,
  layeredIdentifiers,
  resolveClientIdentity,
} from "@/lib/client-identity";

type AppSession = IronSession<{ user?: SessionUser }>;

// Hash dummy untuk menyamakan timing jalur user-tidak-ada dengan jalur
// bcrypt.compare (anti user-enumeration via latency).
const DUMMY_BCRYPT_HASH =
  "$2b$10$.6JGTZygDBkOSG/EhMryxOY6KAKi.akuaSj5p8D8K3KuaTr1V3/8a";

// ─── Login ───────────────────────────────────────────────────────────────────

export type LoginResult =
  | { success: true; role: string }
  | { success: false; error: string; code?: "EmailNotVerified" };

export async function loginAction(email: string, password: string): Promise<LoginResult> {
  try {
    const requestHeaders = await headers();
    const identity = resolveClientIdentity(requestHeaders);
    await enforceRateLimit({
      scope: "login",
      identifiers: layeredIdentifiers(identity, [emailIdentifier(email)]),
      limit: 5,
      windowSeconds: 15 * 60,
    });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        password: true,
        isActive: true,
        tenantId: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        sessionVersion: true,
        emailVerifiedAt: true,
        tenant: { select: { isActive: true } },
      },
    });

    if (!user || !user.isActive || !user.tenant.isActive) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      return { success: false, error: "Email atau password salah." };
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return { success: false, error: "Akun dikunci sementara. Coba lagi nanti." };
    }

    // Compare password using bcrypt
    if (!user.password) {
      return { success: false, error: "Email atau password salah." };
    }
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, lockedUntil },
      });
      return { success: false, error: "Email atau password salah." };
    }

    // Gerbang verifikasi email: akun password self-service wajib membuktikan
    // kepemilikan email sebelum bisa masuk. Semua jalur pembuatan user lain
    // (superadmin, undangan owner, reset password, Google) menandai verified.
    if (!user.emailVerifiedAt) {
      return {
        success: false,
        error: "Email belum diverifikasi. Periksa inbox Anda atau minta tautan verifikasi baru.",
        code: "EmailNotVerified",
      };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    const cookieStore = await cookies();
    const session = await getIronSession<{ user?: SessionUser }>(cookieStore, SESSION_OPTIONS);

    session.user = {
      id:    user.id,
      name:  user.name,
      email: user.email,
      role:  user.role as SessionUser["role"],
      tenantId: user.tenantId,
      sessionVersion: user.sessionVersion,
    };

    await session.save();

    return { success: true, role: user.role };
  } catch (err) {
    console.error("[loginAction]", err);
    if (err instanceof RateLimitError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: "Terjadi kesalahan. Coba lagi." };
  }
}

// ─── Logout ──────────────────────────────────────────────────────────────────

export async function logoutAction() {
  const cookieStore = await cookies();
  const session = await getIronSession<{ user?: SessionUser }>(cookieStore, SESSION_OPTIONS);
  session.destroy();
  redirect("/login");
}

