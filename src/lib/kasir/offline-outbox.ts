export interface OutboxTransaction {
  id: string;
  operationKey: string;
  createdAt: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; discount: number }>;
  invoiceDiscount: number;
  tax: number;
  taxType: "NONE" | "PPN";
  status: "PAID";
  paymentMethod: string;
  notes: string;
  syncStatus: "PENDING" | "SYNCING" | "FAILED";
  syncError?: string;
  syncAttempts: number;
  lastSyncAt?: string;
}

const OUTBOX_KEY = "roastd.kasir.outbox";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readOutbox(): OutboxTransaction[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is OutboxTransaction => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return (
        typeof e.id === "string" &&
        typeof e.operationKey === "string" &&
        typeof e.createdAt === "string" &&
        typeof e.customerId === "string" &&
        Array.isArray(e.items) &&
        e.syncStatus === "PENDING" || e.syncStatus === "SYNCING" || e.syncStatus === "FAILED"
      );
    });
  } catch {
    return [];
  }
}

function writeOutbox(transactions: OutboxTransaction[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(transactions));
  } catch {}
}

export function loadOutbox(): OutboxTransaction[] {
  return readOutbox();
}

export function loadPendingTransactions(): OutboxTransaction[] {
  return readOutbox().filter((t) => t.syncStatus === "PENDING" || t.syncStatus === "FAILED");
}

export function addToOutbox(tx: OutboxTransaction): void {
  const outbox = readOutbox();
  const index = outbox.findIndex((e) => e.id === tx.id);
  if (index >= 0) {
    outbox[index] = tx;
  } else {
    outbox.unshift(tx);
  }
  writeOutbox(outbox);
}

export function updateOutboxTransaction(id: string, updates: Partial<OutboxTransaction>): void {
  const outbox = readOutbox();
  const index = outbox.findIndex((e) => e.id === id);
  if (index >= 0) {
    outbox[index] = { ...outbox[index], ...updates };
    writeOutbox(outbox);
  }
}

export function removeFromOutbox(id: string): void {
  writeOutbox(readOutbox().filter((e) => e.id !== id));
}

export function createOutboxTransactionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getOutboxCount(): number {
  return loadPendingTransactions().length;
}
