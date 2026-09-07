import { randomBytes } from "node:crypto";
import { appendLedger, appendFefoLedgerOut } from "@/lib/stock";
import { recordAudit } from "@/lib/audit";
import { postStockAdjustment } from "@/lib/posting";

// Flexible type: works with both base PrismaClient and tenant-scoped extended
// client (mengikuti konvensi stock.ts / audit.ts).
 
type TransactionClient = any;

export type AdjustSupplyStockInput = {
  operationKey?: string;
  supplyItemId: string;
  type: "IN" | "OUT";
  /** Kuantitas dalam baseUnit item (pecahan). */
  quantity: number;
  notes?: string;
};

/**
 * Penyesuaian stok supply (opname):
 *   • IN  → ledger SUPPLY_ADJUSTMENT_IN, incomingPrice = biaya saat ini.
 *   • OUT → wajib FEFO bila trackLot=true (SUPPLY_ADJUSTMENT_OUT), jika tidak
 *     langsung OUT dari cache.
 * Cache tidak ditulis langsung — selalu lewat ledger (appendLedger/FEFO).
 */
export async function adjustSupplyStock(
  prisma: TransactionClient,
  tenantId: string,
  userId: string,
  input: AdjustSupplyStockInput,
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { success: false, error: "Kuantitas penyesuaian harus lebih dari 0" };
  }

  const refId =
    input.operationKey || `OPNAME-${randomBytes(6).toString("hex").toUpperCase()}`;

  if (input.operationKey) {
    const existing = await prisma.inventoryLedger.findFirst({
      where: {
        tenantId,
        refId: input.operationKey,
        refType: { in: ["SUPPLY_ADJUSTMENT_IN", "SUPPLY_ADJUSTMENT_OUT"] },
      },
      select: { id: true },
    });
    if (existing) return { success: true };
  }

  await prisma.$transaction(
    async (tx: TransactionClient) => {
      const item = await tx.inventorySupplyItem.findUnique({
        where: { id: input.supplyItemId },
        select: {
          tenantId: true,
          category: true,
          avgCostPerUnit: true,
          costPerUnit: true,
          trackLot: true,
          includeInProductHpp: true,
        },
      });
      if (!item) throw new Error("Supply item tidak ditemukan");
      if (item.tenantId !== tenantId) throw new Error("Supply item bukan milik tenant ini.");

      const unitCost = Number(item.avgCostPerUnit ?? item.costPerUnit ?? 0);
      const refType =
        input.type === "IN" ? ("SUPPLY_ADJUSTMENT_IN" as const) : ("SUPPLY_ADJUSTMENT_OUT" as const);

      if (input.type === "IN") {
        await appendLedger(tx, {
          data: {
            tenantId,
            supplyItemId: input.supplyItemId,
            entryType: "IN",
            refType,
            refId,
            supplyQuantity: input.quantity,
            incomingPrice: unitCost || undefined,
            notes: input.notes || "Penyesuaian stok fisik (Opname)",
            createdById: userId,
          },
        });
      } else if (item.trackLot) {
        await appendFefoLedgerOut(tx, {
          tenantId,
          supplyItemId: input.supplyItemId,
          supplyQuantity: input.quantity,
          refType,
          refId,
          createdById: userId,
          notes: input.notes || "Penyesuaian stok fisik (Opname)",
        });
      } else {
        await appendLedger(tx, {
          data: {
            tenantId,
            supplyItemId: input.supplyItemId,
            entryType: "OUT",
            refType,
            refId,
            supplyQuantity: input.quantity,
            notes: input.notes || "Penyesuaian stok fisik (Opname)",
            createdById: userId,
          },
        });
      }

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "ADJUST",
        entityType: "SupplyStock",
        entityId: input.supplyItemId,
        metadata: {
          direction: input.type,
          quantity: input.quantity,
          notes: input.notes,
        },
      });

      await postStockAdjustment(
        refId,
        "SUPPLY",
        input.type,
        input.quantity,
        unitCost,
        { tx, tenantId, userId },
        { category: item.category, includeInProductHpp: item.includeInProductHpp },
      );
    },
    { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 },
  );

  return { success: true };
}