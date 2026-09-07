import { Prisma } from "@prisma/client";

import { requireTenantPrisma } from "./auth";

// Use a flexible type that works with both base and tenant-scoped Prisma clients
 
type TransactionClient = any;

// Prisma Decimal is accepted as number | string for convenience
 
type FlexibleNumber = number | string | { toNumber(): number } | null | undefined;

export interface LedgerEntryData {
  tenantId?: string;
  productId?: string | null;
  packagingId?: string | null;
  supplyItemId?: string | null;
  entryType: "IN" | "OUT";
  quantityUnit?: FlexibleNumber;
  quantityKg?: FlexibleNumber;
  supplyQuantity?: FlexibleNumber;
  incomingPrice?: FlexibleNumber;
  reversalOfLedgerId?: string | null;
  lotNumber?: string | null;
  expiryDate?: Date | string | null;
  reference?: string;
  notes?: string;
  [key: string]: unknown;
}

type FefoLedgerEntryData = Omit<
  LedgerEntryData,
  "entryType" | "incomingPrice" | "lotNumber" | "expiryDate" | "lotId"
> & {
  tenantId: string;
};

type FefoLot = {
  id: string;
  batchCode: string;
  expiryDate: Date | null;
  quantityKg: FlexibleNumber;
  quantityUnit: FlexibleNumber;
  supplyQuantity: FlexibleNumber;
};

type PlacementQuantityField = "quantityKg" | "quantityUnit" | "supplyQty";

/**
 * Keep Smart Storage's physical dimension in lockstep with a canonical lot
 * consumption. Lots can remain partially or wholly unplaced for historical
 * stock, so this only depletes quantities that are actually placed.
 *
 * Placements at system locations (isSystem = true, e.g. SYS-ROASTING-WIP)
 * are lifecycle-controlled and are never depleted by ordinary FEFO
 * consumption — only the roast lifecycle consumes them.
 */
async function consumeLotPlacements(
  tx: TransactionClient,
  tenantId: string,
  lotId: string,
  field: PlacementQuantityField,
  quantity: number,
) {
  if (quantity <= 0) return;

  const placements = await tx.lotPlacement.findMany({
    where: {
      tenantId,
      lotId,
      location: { isSystem: false },
      [field]: { gt: 0 },
    },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, quantityKg: true, quantityUnit: true, supplyQty: true },
  });

  let remaining = quantity;
  const epsilon = field === "quantityUnit" ? 0 : 0.000001;
  for (const placement of placements) {
    if (remaining <= epsilon) break;
    const available = Number(placement[field] ?? 0);
    if (available <= epsilon) continue;

    const consumed = Math.min(remaining, available);
    const result = await tx.lotPlacement.updateMany({
      where: { id: placement.id, tenantId, [field]: { gte: consumed } },
      data: { [field]: { decrement: consumed } },
    });
    if (result.count !== 1) {
      throw new Error("Stok lokasi berubah saat alokasi lot. Coba ulangi transaksi.");
    }
    remaining -= consumed;
  }
}

/**
 * Hitung stok kopi (kg) untuk satu product dari agregasi InventoryLedger.
 * Digunakan oleh roasting & produksi untuk validasi stok sebelum transaksi.
 */
export async function computeKgStock(productId: string): Promise<number> {
  const prisma = await requireTenantPrisma();
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockKg: true },
  });
  return Number(product?.stockKg ?? 0);
}

/**
 * Hitung stok unit (pcs) untuk satu packaging dari agregasi InventoryLedger.
 */
export async function computeUnitStock(packagingId: string): Promise<number> {
  const prisma = await requireTenantPrisma();
  const packaging = await prisma.packaging.findUnique({
    where: { id: packagingId },
    select: { stockUnit: true },
  });
  return packaging?.stockUnit ?? 0;
}

/**
 * Hitung stok unit (pcs) untuk satu Finished Goods product dari agregasi InventoryLedger.
 * FG tracking menggunakan productId + quantityUnit (berbeda dari computeKgStock yang pakai quantityKg).
 */
export async function computeFGUnitStock(productId: string): Promise<number> {
  const prisma = await requireTenantPrisma();
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockUnit: true },
  });
  return product?.stockUnit ?? 0;
}

