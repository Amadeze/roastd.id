import crypto from "crypto";
import { getCurrentDate } from "@/lib/date-utils";

// Use a flexible type that works with both base and tenant-scoped Prisma clients
 
type TransactionClient = any;

export function createPasswordResetToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashPasswordResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function consumePasswordResetToken(
  tx: TransactionClient,
  input: {
    tokenId: string;
    userId: string;
    tenantId: string;
    passwordHash: string;
    now?: Date;
  },
) {
  const now = input.now ?? getCurrentDate();
  const claimed = await tx.passwordResetToken.updateMany({
    where: {
      id: input.tokenId,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw new Error("RESET_TOKEN_ALREADY_USED");

  const updatedUser = await tx.user.updateMany({
    where: { id: input.userId, isActive: true },
    data: {
      password: input.passwordHash,
      // Invalidate every stateless session issued before this reset.
      sessionVersion: { increment: 1 },
      // Kepemilikan email terbukti lewat tautan reset ini.
      emailVerifiedAt: now,
    },
  });
  if (updatedUser.count !== 1) throw new Error("RESET_USER_INACTIVE");

  await tx.passwordResetToken.deleteMany({
    where: {
      userId: input.userId,
      id: { not: input.tokenId },
    },
  });
  await tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: "PASSWORD_RESET",
      entityType: "User",
      entityId: input.userId,
    },
  });
}
