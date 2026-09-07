import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { resolvePurchasePaymentFromAmount } from "@/lib/purchase-payments";
import { postPurchase } from "@/lib/posting";
import { recordAudit } from "@/lib/audit";
import { receiveSupply } from "@/lib/supply-stock";

// Flexible type: works with both base PrismaClient and tenant-scoped extended
// client (mengikuti konvensi stock.ts / audit.ts).
 
type SupplyDb = any;

export type CreateSupplyPurchaseInput = {
  operationKey: string;
  supplierId: string;
  supplyItemId: string;
  supplyQuantity: number;
  totalCost: number;
  shippingCost: number;
  paidAmount?: number;
  paymentMethod?: "CASH" | "TRANSFER" | "QRIS";
  dueDate?: string;
  receivedAt: string;
  notes?: string;
  lotNumber?: string;
  bestBeforeDate?: string;
  /** Optional smart-storage destination location for the created lot. */
  destinationLocationId?: string | null;
};

function generateSupplierPaymentCode(receivedAt: Date): string {
  const prefix = `SPAY-${receivedAt.getFullYear()}${String(receivedAt.getMonth() + 1).padStart(2, "0")}`;
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function parseDueDate(
  paid: boolean,
  dueDate: string | undefined,
  receivedAt: Date,
): Date | null {
  if (paid) return null;
  const parsed = dueDate ? new Date(`${dueDate}T23:59:59`) : new Date(receivedAt);
  if (!dueDate) parsed.setDate(parsed.getDate() + 14);
  if (Number.isNaN(parsed.getTime())) throw new Error("Tanggal jatuh tempo tidak valid.");
  return parsed;
}

/**
 * Direct purchase supply (non-PO): Purchase type SUPPLY + Lot (bila trackLot)
 * + ledger SUPPLY_PURCHASE_IN + cache. Idempotent via operationKey.
 */
export async function createSupplyPurchase(
  prisma: SupplyDb,
  tenantId: string,
  userId: string,
  input: CreateSupplyPurchaseInput,
): Promise<{ success: true; purchaseCode: string }> {
  if (!input.operationKey) throw new Error("Identitas transaksi tidak valid.");
  if (!Number.isFinite(input.supplyQuantity) || input.supplyQuantity <= 0) {
    throw new Error("Kuantitas supply harus lebih dari 0.");
  }
  if (!Number.isFinite(input.totalCost) || input.totalCost <= 0) {
    throw new Error("Total pembelian harus lebih dari 0.");
  }
  const shippingCost = Number(input.shippingCost ?? 0);
  if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost >= input.totalCost) {
    throw new Error("Ongkos kirim harus lebih kecil dari total pembelian.");
  }

  const previousAttempt = await prisma.purchase.findFirst({
    where: { tenantId, operationKey: input.operationKey },
    select: { code: true },
  });
  if (previousAttempt) return { success: true, purchaseCode: previousAttempt.code };

  const payment = resolvePurchasePaymentFromAmount(input.totalCost, input.paidAmount);
  const receivedAt = new Date(`${input.receivedAt}T00:00:00`);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error("Tanggal penerimaan tidak valid.");
  }
  const dueDate = parseDueDate(payment.paymentStatus === "PAID", input.dueDate, receivedAt);

  const [supplier, supplyItem] = await Promise.all([
    prisma.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.inventorySupplyItem.findUnique({
      where: { id: input.supplyItemId },
      select: { id: true, tenantId: true, isActive: true, category: true },
    }),
  ]);
  if (!supplier?.isActive) {
    throw new Error("Supplier tidak ditemukan atau sudah nonaktif.");
  }
  if (!supplyItem || !supplyItem.isActive) {
    throw new Error("Supply item tidak ditemukan atau sudah nonaktif.");
  }
  if (supplyItem.tenantId !== tenantId) {
    throw new Error("Supply item bukan milik tenant ini.");
  }

  const purchaseCode = `PUR-${receivedAt.getFullYear()}${String(receivedAt.getMonth() + 1).padStart(2, "0")}-${randomBytes(4).toString("hex").toUpperCase()}`;
  const itemCost = input.totalCost - shippingCost;
  const pricePerUnit = itemCost / input.supplyQuantity;

  // Kode PUR random bisa bentrok saat dua pembelian berjalan bersamaan;
  // retry seluruh transaksi (atomik, rollback) pada unique constraint
  // dengan kandidat baru setiap percobaan.
  const MAX_CODE_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const attemptCode =
      attempt === 0
        ? purchaseCode
        : `PUR-${receivedAt.getFullYear()}${String(receivedAt.getMonth() + 1).padStart(2, "0")}-${randomBytes(4).toString("hex").toUpperCase()}`;
    try {
      await prisma.$transaction(
        async (tx: SupplyDb) => {
          const purchase = await tx.purchase.create({
            data: {
              tenantId,
              code: attemptCode,
              operationKey: input.operationKey,
              type: "SUPPLY",
              supplierId: input.supplierId,
              supplyItemId: input.supplyItemId,
              supplyQuantity: input.supplyQuantity,
              pricePerUnit,
              shippingCost,
              totalCost: input.totalCost,
              status: "COMPLETED",
              paymentStatus: payment.paymentStatus,
              paidAmount: payment.paidAmount,
              dueDate,
              receivedAt,
              notes: input.notes ?? null,
              createdById: userId,
            },
          });

          if (payment.paidAmount > 0) {
            await tx.supplierPayment.create({
              data: {
                tenantId,
                code: generateSupplierPaymentCode(receivedAt),
                purchaseId: purchase.id,
                amount: payment.paidAmount,
                method: input.paymentMethod ?? "CASH",
                paidAt: receivedAt,
                notes:
                  payment.paymentStatus === "PARTIAL" ? "Uang muka pembelian" : "Pembayaran pembelian",
                createdById: userId,
              },
            });
          }

          await receiveSupply(tx, {
            tenantId,
            userId,
            supplyItemId: input.supplyItemId,
            quantity: input.supplyQuantity,
            incomingPrice: input.totalCost / input.supplyQuantity,
            refType: "SUPPLY_PURCHASE_IN",
            refId: purchase.id,
            batchCode: attemptCode,
            lotNumber: input.lotNumber ?? null,
            expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
            notes: `Barang datang: ${attemptCode}`,
            receivedAt,
            supplierId: input.supplierId,
            purchaseId: purchase.id,
            destinationLocationId: input.destinationLocationId,
          });

          await recordAudit(tx, {
            tenantId,
            userId,
            action: "CREATE",
            entityType: "Purchase",
            entityId: purchase.id,
            after: {
              code: purchase.code,
              type: purchase.type,
              totalCost: Number(purchase.totalCost),
              paymentStatus: purchase.paymentStatus,
              paidAmount: Number(purchase.paidAmount),
            },
            metadata: { operationKey: input.operationKey, balance: payment.balance },
          });

          await postPurchase(
            purchase.id,
            "SUPPLY",
            Number(input.totalCost),
            Number(payment.paidAmount),
            supplier.name,
            { tx, tenantId, userId, date: receivedAt },
            supplyItem.category,
          );
        },
        { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 },
      );
      return { success: true, purchaseCode: attemptCode };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        attempt + 1 < MAX_CODE_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Terlalu banyak percobaan membuat kode pembelian; coba lagi.");
}