import { appendLedger } from "./stock";
import { createLotPlacementInTx } from "./storage-location";

// Flexible type: works with both base PrismaClient and tenant-scoped extended
// client (mengikuti konvensi stock.ts / audit.ts).
 
export type SupplyDb = any;

export type ReceiveSupplyOptions = {
  tenantId: string;
  userId: string;
  supplyItemId: string;
  /** Kuantitas dalam baseUnit item (pecahan). */
  quantity: number;
  /** Biaya per baseUnit — masuk moving average. */
  incomingPrice: number;
  refType: "SUPPLY_PURCHASE_IN";
  refId: string;
  /** Kode batch/lot — dipakai juga sebagai batchCode lot. */
  batchCode: string;
  lotNumber?: string | null;
  expiryDate?: Date | string | null;
  notes?: string | null;
   receivedAt: Date;
   supplierId?: string | null;
   purchaseId?: string | null;
   /** Smart-storage destination location for the created lot. */
   destinationLocationId?: string | null;
 };

/**
 * Terima supply masuk (purchase / receiving): buat Lot bila trackLot=true,
 * sisipkan ledger IN (SUPPLY_PURCHASE_IN) + update cache stockQuantity dan
 * avgCostPerUnit di InventorySupplyItem. Tidak menyentuh cache Packaging.
 */
export async function receiveSupply(
  tx: SupplyDb,
  opts: ReceiveSupplyOptions,
): Promise<{ lotId: string | null; batchCode: string | null }> {
  const item = await tx.inventorySupplyItem.findUnique({
    where: { id: opts.supplyItemId },
    select: { tenantId: true, trackLot: true, shelfLifeDays: true },
  });
  if (!item) throw new Error("Supply item tidak ditemukan.");
  if (item.tenantId !== opts.tenantId) {
    throw new Error("Supply item bukan milik tenant ini.");
  }
  if (!Number.isFinite(opts.quantity) || opts.quantity <= 0) {
    throw new Error("Kuantitas supply harus lebih dari 0.");
  }

  let expiryDate = opts.expiryDate ? new Date(opts.expiryDate) : null;
  if (!expiryDate && item.shelfLifeDays && item.shelfLifeDays > 0) {
    expiryDate = new Date(opts.receivedAt);
    expiryDate.setDate(expiryDate.getDate() + item.shelfLifeDays);
  }

  let lotId: string | null = null;
  let batchCode: string | null = null;
  if (item.trackLot) {
    const lot = await tx.lot.create({
      data: {
        tenantId: opts.tenantId,
        supplyItemId: opts.supplyItemId,
        supplierId: opts.supplierId ?? null,
        purchaseId: opts.purchaseId ?? null,
        batchCode: opts.batchCode,
        supplyQuantity: opts.quantity,
        expiryDate,
        receivedAt: opts.receivedAt,
        notes: opts.lotNumber ? `Lot supplier: ${opts.lotNumber}` : null,
      },
    });
    lotId = lot.id;
    batchCode = lot.batchCode;

    if (opts.destinationLocationId && lotId) {
      await createLotPlacementInTx(tx, opts.tenantId, lotId, {
        destinationLocationId: opts.destinationLocationId,
        supplyQty: opts.quantity,
      });
    }
  }

  await appendLedger(tx, {
    data: {
      tenantId: opts.tenantId,
      supplyItemId: opts.supplyItemId,
      entryType: "IN",
      refType: opts.refType,
      refId: opts.refId,
      supplyQuantity: opts.quantity,
      incomingPrice: opts.incomingPrice,
      lotId,
      lotNumber: batchCode,
      expiryDate,
      notes: opts.notes ?? undefined,
      createdById: opts.userId,
    },
  });

  return { lotId, batchCode };
}

async function packagingLedgerBalance(
  client: SupplyDb,
  tenantId: string,
  packagingId: string,
): Promise<number> {
  const [inSum, outSum] = await Promise.all([
    client.inventoryLedger.aggregate({
      _sum: { quantityUnit: true },
      where: { tenantId, packagingId, supplyItemId: null, entryType: "IN" },
    }),
    client.inventoryLedger.aggregate({
      _sum: { quantityUnit: true },
      where: { tenantId, packagingId, supplyItemId: null, entryType: "OUT" },
    }),
  ]);
  return Number(inSum._sum.quantityUnit ?? 0) - Number(outSum._sum.quantityUnit ?? 0);
}

