import type { Prisma } from "@prisma/client";

// Use a flexible type that works with both base and tenant-scoped Prisma clients
 
type TransactionClient = any;

type AuditInput = {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
};

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function recordAudit(tx: TransactionClient, input: AuditInput) {
  return tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: toJsonValue(input.before),
      after: toJsonValue(input.after),
      metadata: toJsonValue(input.metadata),
    },
  });
}