/**
 * Buat entri InventoryLedger baru dan otomatis update cache stock di Product/
 * Packaging/InventorySupplyItem. Harus dijalankan di dalam transaksi (tx).
 *
 * Invariant write baru (XOR-3): tepat satu dari productId | packagingId | supplyItemId.
 * Subject supply memakai supplyQuantity (baseUnit item, pecahan); quantityKg dan
 * quantityUnit harus null. Cache supply (stockQuantity + avgCostPerUnit) hanya
 * di-update di sini; Packaging.stockUnit/avgCostPerUnit tidak disentuh oleh
 * flow supply baru.
 */
export async function appendLedger(tx: TransactionClient, data: LedgerEntryData | { data: LedgerEntryData }) {
  const payload = ("data" in data ? data.data : data) as LedgerEntryData;
  const quantityUnit = Number(payload.quantityUnit ?? 0);
  const quantityKg = Number(payload.quantityKg ?? 0);
  const supplyQuantity = Number(payload.supplyQuantity ?? 0);

  const subjectCount = [payload.productId, payload.packagingId, payload.supplyItemId]
    .filter((v) => v != null && v !== "").length;
  if (subjectCount !== 1) {
    throw new Error("Ledger entry must target exactly one product, packaging, or supply item.");
  }
  const isSupply = payload.supplyItemId != null && payload.supplyItemId !== "";

  if (isSupply) {
    if (!Number.isFinite(supplyQuantity) || supplyQuantity <= 0) {
      throw new Error("Supply quantity must be a positive number.");
    }
    if (quantityKg !== 0 || quantityUnit !== 0) {
      throw new Error("Supply ledger entries must not use quantityKg or quantityUnit.");
    }
  } else if (quantityUnit < 0 || quantityKg < 0 || (quantityUnit === 0 && quantityKg === 0)) {
    throw new Error("Ledger quantity must be greater than zero.");
  }

  const isInbound = payload.entryType === "IN";
  if (!isInbound && payload.entryType !== "OUT") {
    throw new Error("Ledger entry type must be IN or OUT.");
  }

  // Calculate moving average cost if incomingPrice is provided
  let newAvgCostKg: number | undefined;
  let newAvgCostUnit: number | undefined;
  let newAvgCostSupply: number | undefined;
  let newLastHppUnit: number | undefined;
  if (isInbound && payload.incomingPrice !== undefined) {
    const incPrice = Number(payload.incomingPrice);
    if (payload.productId) {
      // The cache read and WAC write must serialize across concurrent receipts.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products" WHERE "id" = ${payload.productId} FOR UPDATE`);
      const product = await tx.product.findUnique({
        where: { id: payload.productId },
        select: { stockKg: true, stockUnit: true, avgCostPerKg: true, lastHpp: true },
      });
      if (product && quantityKg > 0) {
        const oldStock = Number(product.stockKg);
        const oldAvg = Number(product.avgCostPerKg ?? 0);
        newAvgCostKg = (oldStock * oldAvg + quantityKg * incPrice) / (oldStock + quantityKg);
      }
      if (product && quantityUnit > 0) {
        // FG unit cost is NOT tracked via moving average on avgCostPerKg.
        // FG cost comes from lastHpp (set by production batches).
        // AVOID: writing newAvgCostUnit to avgCostPerKg — that corrupts the kg cost.
        const oldUnit = Number(product.stockUnit ?? 0);
        const oldHpp = Number(product.lastHpp ?? 0);
        newLastHppUnit = (oldUnit * oldHpp + quantityUnit * incPrice) / (oldUnit + quantityUnit);
      }
    } else if (payload.packagingId) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "packagings" WHERE "id" = ${payload.packagingId} FOR UPDATE`);
      const pkg = await tx.packaging.findUnique({
        where: { id: payload.packagingId },
        select: { stockUnit: true, avgCostPerUnit: true },
      });
      if (pkg && quantityUnit > 0) {
        const oldStock = Number(pkg.stockUnit);
        const oldAvg = Number(pkg.avgCostPerUnit ?? 0);
        newAvgCostUnit = (oldStock * oldAvg + quantityUnit * incPrice) / (oldStock + quantityUnit);
      }
    } else if (isSupply) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inventory_supply_items" WHERE "id" = ${payload.supplyItemId} FOR UPDATE`);
      const item = await tx.inventorySupplyItem.findUnique({
        where: { id: payload.supplyItemId },
        select: { tenantId: true, stockQuantity: true, avgCostPerUnit: true },
      });
      if (item && supplyQuantity > 0) {
        const oldStock = Number(item.stockQuantity);
        const oldAvg = Number(item.avgCostPerUnit ?? 0);
        newAvgCostSupply = (oldStock * oldAvg + supplyQuantity * incPrice) / (oldStock + supplyQuantity);
      }
    }
  }

  if (payload.productId) {
    if (quantityUnit > 0) {
      const result = await tx.product.updateMany({
        where: {
          id: payload.productId,
          ...(isInbound ? {} : { stockUnit: { gte: quantityUnit } }),
        },
        data: {
          stockUnit: isInbound
            ? { increment: quantityUnit }
            : { decrement: quantityUnit },
          ...(newLastHppUnit !== undefined ? { lastHpp: newLastHppUnit } : {}),
        },
      });
      if (result.count !== 1) {
        throw new Error("Stok produk tidak cukup untuk menyelesaikan transaksi.");
      }
    }

    if (quantityKg > 0) {
      // Canonical availability for ordinary outbound stock: committed roast
      // material (ACTIVE/CHARGED reservations) is lifecycle-controlled and
      // must not be consumable by user-driven flows — canonical stockKg stays
      // unchanged at charge. The lifecycle's own completion (GB_OUT with
      // refId = parentBatchId) excludes its own reservation so roast
      // semantics are preserved.
      let committedKg = 0;
      if (!isInbound && payload.tenantId) {
        const committed = await tx.roastMaterialReservation.aggregate({
          _sum: { quantityKg: true },
          where: {
            tenantId: payload.tenantId,
            status: { in: ["ACTIVE", "CHARGED"] },
            ...(payload.refId
              ? { parentBatchId: { not: payload.refId } }
              : {}),
            lot: { productId: payload.productId },
          },
        });
        committedKg = Number(committed._sum.quantityKg ?? 0);
      }
      const result = await tx.product.updateMany({
        where: {
          id: payload.productId,
          ...(isInbound ? {} : { stockKg: { gte: quantityKg + committedKg } }),
        },
        data: {
          stockKg: isInbound
            ? { increment: quantityKg }
            : { decrement: quantityKg },
          ...(newAvgCostKg !== undefined ? { avgCostPerKg: newAvgCostKg } : {}),
        },
      });
      if (result.count !== 1) {
        throw new Error(
          committedKg > 0
            ? `Stok kopi tidak cukup untuk menyelesaikan transaksi (${committedKg.toFixed(3)} kg sedang dicadangkan untuk roasting).`
            : "Stok kopi tidak cukup untuk menyelesaikan transaksi.",
        );
      }
    }
  } else if (payload.packagingId) {
    const result = await tx.packaging.updateMany({
      where: {
        id: payload.packagingId,
        ...(isInbound ? {} : { stockUnit: { gte: quantityUnit } }),
      },
      data: {
        stockUnit: isInbound
          ? { increment: quantityUnit }
          : { decrement: quantityUnit },
        ...(newAvgCostUnit !== undefined ? { avgCostPerUnit: newAvgCostUnit } : {}),
      },
    });
    if (result.count !== 1) {
      throw new Error("Stok kemasan tidak cukup untuk menyelesaikan transaksi.");
    }
  } else {
    const result = await tx.inventorySupplyItem.updateMany({
      where: {
        id: payload.supplyItemId,
        tenantId: payload.tenantId,
        ...(isInbound ? {} : { stockQuantity: { gte: supplyQuantity } }),
      },
      data: {
        stockQuantity: isInbound
          ? { increment: supplyQuantity }
          : { decrement: supplyQuantity },
        ...(newAvgCostSupply !== undefined ? { avgCostPerUnit: newAvgCostSupply } : {}),
      },
    });
    if (result.count !== 1) {
      throw new Error("Stok supply tidak cukup untuk menyelesaikan transaksi.");
    }
  }

  const dataToSave = { ...payload };

  return tx.inventoryLedger.create({ data: dataToSave });
}

