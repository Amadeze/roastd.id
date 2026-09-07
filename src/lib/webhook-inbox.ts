import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { getCurrentDate } from "@/lib/date-utils";

// Use a flexible type that works with both base and tenant-scoped Prisma clients
 
type TransactionClient = any;

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS = 30 * 1000;

export class PermanentWebhookError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "PermanentWebhookError";
    this.statusCode = statusCode;
  }
}

export function timingSafeEqualText(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function claimWebhookEvent(
  client: TransactionClient,
  input: {
    tenantId: string;
    provider: string;
    eventId: string;
    eventType: string;
    payload: Prisma.InputJsonValue;
    now?: Date;
    leaseMs?: number;
  },
) {
  const now = input.now ?? getCurrentDate();
  try {
    const event = await client.webhookEvent.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
        receivedAt: now,
      },
    });
    return { claimed: true as const, eventId: event.id, retry: false };
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || error.code !== "P2002"
    ) {
      throw error;
    }
  }

  const existing = await client.webhookEvent.findUnique({
    where: {
      tenantId_provider_eventId: {
        tenantId: input.tenantId,
        provider: input.provider,
        eventId: input.eventId,
      },
    },
    select: { id: true, status: true, receivedAt: true },
  });
  if (!existing) throw new Error("Webhook event claim conflict could not be resolved.");

  const staleBefore = new Date(now.getTime() - (input.leaseMs ?? DEFAULT_LEASE_MS));
  const stuckThreshold = new Date(now.getTime() - STUCK_THRESHOLD_MS);
  const retryable =
    existing.status === "FAILED"
    || (existing.status === "RECEIVED" && existing.receivedAt < stuckThreshold);
  if (!retryable) {
    return { claimed: false as const, eventId: existing.id, retry: false };
  }

  const reclaimed = await client.webhookEvent.updateMany({
    where: {
      id: existing.id,
      status: existing.status,
      ...(existing.status === "RECEIVED"
        ? { receivedAt: { lt: staleBefore } }
        : {}),
    },
    data: {
      status: "RECEIVED",
      eventType: input.eventType,
      payload: input.payload,
      error: null,
      processedAt: null,
      receivedAt: now,
    },
  });
  return {
    claimed: reclaimed.count === 1,
    eventId: existing.id,
    retry: reclaimed.count === 1,
  } as const;
}
