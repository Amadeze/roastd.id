"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";

import { prisma } from "@/lib/prisma";
import { getCurrentDate } from "@/lib/date-utils";
import {
  consumePasswordResetToken,
  hashPasswordResetToken,
} from "@/lib/password-reset";
import {
  enforceRateLimit,
  RateLimitError,
} from "@/lib/rate-limit";
import {
  digestIdentifier,
  layeredIdentifiers,
  resolveClientIdentity,
} from "@/lib/client-identity";

export async function resetPassword(token: string, password: string) {
  try {
    const requestHeaders = await headers();
    const identity = resolveClientIdentity(requestHeaders);
    await enforceRateLimit({
      scope: "reset-password",
      identifiers: layeredIdentifiers(identity, [digestIdentifier("reset-token", token)]),
      limit: 10,
      windowSeconds: 60 * 60,
    });

    if (
      !token ||
      password.length < 8 ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return {
        success: false,
        message:
          "Token tidak valid atau password tidak memenuhi syarat: minimal 8 karakter, satu huruf kapital, dan satu angka.",
      };
    }

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashPasswordResetToken(token) },
      include: {
        user: {
          select: { id: true, tenantId: true, isActive: true },
        },
      },
    });

    if (
      !resetToken ||
      resetToken.usedAt ||
      resetToken.expiresAt <= getCurrentDate() ||
      !resetToken.user.isActive
    ) {
      return {
        success: false,
        message: "Tautan reset sudah tidak berlaku. Silakan buat permintaan baru.",
      };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.$transaction(async (tx) => {
      await consumePasswordResetToken(tx, {
        tokenId: resetToken.id,
        userId: resetToken.user.id,
        tenantId: resetToken.user.tenantId,
        passwordHash,
      });
    });

    return {
      success: true,
      message: "Password berhasil diperbarui. Silakan masuk kembali.",
    };
  } catch (error) {
    console.error("[resetPassword]", error);
    return {
      success: false,
      message:
        error instanceof RateLimitError
          ? error.message
          : error instanceof Error
              && ["RESET_TOKEN_ALREADY_USED", "RESET_USER_INACTIVE"].includes(error.message)
            ? "Tautan reset sudah tidak berlaku. Silakan buat permintaan baru."
          : "Password belum dapat diperbarui.",
    };
  }
}