/**
 * Phase 2D.2A — Recompute WAC sebuah produk terhadap ledger EFEKTIF setelah
 * transaksi di-void. Stream kg → avgCostPerKg; stream unit → lastHpp.
 *
 * Ledger efektif = row asli (bukan reversal) yang:
 *   • refType-nya bukan VOID_REVERSAL,
 *   • reversalOfLedgerId NULL, dan
 *   • refId-nya tidak memiliki row VOID_REVERSAL (transaksi voided all-or-nothing).
 *
 * Basis harga lengkap (semua row IN efektif punya incomingPrice) → full replay
 * eksak dari nol. Basis tidak lengkap (row legacy pra-migrasi) → candidate
 * snapshot (Q·a − q·p)/(Q − q) hanya bila seluruh originalRows berharga; jika
 * tidak → cache dibiarkan (hutang akurasi legacy, tercatat di report 2D.2A).
 */
export async function recomputeProductCostInTx(
  tx: TransactionClient,
  opts: {
    tenantId: string;
    productId: string;
    voidedRefId: string;
    originalRows: Array<{
      quantityKg: FlexibleNumber;
      quantityUnit: FlexibleNumber;
      incomingPrice: FlexibleNumber;
      entryType?: "IN" | "OUT";
    }>;
  },
): Promise<void> {
  const { tenantId, productId, originalRows } = opts;

  const originalInKg = originalRows
    .filter((row) => (row.entryType ?? "IN") === "IN")
    .reduce((sum, row) => sum + Number(row.quantityKg ?? 0), 0);
  const originalInUnit = originalRows
    .filter((row) => (row.entryType ?? "IN") === "IN")
    .reduce((sum, row) => sum + Number(row.quantityUnit ?? 0), 0);
  const isKgStream = originalInKg > 0 && originalInUnit === 0;
  const voidedQty = isKgStream ? originalInKg : originalInUnit;
  if (voidedQty <= 0) return;

  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { stockKg: true, stockUnit: true, avgCostPerKg: true, lastHpp: true },
  });
  if (!product) return;

  const rows: Array<{
    refId: string;
    refType: string;
    entryType: string;
    quantityKg: FlexibleNumber;
    quantityUnit: FlexibleNumber;
    incomingPrice: FlexibleNumber;
    reversalOfLedgerId: string | null;
  }> = await tx.inventoryLedger.findMany({
    where: { tenantId, productId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      refId: true,
      refType: true,
      entryType: true,
      quantityKg: true,
      quantityUnit: true,
      incomingPrice: true,
      reversalOfLedgerId: true,
    },
  });

  const voidedRefIds = new Set<string>();
  for (const row of rows) {
    if (row.refType === "VOID_REVERSAL") voidedRefIds.add(row.refId);
  }

  const effective = rows.filter(
    (row) =>
      row.refType !== "VOID_REVERSAL" &&
      row.reversalOfLedgerId == null &&
      !voidedRefIds.has(row.refId),
  );

  const streamRows = effective.filter((row) =>
    isKgStream ? Number(row.quantityKg ?? 0) > 0 : Number(row.quantityUnit ?? 0) > 0,
  );

  const inRows = streamRows.filter((row) => row.entryType === "IN");
  const pricedInCount = inRows.filter((row) => row.incomingPrice != null).length;
  const currentStock = isKgStream
    ? Number(product.stockKg ?? 0)
    : Number(product.stockUnit ?? 0);

  const writeCost = async (avg: number) => {
    await tx.product.update({
      where: { id: productId },
      data: isKgStream ? { avgCostPerKg: avg } : { lastHpp: avg },
    });
  };

  const candidateSnapshot = async (): Promise<boolean> => {
    const inOriginalRows = originalRows.filter((row) => (row.entryType ?? "IN") === "IN");
    const allPriced = inOriginalRows.every(
      (row) => row.incomingPrice != null && Number(row.incomingPrice) >= 0,
    );
    if (!allPriced) return false;
    if (currentStock <= (isKgStream ? 1e-6 : 0)) {
      await writeCost(0);
      return true;
    }
    const currentAvg = isKgStream
      ? Number(product.avgCostPerKg ?? 0)
      : Number(product.lastHpp ?? 0);
    const voidedValue = inOriginalRows.reduce((sum, row) => {
      const quantity = isKgStream ? Number(row.quantityKg ?? 0) : Number(row.quantityUnit ?? 0);
      return sum + quantity * Number(row.incomingPrice);
    }, 0);
    // currentStock sudah merupakan stok SETELAH reversal OUT terhadap IN yang
    // di-void. Rekonstruksi basis sebelum void dengan menambahkan kembali q,
    // lalu keluarkan nilai transaksi yang di-void tepat satu kali.
    const preVoidStock = currentStock + voidedQty;
    const restored = (preVoidStock * currentAvg - voidedValue) / currentStock;
    await writeCost(restored);
    return true;
  };

  if (inRows.length === 0) {
    // Seluruh basis IN produk ini ikut ter-void (mis. batch eksperimen tunggal).
    if (currentStock <= (isKgStream ? 1e-6 : 0)) await writeCost(0);
    return;
  }

  if (pricedInCount === inRows.length) {
    let qty = 0;
    let avg = 0;
    for (const row of streamRows) {
      const q = isKgStream ? Number(row.quantityKg) : Number(row.quantityUnit);
      if (row.entryType === "IN") {
        const price = Number(row.incomingPrice);
        avg = qty + q > 0 ? (avg * qty + q * price) / (qty + q) : price;
        qty += q;
      } else {
        qty -= q;
      }
    }
    const tolerance = isKgStream ? 1e-6 : 0;
    if (Math.abs(qty - currentStock) > tolerance) {
      await candidateSnapshot();
      return;
    }
    await writeCost(avg);
    return;
  }

  await candidateSnapshot();
}

