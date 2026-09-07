import type { Prisma } from "@prisma/client";

// Structural so the helper works with both the base PrismaClient and the
// tenant-scoped extended client (withTenant). Their $transaction overloads
// differ slightly, so the callback parameter stays untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TransactionClient = any;

export type TransactionLike = {
  $transaction<T>(
    callback: (tx: TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

function isPrismaError(err: unknown, code: string): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

function containsSerializationFailure(value: unknown, depth = 0): boolean {
  if (depth > 5 || value == null) return false;
  if (typeof value === "string") {
    return value.includes("40001") || value.toLowerCase().includes("could not serialize access");
  }
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return [
    record.message,
    record.meta,
    record.cause,
    record.driverAdapterError,
    record.originalCode,
  ].some((candidate) => containsSerializationFailure(candidate, depth + 1));
}

function isRetryableTransactionConflict(err: unknown): boolean {
  if (isPrismaError(err, "P2034")) return true;

  // Prisma 7's PostgreSQL driver adapter can surface SQLSTATE 40001 from an
  // interactive transaction as P2010. Retry only when the underlying error
  // explicitly identifies a serialization failure; other raw-query failures
  // must still fail immediately.
  return isPrismaError(err, "P2010") && containsSerializationFailure(err);
}

/**
 * Runs a Serializable interactive transaction with bounded retry.
 *
 * Retries Prisma transaction conflicts (P2034, plus Prisma 7 adapter P2010
 * wrapping PostgreSQL SQLSTATE 40001). Any other error is rethrown
 * immediately. The callback is re-run as one unit, so a failed attempt never
 * commits partial writes (no duplicate rows).
 */
export async function withSerializableRetry<T>(
  client: TransactionLike,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 3,
  transactionOptions: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await client.$transaction(callback, {
        isolationLevel: "Serializable",
        ...transactionOptions,
      });
    } catch (err) {
      if (isRetryableTransactionConflict(err) && attempt < maxAttempts - 1) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      throw err;
    }
  }
}
