import crypto from "crypto";
import { getCurrentDate } from "@/lib/date-utils";

// Use a flexible type that works with both base and tenant-scoped Prisma clients
 
type TransactionClient = any;

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createEmailVerificationToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashEmailVerificationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Klaim single-use token verifikasi email di dalam transaksi:
 * tandai usedAt (atomik, hanya bila belum dipakai & belum kedaluwarsa),
 * set emailVerifiedAt user, lalu hapus token lain milik user yang sama.
 * Melempar error bila token tidak valid agar caller bisa membedakan pesan.
 */
export async function consumeEmailVerificationToken(
  tx: TransactionClient,
  input: {
    tokenId: string;
    now?: Date;
  },
) {
  const now = input.now ?? getCurrentDate();
  const claimed = await tx.emailVerificationToken.updateMany({
    where: {
      id: input.tokenId,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw new Error("VERIFICATION_TOKEN_INVALID");

  const token = await tx.emailVerificationToken.findUnique({
    where: { id: input.tokenId },
    select: { userId: true },
  });
  if (!token) throw new Error("VERIFICATION_TOKEN_INVALID");

  const updatedUser = await tx.user.updateMany({
    where: { id: token.userId, isActive: true, emailVerifiedAt: null },
    data: { emailVerifiedAt: now },
  });
  if (updatedUser.count !== 1) {
    // Sudah terverifikasi sebelumnya (race) atau akun nonaktif.
    const user = await tx.user.findUnique({
      where: { id: token.userId },
      select: { isActive: true, emailVerifiedAt: true },
    });
    if (!user || !user.isActive) throw new Error("USER_INACTIVE");
    throw new Error("ALREADY_VERIFIED");
  }

  await tx.emailVerificationToken.deleteMany({
    where: { userId: token.userId, id: { not: input.tokenId } },
  });

  return token.userId;
}