/**
 * Phase 2D.2A — Recompute WAC untuk InventorySupplyItem setelah transaksi di-void.
 * Mirip recomputeProductCostInTx tapi untuk supply item (supplyQuantity stream).
 */
export async function recomputeSupplyCostInTx(
  tx: TransactionClient,
  opts: {
    tenantId: string;
    supplyItemId: string;
    voidedRefId: string;
    originalRows: Array<{
      supplyQuantity: FlexibleNumber;
      incomingPrice: FlexibleNumber;
      entryType?: "IN" | "OUT";
    }>;
  },
): Promise<void> {
  const { tenantId, supplyItemId, originalRows } = opts;

  const originalInQty = originalRows
    .filter((row) => (row.entryType ?? "IN") === "IN")
    .reduce((sum, row) => sum + Number(row.supplyQuantity ?? 0), 0);
  if (originalInQty <= 0) return;

  const item = await tx.inventorySupplyItem.findUnique({
    where: { id: supplyItemId },
    select: { stockQuantity: true, avgCostPerUnit: true },
  });
  if (!item) return;

  const rows: Array<{
    refId: string;
    refType: string;
    entryType: string;
    supplyQuantity: FlexibleNumber;
    incomingPrice: FlexibleNumber;
    reversalOfLedgerId: string | null;
  }> = await tx.inventoryLedger.findMany({
    where: { tenantId, supplyItemId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      refId: true,
      refType: true,
      entryType: true,
      supplyQuantity: true,
      incomingPrice: true,
      reversalOfLedgerId: true,
    },
  });

  const voidedRefIds = new Set<string>();
  for (const row of rows) {
    if (row.refType === "VOID_REVERSAL") voidedRefIds.add(row.refId);
  }

  const effective = rows.filter(
    (row) =>
      row.refType !== "VOID_REVERSAL" &&
      row.reversalOfLedgerId == null &&
      !voidedRefIds.has(row.refId),
  );

  const streamRows = effective.filter((row) => Number(row.supplyQuantity ?? 0) > 0);

  const inRows = streamRows.filter((row) => row.entryType === "IN");
  const pricedInCount = inRows.filter((row) => row.incomingPrice != null).length;
  const currentStock = Number(item.stockQuantity ?? 0);

  const writeCost = async (avg: number) => {
    await tx.inventorySupplyItem.update({
      where: { id: supplyItemId },
      data: { avgCostPerUnit: avg },
    });
  };

  const candidateSnapshot = async (): Promise<boolean> => {
    const inOriginalRows = originalRows.filter((row) => (row.entryType ?? "IN") === "IN");
    const allPriced = inOriginalRows.every(
      (row) => row.incomingPrice != null && Number(row.incomingPrice) >= 0,
    );
    if (!allPriced) return false;
    if (currentStock <= 1e-6) {
      await writeCost(0);
      return true;
    }
    const currentAvg = Number(item.avgCostPerUnit ?? 0);
    const voidedValue = inOriginalRows.reduce((sum, row) => {
      const quantity = Number(row.supplyQuantity ?? 0);
      return sum + quantity * Number(row.incomingPrice);
    }, 0);
    const preVoidStock = currentStock + originalInQty;
    const restored = (preVoidStock * currentAvg - voidedValue) / currentStock;
    await writeCost(restored);
    return true;
  };

  if (inRows.length === 0) {
    if (currentStock <= 1e-6) await writeCost(0);
    return;
  }

  if (pricedInCount === inRows.length) {
    let qty = 0;
    let avg = 0;
    for (const row of streamRows) {
      const q = Number(row.supplyQuantity);
      if (row.entryType === "IN") {
        const price = Number(row.incomingPrice);
        avg = qty + q > 0 ? (avg * qty + q * price) / (qty + q) : price;
        qty += q;
      } else {
        qty -= q;
      }
    }
    if (Math.abs(qty - currentStock) > 1e-6) {
      await candidateSnapshot();
      return;
    }
    await writeCost(avg);
    return;
  }

  await candidateSnapshot();
}