async function supplyLedgerBalance(
  client: SupplyDb,
  tenantId: string,
  supplyItemId: string,
): Promise<number> {
  const [inSum, outSum] = await Promise.all([
    client.inventoryLedger.aggregate({
      _sum: { supplyQuantity: true },
      where: { tenantId, supplyItemId, entryType: "IN" },
    }),
    client.inventoryLedger.aggregate({
      _sum: { supplyQuantity: true },
      where: { tenantId, supplyItemId, entryType: "OUT" },
    }),
  ]);
  return Number(inSum._sum.supplyQuantity ?? 0) - Number(outSum._sum.supplyQuantity ?? 0);
}

/**
 * Stok ledger canonical untuk satu InventorySupplyItem kategori PACKAGING
 * (dual-read compatibility):
 *   • ledger lama → melalui Packaging.supplyItemId mapping (packagingId, tanpa
 *     supplyItemId — mencegah double-count bila baris langgar XOR);
 *   • ledger baru → supplyItemId langsung.
 * Tanpa double-count: baris legacy hanya dihitung lewat jalur packagingId,
 * baris baru hanya lewat supplyItemId.
 */
export async function getSupplyItemLedgerStock(
  client: SupplyDb,
  tenantId: string,
  supplyItemId: string,
): Promise<number> {
  const item = await client.inventorySupplyItem.findUnique({
    where: { id: supplyItemId },
    select: { packaging: { select: { id: true } } },
  });

  let total = 0;
  if (item?.packaging?.id) {
    total += await packagingLedgerBalance(client, tenantId, item.packaging.id);
  }
  total += await supplyLedgerBalance(client, tenantId, supplyItemId);
  return total;
}

/**
 * Batch: stok ledger untuk semua supply item dalam satu tenant.
 * Kembalikan Map<supplyItemId, { legacy, supply, total }>.
 */
export async function getTenantSupplyLedgerStocks(
  client: SupplyDb,
  tenantId: string,
): Promise<Map<string, { legacy: number; supply: number; total: number }>> {
  const [items, legacyRows, supplyRows] = await Promise.all([
    client.inventorySupplyItem.findMany({
      where: { tenantId },
      select: { id: true, packaging: { select: { id: true } } },
    }),
    client.inventoryLedger.groupBy({
      by: ["packagingId", "entryType"],
      where: { tenantId, packagingId: { not: null }, supplyItemId: null },
      _sum: { quantityUnit: true },
      _count: { _all: true },
    }),
    client.inventoryLedger.groupBy({
      by: ["supplyItemId", "entryType"],
      where: { tenantId, supplyItemId: { not: null } },
      _sum: { supplyQuantity: true },
      _count: { _all: true },
    }),
  ]);

  const legacyByPackaging = new Map<string, number>();
  for (const row of legacyRows) {
    const balance =
      row.entryType === "IN"
        ? Number(row._sum.quantityUnit ?? 0)
        : -Number(row._sum.quantityUnit ?? 0);
    legacyByPackaging.set(
      row.packagingId!,
      (legacyByPackaging.get(row.packagingId!) ?? 0) + balance,
    );
  }
  const supplyByItem = new Map<string, number>();
  for (const row of supplyRows) {
    const balance =
      row.entryType === "IN"
        ? Number(row._sum.supplyQuantity ?? 0)
        : -Number(row._sum.supplyQuantity ?? 0);
    supplyByItem.set(
      row.supplyItemId!,
      (supplyByItem.get(row.supplyItemId!) ?? 0) + balance,
    );
  }

  const map = new Map<string, { legacy: number; supply: number; total: number }>();
  for (const item of items) {
    const legacy = item.packaging?.id ? legacyByPackaging.get(item.packaging.id) ?? 0 : 0;
    const supply = supplyByItem.get(item.id) ?? 0;
    map.set(item.id, { legacy, supply, total: legacy + supply });
  }
  return map;
}