/**
 * Keluarkan stok berdasarkan FEFO (expiry paling dekat, lalu lot paling lama).
 *
 * Stok historis yang dibuat sebelum fitur lot tetap dapat dipakai: jika jumlah
 * pada lot tidak menutup kebutuhan, sisanya dicatat tanpa lot. Dengan begitu
 * rollout traceability tidak memblokir operasi tenant lama, sementara semua
 * stok baru tetap memiliki jejak lot yang lengkap.
 *
 * Lot rows dikunci dengan SELECT ... FOR UPDATE sebelum alokasi, mencegah
 * dua transaksi paralel mengalokasikan quantity dari lot yang sama.
 */
export async function appendFefoLedgerOut(tx: TransactionClient, data: FefoLedgerEntryData) {
    const quantityKg = Number(data.quantityKg ?? 0);
    const quantityUnit = Number(data.quantityUnit ?? 0);
    const supplyQuantity = Number(data.supplyQuantity ?? 0);
    const isSupply = data.supplyItemId != null && data.supplyItemId !== "";
    const requestedQuantity = isSupply ? supplyQuantity : (quantityKg > 0 ? quantityKg : quantityUnit);
    const quantityField = isSupply ? "supplyQuantity" : (quantityKg > 0 ? "quantityKg" : "quantityUnit");

    if (!data.tenantId) {
      throw new Error("Tenant wajib diisi untuk alokasi FEFO.");
    }
    const subjectCount = [data.productId, data.packagingId, data.supplyItemId]
      .filter((v) => v != null && v !== "").length;
    if (subjectCount !== 1) {
      throw new Error("FEFO entry must target exactly one product, packaging, or supply item.");
    }
    if (requestedQuantity <= 0 || (isSupply ? (quantityKg > 0 || quantityUnit > 0) : (quantityKg > 0 && quantityUnit > 0))) {
      throw new Error("FEFO quantity must use exactly one positive unit.");
    }

    const lockedLotIds: { id: string }[] = await tx.$queryRaw`
      SELECT l."id" FROM "lots" l
      WHERE l."tenantId" = ${data.tenantId}
        AND l."productId" IS NOT DISTINCT FROM ${data.productId}
        AND l."packagingId" IS NOT DISTINCT FROM ${data.packagingId}
        AND l."supplyItemId" IS NOT DISTINCT FROM ${data.supplyItemId}
        AND l."consumedAt" IS NULL
        -- Lot berstatus HOLD sedang dikarantina QC: jangan dialokasikan.
        AND l."qcStatus" <> 'HOLD'
      ORDER BY l."expiryDate" ASC NULLS LAST, l."receivedAt" ASC, l."createdAt" ASC
      FOR UPDATE
    `;

    let lots: FefoLot[];
    if (lockedLotIds.length > 0) {
      lots = await tx.lot.findMany({
        where: {
          id: { in: lockedLotIds.map((r) => r.id) },
          tenantId: data.tenantId,
          productId: data.productId ?? undefined,
          packagingId: data.packagingId ?? undefined,
          supplyItemId: data.supplyItemId ?? undefined,
          consumedAt: null,
          qcStatus: { not: "HOLD" },
        },
        orderBy: [
          { expiryDate: { sort: "asc", nulls: "last" } },
          { receivedAt: "asc" },
          { createdAt: "asc" },
        ],
        select: {
          id: true,
          batchCode: true,
          expiryDate: true,
          quantityKg: true,
          quantityUnit: true,
          supplyQuantity: true,
        },
      });
    } else {
      lots = [];
    }

    // Saldo ledger per lot dihitung dengan SATU groupBy (±2 baris per lot)
    // alih-alih memuat seluruh riwayat ledger tiap lot ke JS. Pertahankan
    // aturan lama: baris reversal tidak ikut menentukan saldo FEFO.
    const ledgerAgg = new Map<string, { count: number; inQty: number; outQty: number }>();
    if (lots.length > 0) {
      const grouped = await tx.inventoryLedger.groupBy({
        by: ["lotId", "entryType"],
        where: {
          tenantId: data.tenantId,
          lotId: { in: lots.map((lot) => lot.id) },
          NOT: [
            { refType: "VOID_REVERSAL" },
            { reversalOfLedgerId: { not: null } },
          ],
        },
        _sum: { quantityKg: true, quantityUnit: true, supplyQuantity: true },
        _count: { _all: true },
      });
      for (const row of grouped) {
        const lotId = row.lotId as string;
        let agg = ledgerAgg.get(lotId);
        if (!agg) {
          agg = { count: 0, inQty: 0, outQty: 0 };
          ledgerAgg.set(lotId, agg);
        }
        agg.count += row._count._all;
        const amount = Number(row._sum[quantityField] ?? 0);
        if (row.entryType === "IN") {
          agg.inQty += amount;
        } else {
          agg.outQty += amount;
        }
      }
    }

    let remaining = requestedQuantity;
    const entries = [];
    const epsilon = quantityField === "quantityUnit" ? 0 : 0.000001;

    for (const lot of lots) {
      if (remaining <= epsilon) break;

      const originalQuantity = Number(lot[quantityField] ?? 0);
      const agg = ledgerAgg.get(lot.id);
      const available = Math.max(
        0,
        agg && agg.count > 0 ? agg.inQty - agg.outQty : originalQuantity,
      );
      if (available <= epsilon) continue;

      const allocated = Math.min(remaining, available);
      const entry = await appendLedger(tx, {
        ...data,
        entryType: "OUT",
        [quantityField]: allocated,
        lotId: lot.id,
        lotNumber: lot.batchCode,
        expiryDate: lot.expiryDate,
      });
      entries.push(entry);

      const placementField: PlacementQuantityField = isSupply
        ? "supplyQty"
        : quantityKg > 0 ? "quantityKg" : "quantityUnit";
      await consumeLotPlacements(
        tx,
        data.tenantId,
        lot.id,
        placementField,
        allocated,
      );
      remaining -= allocated;

      if (available - allocated <= epsilon) {
        await tx.lot.update({
          where: { id: lot.id },
          data: { consumedAt: new Date() },
        });
      }
    }

    if (remaining > epsilon) {
      entries.push(
        await appendLedger(tx, {
          ...data,
          entryType: "OUT",
          [quantityField]: remaining,
          lotId: null,
          lotNumber: null,
          expiryDate: null,
        }),
      );
    }

    return entries;
  }
