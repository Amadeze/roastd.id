"use server";

import { appendLedger } from "@/lib/stock";
import { adjustSupplyStock } from "@/lib/supply-adjustment";
import { getCurrentTenantId, getSystemUserId, requireRole, requireTenantPrisma } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import {
  resolvePurchasePaymentFromAmount,
  type PurchasePaymentState,
} from "@/lib/purchase-payments";
import { getBatchReorderSummaries } from "@/lib/reorder";
import { postPurchase, postStockAdjustment } from "@/lib/posting";
import { summarizeLotInventory, summarizeSupplyLotInventory, type LotOperationalStatus } from "@/lib/lot";
import { createSupplyPurchase, type CreateSupplyPurchaseInput } from "@/lib/supply-purchase";
import { createLotPlacementInTx } from "@/lib/storage-location";
import { normalizeCoffeeIdentity } from "@/lib/coffee-identity";
import type {
  ProductStockRow,
  PackagingStockRow,
  SupplyStockRow,
  FGStockRow,
  ProductLotRow,
  SupplyLotRow,
  SupplierOption,
  GBProductOption,
  RBProductOption,
  CoffeeSourceOption,
  NewCoffeeSourceInput,
  InventoryPageData,
  SampleConsumptionSummary,
  LedgerHistoryRow,
  PurchaseActionInput,
  RoastedBeanPurchaseInput,
  PackagingPurchaseInput,
  ActionResult,
  SUPPLY_CATEGORY_LABEL,
} from "./types";

// =============================================================================
// HELPERS
// =============================================================================


/** Generate kode Purchase: PUR-YYYYMM-NNN */
function generatePurchaseCode(receivedAt = new Date()): string {
  const prefix = `PUR-${receivedAt.getFullYear()}${String(receivedAt.getMonth() + 1).padStart(2, "0")}`;
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** Generate kode Product untuk Green Bean baru: GB-SLUG */
function generateProductCode(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12);
  return `GB-${slug || "BARU"}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** Generate kode Product untuk Roasted Bean baru: RB-SLUG */
function generateRBCode(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12);
  return `RB-${slug || "BARU"}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

const ROAST_LEVELS = new Set(["LIGHT", "MEDIUM", "MEDIUM_DARK", "DARK"]);

type TransactionClient = any;

/** Generate kode CoffeeSource inline: CS-SLUG-RANDOM */
function generateSourceCode(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12);
  return `CS-${slug || "BARU"}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Resolusi CoffeeSource untuk Roasted Bean beli jadi: wajib tepat satu dari
 * (a) coffeeSourceId → sumber eksisting yang aktif, atau
 * (b) coffeeSource → dibuat inline (atomik di dalam transaksi pemanggil).
 * Selalu mengembalikan sumber yang sudah tersimpan; melempar jika tidak valid.
 */
async function resolveRoastedBeanSource(
  tx: TransactionClient,
  tenantId: string,
  sourceInput: { coffeeSourceId?: string; coffeeSource?: NewCoffeeSourceInput },
): Promise<{ id: string; name: string; species: string | null; region: string | null }> {
  const hasExisting = !!sourceInput.coffeeSourceId?.trim();
  const hasInline = !!sourceInput.coffeeSource?.name?.trim();
  if (hasExisting === hasInline) {
    throw new Error("Pilih sumber kopi yang sudah ada atau isi nama sumber kopi baru.");
  }
  if (hasExisting) {
    const source = await tx.coffeeSource.findFirst({
      where: { id: sourceInput.coffeeSourceId, isActive: true },
      select: { id: true, name: true, species: true, region: true },
    });
    if (!source) throw new Error("Sumber kopi tidak ditemukan atau sudah nonaktif.");
    return source;
  }
  const identity = normalizeCoffeeIdentity(sourceInput.coffeeSource!);
  if (!identity.name) throw new Error("Nama sumber kopi harus diisi.");
  // Sumber inline SELALU dibuat baru: reuse hanya lewat coffeeSourceId yang
  // dipilih eksplisit oleh pengguna, tidak pernah lewat kesamaan nama.
  const source = await tx.coffeeSource.create({
    data: {
      tenantId,
      code: generateSourceCode(identity.name),
      name: identity.name,
      country: identity.country,
      region: identity.region,
      farm: identity.farm,
      species: identity.species,
      varietal: identity.varietal,
      processMethod: identity.processMethod,
      fermentationMethod: identity.fermentationMethod,
      elevation: identity.elevation,
      cropYear: identity.cropYear,
      certifications: identity.certifications,
      tastingNotes: identity.tastingNotes,
      isActive: true,
    },
    select: { id: true, name: true, species: true, region: true },
  });
  return source;
}

// =============================================================================
// QUERIES
// =============================================================================

async function fetchProductStocks(
  type: "GREEN_BEAN" | "ROASTED_BEAN"
): Promise<ProductStockRow[]> {
  const products = await (await requireTenantPrisma()).product.findMany({
    where: { type, isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      origin: true,
      roastLevel: true,
      materialOrigin: true,
      coffeeSourceId: true,
      stockKg: true,
      avgCostPerKg: true,
    },
    orderBy: { name: "asc" },
  });

  return products.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    type: p.type as "GREEN_BEAN" | "ROASTED_BEAN",
    origin: p.origin,
    roastLevel: p.roastLevel,
    materialOrigin: p.materialOrigin,
    coffeeSourceId: p.coffeeSourceId,
    stockKg: Number(p.stockKg),
    latestHppPerKg: p.avgCostPerKg ? Number(p.avgCostPerKg) : null,
  }));
}

async function fetchSupplyStocks(): Promise<SupplyStockRow[]> {
  const items = await (await requireTenantPrisma()).inventorySupplyItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      category: true,
      baseUnit: true,
      stockQuantity: true,
      avgCostPerUnit: true,
      costPerUnit: true,
      trackLot: true,
      packaging: { select: { weightGrams: true } },
    },
    orderBy: { name: "asc" },
  });

  return items.map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    baseUnit: item.baseUnit.toLowerCase(),
    stockUnit: Number(item.stockQuantity),
    costPerUnit: Number(item.avgCostPerUnit ?? item.costPerUnit ?? 0),
    trackLot: item.trackLot,
    weightGrams: item.packaging ? Number(item.packaging.weightGrams) : null,
  }));
}

function parsePurchaseDueDate(status: PurchasePaymentState, dueDate: string | undefined, receivedAt: Date) {
  if (status === "PAID") return null;
  const parsed = dueDate ? new Date(`${dueDate}T23:59:59`) : new Date(receivedAt);
  if (!dueDate) parsed.setDate(parsed.getDate() + 14);
  if (Number.isNaN(parsed.getTime())) throw new Error("Tanggal jatuh tempo tidak valid.");
  return parsed;
}

function generateSupplierPaymentCode(paidAt: Date) {
  const prefix = `SPAY-${paidAt.getFullYear()}${String(paidAt.getMonth() + 1).padStart(2, "0")}`;
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function fetchFGStocks(): Promise<FGStockRow[]> {
  const products = await (await requireTenantPrisma()).product.findMany({
    where: { type: "FINISHED_GOODS", isActive: true },
    include: {
      productionBatches: {
        where: { status: "COMPLETED" },
        orderBy: { producedAt: "desc" },
        take: 1,
        select: { hppPerUnit: true },
      },
    },
    orderBy: { name: "asc" },
  });

  return products.map((p) => {
    const latestHppPerUnit = p.productionBatches[0] 
      ? Number(p.productionBatches[0].hppPerUnit) 
      : null;

    return {
      id: p.id,
      code: p.code,
      name: p.name,
      type: "FINISHED_GOODS",
      stockUnit: p.stockUnit,
      latestHppPerUnit,
    };
  });
}

async function fetchLedgerHistory(): Promise<LedgerHistoryRow[]> {
  const entries = await (await requireTenantPrisma()).inventoryLedger.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      createdAt: true,
      entryType: true,
      refType: true,
      refId: true,
      quantityKg: true,
      quantityUnit: true,
      notes: true,
      product: { select: { code: true, name: true } },
      packaging: { select: { code: true, name: true } },
      createdBy: { select: { name: true } },
    },
  });

  return entries.map((entry) => {
    const usesKg = entry.quantityKg !== null;
    return {
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
      itemName: entry.product?.name ?? entry.packaging?.name ?? "Item dihapus",
      itemCode: entry.product?.code ?? entry.packaging?.code ?? "-",
      itemType: entry.product ? "PRODUCT" : "PACKAGING",
      entryType: entry.entryType,
      refType: entry.refType,
      refId: entry.refId,
      quantity: usesKg ? Number(entry.quantityKg) : Number(entry.quantityUnit ?? 0),
      unit: usesKg ? "kg" : "unit",
      notes: entry.notes,
      createdByName: entry.createdBy.name,
    };
  });
}

// =============================================================================
// PUBLIC SERVER ACTIONS
// =============================================================================

async function fetchSampleConsumption(
  start: Date,
  end: Date,
): Promise<SampleConsumptionSummary> {
  const tp = await requireTenantPrisma();
  const samples = await tp.sampleUsage.findMany({
    where: { status: "COMPLETED", givenAt: { gte: start, lt: end } },
    select: {
      totalCost: true,
      components: {
        select: {
          quantityKg: true,
          quantityUnit: true,
          productId: true,
          packagingId: true,
          product: { select: { type: true } },
        },
      },
    },
  });

  let rbConsumedKg = 0;
  let fgConsumedUnits = 0;
  let pkgConsumedUnits = 0;
  let totalCost = 0;

  for (const sample of samples) {
    totalCost += Number(sample.totalCost);
    for (const comp of sample.components) {
      if (comp.product?.type === "ROASTED_BEAN" && comp.quantityKg) {
        rbConsumedKg += Number(comp.quantityKg);
      } else if (comp.product?.type === "FINISHED_GOODS" && comp.quantityUnit) {
        fgConsumedUnits += comp.quantityUnit;
      } else if (comp.packagingId && comp.quantityUnit) {
        pkgConsumedUnits += comp.quantityUnit;
      }
    }
  }

  return {
    rbConsumedKg,
    fgConsumedUnits,
    pkgConsumedUnits,
    totalCost,
    sampleCount: samples.length,
  };
}

export async function getInventoryPageData(): Promise<InventoryPageData> {
  await requireRole("OWNER", "MANAGER", "OPERATOR");
  const tp = await requireTenantPrisma();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [gbStocks, rbStocks, supplyStocks, fgStocks, ledgerEntries, suppliers, gbProducts, rbProducts, coffeeSources, sampleConsumption, lots, supplyAdapterRows] =
    await Promise.all([
      fetchProductStocks("GREEN_BEAN"),
      fetchProductStocks("ROASTED_BEAN"),
      fetchSupplyStocks(),
      fetchFGStocks(),
      fetchLedgerHistory(),
      tp.supplier.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: "asc" },
      }),
      tp.product.findMany({
        where: { type: "GREEN_BEAN", isActive: true },
        select: { id: true, name: true, origin: true },
        orderBy: { name: "asc" },
      }),
      tp.product.findMany({
        where: { type: "ROASTED_BEAN", isActive: true, materialOrigin: "PURCHASED_ROASTED" },
        select: { id: true, name: true, origin: true, roastLevel: true, materialOrigin: true },
        orderBy: { name: "asc" },
      }),
      tp.coffeeSource.findMany({
        where: { isActive: true },
        select: { id: true, name: true, region: true, country: true },
        orderBy: { name: "asc" },
      }),
      fetchSampleConsumption(monthStart, now),
      tp.lot.findMany({
        where: {
          OR: [{ productId: { not: null } }, { packagingId: { not: null } }, { supplyItemId: { not: null } }],
        },
        select: {
          id: true,
          productId: true,
          packagingId: true,
          supplyItemId: true,
          batchCode: true,
          expiryDate: true,
          receivedAt: true,
          quantityKg: true,
          quantityUnit: true,
          supplyQuantity: true,
          consumedAt: true,
          supplier: { select: { name: true } },
          inventoryLedgers: {
            select: { entryType: true, quantityKg: true, quantityUnit: true, supplyQuantity: true },
          },
          placements: {
            select: {
              quantityKg: true,
              quantityUnit: true,
              supplyQty: true,
              location: {
                select: {
                  name: true,
                  warehouse: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
      tp.packaging.findMany({
        where: { supplyItemId: { not: null } },
        select: { id: true, supplyItemId: true },
      }),
    ]);

  // Compatibility path: lot legacy packagingId dibaca lewat mapping adapter
  // Packaging.supplyItemId, sehingga tampil di bawah item supply yang sama
  // tanpa double-count (sebuah lot hanya memiliki satu subject).
  const supplyItemByPackagingId = new Map<string, string>();
  for (const adapter of supplyAdapterRows) {
    supplyItemByPackagingId.set(adapter.id, adapter.supplyItemId!);
  }

  const lotsByProduct: Record<string, ProductLotRow[]> = {};
  const supplyLotsByItem: Record<string, SupplyLotRow[]> = {};
  for (const lot of lots) {
    if (lot.productId) {
      const inv = summarizeLotInventory({
        originalKg: lot.quantityKg,
        originalUnit: lot.quantityUnit,
        ledgers: lot.inventoryLedgers,
        expiryDate: lot.expiryDate,
        consumedAt: lot.consumedAt,
        now,
      });
      if (inv.status === "consumed") continue;
      (lotsByProduct[lot.productId] ??= []).push({
        id: lot.id,
        batchCode: lot.batchCode,
        expiryDate: lot.expiryDate?.toISOString() ?? null,
        receivedAt: lot.receivedAt.toISOString(),
        supplierName: lot.supplier?.name ?? null,
        remainingKg: inv.remainingKg,
        remainingUnit: inv.remainingUnit,
        status: inv.status,
        placements: lot.placements.map((p) => ({
          warehouseName: p.location.warehouse.name,
          locationName: p.location.name,
          quantityKg: Number(p.quantityKg),
          quantityUnit: p.quantityUnit,
          supplyQty: Number(p.supplyQty),
        })),
      });
      continue;
    }

    // Subject supply: lot baru (supplyItemId) atau lot legacy packagingId
    // yang dipetakan lewat adapter (compatibility path).
    const supplyKey =
      lot.supplyItemId ??
      (lot.packagingId ? (supplyItemByPackagingId.get(lot.packagingId) ?? null) : null);
    if (!supplyKey) continue;
    const inv = summarizeSupplyLotInventory({
      original: lot.supplyQuantity ?? lot.quantityUnit,
      ledgers: lot.inventoryLedgers,
      statusField: lot.supplyItemId ? "supplyQuantity" : "quantityUnit",
      expiryDate: lot.expiryDate,
      consumedAt: lot.consumedAt,
      now,
    });
    if (inv.status === "consumed") continue;
    (supplyLotsByItem[supplyKey] ??= []).push({
      id: lot.id,
      batchCode: lot.batchCode,
      expiryDate: lot.expiryDate?.toISOString() ?? null,
      receivedAt: lot.receivedAt.toISOString(),
      supplierName: lot.supplier?.name ?? null,
      remainingQty: inv.remainingQty,
      status: inv.status,
      placements: lot.placements.map((p) => ({
        warehouseName: p.location.warehouse.name,
        locationName: p.location.name,
        quantityKg: Number(p.quantityKg),
        quantityUnit: p.quantityUnit,
        supplyQty: Number(p.supplyQty),
      })),
    });
  }
  for (const key of Object.keys(lotsByProduct)) {
    lotsByProduct[key].sort((a, b) => {
      if (a.expiryDate === null && b.expiryDate === null) return a.batchCode.localeCompare(b.batchCode);
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate.localeCompare(b.expiryDate);
    });
  }
  for (const key of Object.keys(supplyLotsByItem)) {
    supplyLotsByItem[key].sort((a, b) => {
      if (a.expiryDate === null && b.expiryDate === null) return a.batchCode.localeCompare(b.batchCode);
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate.localeCompare(b.expiryDate);
    });
  }

  return { gbStocks, rbStocks, supplyStocks, fgStocks, ledgerEntries, suppliers, gbProducts, rbProducts, coffeeSources, sampleConsumption, lotsByProduct, supplyLotsByItem };
}

// Tambah packaging options ke page data helper
export async function getPackagingOptions() {
  return (await requireTenantPrisma()).packaging.findMany({
    where: { isActive: true },
    select: { id: true, name: true, code: true, costPerUnit: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Opsi supply kanonik untuk purchase/PO (seluruh kategori, stok & biaya dari
 * InventorySupplyItem). Kategori PACKAGING adalah sumber "Kemasan" yang benar —
 * bukan model Packaging legacy.
 */
export async function getSupplyOptions() {
  const items = await (await requireTenantPrisma()).inventorySupplyItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      code: true,
      category: true,
      baseUnit: true,
      avgCostPerUnit: true,
      costPerUnit: true,
    },
    orderBy: { name: "asc" },
  });
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    code: item.code,
    category: item.category,
    baseUnit: item.baseUnit.toLowerCase(),
    costPerUnit: Number(item.avgCostPerUnit ?? item.costPerUnit ?? 0),
  }));
}

/**
 * Catat Barang Datang (Green Bean).
 *
 * ACID transaction:
 *   1. Find-or-create Product (GREEN_BEAN)
 *   2. Insert Purchase (status = COMPLETED)
 *   3. Insert InventoryLedger (IN, refType = PURCHASE_GB)
 * Pengguna cukup mengirim total nota. Server memisahkan harga barang dan ongkir,
 * menghitung harga per kg, status pembayaran, utang, dan HPP ledger secara atomik.
 */
export async function createGreenBeanPurchase(
  input: PurchaseActionInput
): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    if (!input.operationKey || !/^[0-9a-f-]{36}$/i.test(input.operationKey)) {
      return { success: false, error: "Identitas transaksi tidak valid. Buka ulang form lalu coba lagi." };
    }
    if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
      return { success: false, error: "Berat Green Bean harus lebih dari 0 kg." };
    }
    if (!Number.isFinite(input.totalCost) || input.totalCost <= 0) {
      return { success: false, error: "Total pembelian harus lebih dari 0." };
    }
    const shippingCost = Number(input.shippingCost ?? 0);
    if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost >= input.totalCost) {
      return { success: false, error: "Ongkos kirim harus lebih kecil dari total pembelian." };
    }

    // Intake mutu per-lot (opsional): validasi rentang bila diisi.
    const moisturePct = input.moisturePct ?? undefined;
    if (moisturePct !== undefined && (!Number.isFinite(moisturePct) || moisturePct < 0 || moisturePct > 100)) {
      return { success: false, error: "Kadar air harus antara 0–100%." };
    }
    const humidityPct = input.humidityPct ?? undefined;
    if (humidityPct !== undefined && (!Number.isFinite(humidityPct) || humidityPct < 0 || humidityPct > 100)) {
      return { success: false, error: "Kelembapan ruang harus antara 0–100%." };
    }
    const defectCount = input.defectCount ?? undefined;
    if (defectCount !== undefined && (!Number.isInteger(defectCount) || defectCount < 0)) {
      return { success: false, error: "Jumlah defect harus bilangan bulat ≥ 0." };
    }
    const harvestDate = input.harvestDate ? new Date(`${input.harvestDate}T00:00:00`) : null;
    if (harvestDate && Number.isNaN(harvestDate.getTime())) {
      return { success: false, error: "Tanggal panen tidak valid." };
    }
    const qcStatus = input.qcStatus ?? "RELEASED";

    const tenantPrisma = await requireTenantPrisma();
    const previousAttempt = await tenantPrisma.purchase.findFirst({
      where: { operationKey: input.operationKey },
      select: { code: true },
    });
    if (previousAttempt) return { success: true, purchaseCode: previousAttempt.code };

    const payment = resolvePurchasePaymentFromAmount(input.totalCost, input.paidAmount);
    const receivedAt = new Date(`${input.receivedAt}T00:00:00`);
    if (Number.isNaN(receivedAt.getTime())) {
      return { success: false, error: "Tanggal penerimaan tidak valid." };
    }
    const dueDate = parsePurchaseDueDate(payment.paymentStatus, input.dueDate, receivedAt);
    const purchaseCode = generatePurchaseCode(receivedAt);
    const itemCost = input.totalCost - shippingCost;
    const pricePerKg = itemCost / input.weightKg;
    const supplier = await tenantPrisma.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, name: true, isActive: true },
    });
    if (!supplier?.isActive) {
      return { success: false, error: "Supplier tidak ditemukan atau sudah nonaktif." };
    }

    await tenantPrisma.$transaction(async (tx) => {
      if (!supplier?.isActive) throw new Error("Supplier tidak ditemukan atau sudah nonaktif.");

      let product = input.productId
        ? await tx.product.findUnique({ where: { id: input.productId, tenantId } })
        : null;
      if (input.productId && !product) {
        throw new Error("Green Bean tidak ditemukan atau bukan milik tenant Anda.");
      }
      if (product && (product.type !== "GREEN_BEAN" || !product.isActive)) {
        throw new Error("Produk bukan Green Bean aktif.");
      }
      if (!product && input.productName?.trim()) {
        const productName = input.productName.trim();
        // Produk baru SELALU dibuat baru (beserta CoffeeSource atomik-nya):
        // reuse hanya lewat productId eksplisit, tidak pernah lewat nama.
        const productCode = generateProductCode(productName);
        // Identitas akar dibuat atomik bersama produk: CoffeeSource dengan
        // kode sama dengan produk GB (deterministik, 1:1 seperti master data).
        const identity = normalizeCoffeeIdentity({
          name: productName,
          region: input.productOrigin?.trim() || null,
        });
          const source = await tx.coffeeSource.create({
            data: {
              tenantId,
              code: productCode,
              name: identity.name,
              country: identity.country,
              region: identity.region,
              farm: identity.farm,
              species: identity.species,
              varietal: identity.varietal,
              processMethod: identity.processMethod,
              fermentationMethod: identity.fermentationMethod,
              elevation: identity.elevation,
              cropYear: identity.cropYear,
              certifications: identity.certifications,
              tastingNotes: identity.tastingNotes,
              isActive: true,
            },
            select: { id: true },
          });
          product = await tx.product.create({
            data: {
              tenantId,
              code: productCode,
              name: productName,
              type: "GREEN_BEAN",
              origin: input.productOrigin?.trim() || null,
              coffeeSourceId: source.id,
            },
          });
      }
      if (!product) throw new Error("Pilih Green Bean atau tulis nama Green Bean baru.");

      const purchase = await tx.purchase.create({
        data: {
          tenantId,
          code: purchaseCode,
          operationKey: input.operationKey,
          type: "GREEN_BEAN",
          supplierId: input.supplierId,
          productId: product.id,
          weightKg: input.weightKg,
          pricePerUnit: pricePerKg,
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
            notes: payment.paymentStatus === "PARTIAL" ? "Uang muka pembelian" : "Pembayaran pembelian",
            createdById: userId,
          },
        });
      }

      const lot = await tx.lot.create({
        data: {
          tenantId,
          productId: product.id,
          supplierId: input.supplierId,
          purchaseId: purchase.id,
          batchCode: purchase.code,
          quantityKg: input.weightKg,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          receivedAt,
          // Lot supplier kini kolom terstruktur; notes hanya fallback pemanggil lama.
          supplierLotNumber: input.supplierLotNumber?.trim() || input.lotNumber || null,
          moisturePct: moisturePct ?? null,
          humidityPct: humidityPct ?? null,
          harvestDate,
          defectCount: defectCount ?? null,
          qcStatus,
          notes: !input.supplierLotNumber && input.lotNumber ? `Lot supplier: ${input.lotNumber}` : null,
        },
      });

      await createLotPlacementInTx(tx, tenantId, lot.id, {
        quantityKg: input.weightKg,
      });

      await appendLedger(tx, {
        data: {
          tenantId,
          productId: product.id,
          entryType: "IN",
          refType: "PURCHASE_GB",
          refId: purchase.id,
          quantityKg: input.weightKg,
          incomingPrice: input.totalCost / input.weightKg,
          lotId: lot.id,
          lotNumber: lot.batchCode,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          notes: `Barang datang: ${purchase.code}`,
          createdById: userId,
        },
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
        "GREEN_BEAN",
        Number(input.totalCost),
        Number(payment.paidAmount),
        supplier.name,
        { tx, tenantId, userId, date: receivedAt },
      );
    }, { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 });

    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    revalidatePath("/keuangan");
    revalidatePath("/laporan");

    return { success: true, purchaseCode };
  } catch (err) {
    console.error("[createGreenBeanPurchase]", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.operationKey) {
      const existing = await (await requireTenantPrisma()).purchase.findFirst({
        where: { operationKey: input.operationKey },
        select: { code: true },
      });
      if (existing) return { success: true, purchaseCode: existing.code };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Terjadi kesalahan sistem.",
    };
  }
}

// =============================================================================
// CREATE ROASTED BEAN PURCHASE (beli jadi)
// =============================================================================

/**
 * Pencatatan barang datang Roasted Bean (beli jadi).
 * Pola identik dengan createGreenBeanPurchase:
 *   1. Find-or-create Product (ROASTED_BEAN) — materialOrigin PURCHASED_ROASTED,
 *      selalu tertaut CoffeeSource (coffeeSourceId WAJIB terisi; produk tanpa
 *      sumber kopi ditolak — tidak ada lagi coffeeSourceId NULL di alur ini).
 *   2. Insert Purchase (type = ROASTED_BEAN, status = COMPLETED)
 *   3. Insert Lot + placement, InventoryLedger (IN, refType = PURCHASE_RB),
 *      moving average, jurnal pembelian (1-1210).
 */
export async function createRoastedBeanPurchase(
  input: RoastedBeanPurchaseInput
): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    if (!input.operationKey || !/^[0-9a-f-]{36}$/i.test(input.operationKey)) {
      return { success: false, error: "Identitas transaksi tidak valid. Buka ulang form lalu coba lagi." };
    }
    if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
      return { success: false, error: "Berat Roasted Bean harus lebih dari 0 kg." };
    }
    if (!Number.isFinite(input.totalCost) || input.totalCost <= 0) {
      return { success: false, error: "Total pembelian harus lebih dari 0." };
    }
    const shippingCost = Number(input.shippingCost ?? 0);
    if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost >= input.totalCost) {
      return { success: false, error: "Ongkos kirim harus lebih kecil dari total pembelian." };
    }
    const roastLevel = (input.productRoastLevel ?? "").trim().toUpperCase();
    if (!ROAST_LEVELS.has(roastLevel)) {
      return { success: false, error: "Tingkat sangrai tidak valid." };
    }

    const tenantPrisma = await requireTenantPrisma();
    const previousAttempt = await tenantPrisma.purchase.findFirst({
      where: { operationKey: input.operationKey },
      select: { code: true },
    });
    if (previousAttempt) return { success: true, purchaseCode: previousAttempt.code };

    const payment = resolvePurchasePaymentFromAmount(input.totalCost, input.paidAmount);
    const receivedAt = new Date(`${input.receivedAt}T00:00:00`);
    if (Number.isNaN(receivedAt.getTime())) {
      return { success: false, error: "Tanggal penerimaan tidak valid." };
    }
    const dueDate = parsePurchaseDueDate(payment.paymentStatus, input.dueDate, receivedAt);
    const purchaseCode = generatePurchaseCode(receivedAt);
    const itemCost = input.totalCost - shippingCost;
    const pricePerKg = itemCost / input.weightKg;
    const supplier = await tenantPrisma.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, name: true, isActive: true },
    });
    if (!supplier?.isActive) {
      return { success: false, error: "Supplier tidak ditemukan atau sudah nonaktif." };
    }

    await tenantPrisma.$transaction(async (tx) => {
      if (!supplier?.isActive) throw new Error("Supplier tidak ditemukan atau sudah nonaktif.");

      let product = input.productId
        ? await tx.product.findUnique({ where: { id: input.productId, tenantId } })
        : null;
      if (input.productId && !product) {
        throw new Error("Roasted Bean tidak ditemukan atau bukan milik tenant Anda.");
      }
      if (product) {
        // Hanya Roasted Bean beli jadi aktif dengan sumber kopi tertaut yang
        // boleh menerima pembelian. Mencampur stok sangrai internal (atau
        // produk tanpa identitas) dengan pembelian dalam satu Product dilarang.
        if (
          product.type !== "ROASTED_BEAN" ||
          !product.isActive ||
          product.materialOrigin !== "PURCHASED_ROASTED" ||
          !product.coffeeSourceId
        ) {
          throw new Error("Produk Roasted Bean harus berstatus beli jadi (PURCHASED_ROASTED) dengan sumber kopi tertaut.");
        }
      }
      if (!product) {
        const productName = input.productName?.trim();
        if (!productName || productName.length < 2) {
          throw new Error("Pilih Roasted Bean atau tulis nama Roasted Bean baru.");
        }
        const source = await resolveRoastedBeanSource(tx, tenantId, input);
        // Produk yang dapat dipakai ulang dicocokkan lewat identititas kopi
        // (sumber + tingkat sangrai + beli jadi), BUKAN lewat nama saja —
        // nama murni tampilan dan tidak pernah dijadikan kunci identitas.
        product = await tx.product.findFirst({
          where: {
            type: "ROASTED_BEAN",
            isActive: true,
            materialOrigin: "PURCHASED_ROASTED",
            coffeeSourceId: source.id,
            roastLevel,
          },
        });
        if (!product) {
          product = await tx.product.create({
            data: {
              tenantId,
              code: generateRBCode(productName),
              name: productName,
              type: "ROASTED_BEAN",
              roastLevel,
              origin: input.productOrigin?.trim() || source.region || null,
              coffeeSpecies: source.species ?? null,
              materialOrigin: "PURCHASED_ROASTED",
              coffeeSourceId: source.id,
            },
          });
        }
      }

      const purchase = await tx.purchase.create({
        data: {
          tenantId,
          code: purchaseCode,
          operationKey: input.operationKey,
          type: "ROASTED_BEAN",
          supplierId: input.supplierId,
          productId: product.id,
          weightKg: input.weightKg,
          pricePerUnit: pricePerKg,
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
            notes: payment.paymentStatus === "PARTIAL" ? "Uang muka pembelian" : "Pembayaran pembelian",
            createdById: userId,
          },
        });
      }

      const lot = await tx.lot.create({
        data: {
          tenantId,
          productId: product.id,
          supplierId: input.supplierId,
          purchaseId: purchase.id,
          batchCode: purchase.code,
          quantityKg: input.weightKg,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          receivedAt,
          notes: input.lotNumber ? `Lot supplier: ${input.lotNumber}` : null,
        },
      });

      await createLotPlacementInTx(tx, tenantId, lot.id, {
        quantityKg: input.weightKg,
      });

      await appendLedger(tx, {
        data: {
          tenantId,
          productId: product.id,
          entryType: "IN",
          refType: "PURCHASE_RB",
          refId: purchase.id,
          quantityKg: input.weightKg,
          incomingPrice: input.totalCost / input.weightKg,
          lotId: lot.id,
          lotNumber: lot.batchCode,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          notes: `Barang datang: ${purchase.code}`,
          createdById: userId,
        },
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
        "ROASTED_BEAN",
        Number(input.totalCost),
        Number(payment.paidAmount),
        supplier.name,
        { tx, tenantId, userId, date: receivedAt },
      );
    }, { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 });

    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    revalidatePath("/keuangan");
    revalidatePath("/laporan");

    return { success: true, purchaseCode };
  } catch (err) {
    console.error("[createRoastedBeanPurchase]", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.operationKey) {
      const existing = await (await requireTenantPrisma()).purchase.findFirst({
        where: { operationKey: input.operationKey },
        select: { code: true },
      });
      if (existing) return { success: true, purchaseCode: existing.code };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Terjadi kesalahan sistem.",
    };
  }
}

// =============================================================================
// PREPARE PURCHASED ROASTED BEAN (persiapan sebelum PO)
// =============================================================================

export type PreparePurchasedRoastedBeanInput = {
  productName: string;
  productOrigin?: string;
  productRoastLevel: string;
  coffeeSourceId?: string;
  coffeeSource?: NewCoffeeSourceInput;
};

export type PreparePurchasedRoastedBeanResult =
  | { success: true; productId: string; productName: string; created: boolean }
  | { success: false; error: string };

/**
 * Siapkan produk Roasted Bean beli jadi tanpa membuat pembelian: cocok untuk
 * membuat PO sebelum barang datang. Identitas (sumber kopi + tingkat sangrai)
 * dibuat/terautat atomik; produk yang identik dipakai ulang, bukan diduplikasi.
 */
export async function preparePurchasedRoastedBean(
  input: PreparePurchasedRoastedBeanInput,
): Promise<PreparePurchasedRoastedBeanResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const productName = input.productName.trim();
    if (productName.length < 2) {
      return { success: false, error: "Nama minimal 2 karakter." };
    }
    const roastLevel = (input.productRoastLevel ?? "").trim().toUpperCase();
    if (!ROAST_LEVELS.has(roastLevel)) {
      return { success: false, error: "Tingkat sangrai tidak valid." };
    }

    const tenantPrisma = await requireTenantPrisma();
    let created = false;
    const product = await tenantPrisma.$transaction(async (tx) => {
      const source = await resolveRoastedBeanSource(tx, tenantId, input);
      const existing = await tx.product.findFirst({
        where: {
          type: "ROASTED_BEAN",
          isActive: true,
          materialOrigin: "PURCHASED_ROASTED",
          coffeeSourceId: source.id,
          roastLevel,
        },
      });
      if (existing) return existing;
      created = true;
      return tx.product.create({
        data: {
          tenantId,
          code: generateRBCode(productName),
          name: productName,
          type: "ROASTED_BEAN",
          roastLevel,
          origin: input.productOrigin?.trim() || source.region || null,
          coffeeSpecies: source.species ?? null,
          materialOrigin: "PURCHASED_ROASTED",
          coffeeSourceId: source.id,
        },
      });
    }, { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 });

    return { success: true, productId: product.id, productName: product.name, created };
  } catch (err) {
    console.error("[preparePurchasedRoastedBean]", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Terjadi kesalahan sistem.",
    };
  }
}

// =============================================================================
// CREATE PACKAGING PURCHASE
// =============================================================================

export async function createPackagingPurchase(
  input: PackagingPurchaseInput
): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    if (!input.operationKey || !/^[0-9a-f-]{36}$/i.test(input.operationKey)) {
      return { success: false, error: "Identitas transaksi tidak valid. Buka ulang form lalu coba lagi." };
    }
    if (!Number.isInteger(input.quantityUnits) || input.quantityUnits <= 0) {
      return { success: false, error: "Jumlah kemasan harus berupa unit lebih dari 0." };
    }
    if (!Number.isFinite(input.totalCost) || input.totalCost <= 0) {
      return { success: false, error: "Total pembelian harus lebih dari 0." };
    }
    const shippingCost = Number(input.shippingCost ?? 0);
    if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost >= input.totalCost) {
      return { success: false, error: "Ongkos kirim harus lebih kecil dari total pembelian." };
    }

    const tenantPrisma = await requireTenantPrisma();
    const previousAttempt = await tenantPrisma.purchase.findFirst({
      where: { operationKey: input.operationKey },
      select: { code: true },
    });
    if (previousAttempt) return { success: true, purchaseCode: previousAttempt.code };

    const payment = resolvePurchasePaymentFromAmount(input.totalCost, input.paidAmount);
    const receivedAt = new Date(`${input.receivedAt}T00:00:00`);
    if (Number.isNaN(receivedAt.getTime())) {
      return { success: false, error: "Tanggal penerimaan tidak valid." };
    }
    const dueDate = parsePurchaseDueDate(payment.paymentStatus, input.dueDate, receivedAt);
    const purchaseCode = generatePurchaseCode(receivedAt);
    const pricePerUnit = (input.totalCost - shippingCost) / input.quantityUnits;
    const [supplier, packaging] = await Promise.all([
      tenantPrisma.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true, isActive: true } }),
      tenantPrisma.packaging.findUnique({ where: { id: input.packagingId }, select: { id: true, name: true, isActive: true } }),
    ]);
    if (!supplier?.isActive) {
      return { success: false, error: "Supplier tidak ditemukan atau sudah nonaktif." };
    }
    if (!packaging?.isActive) {
      return { success: false, error: "Kemasan tidak ditemukan atau sudah nonaktif." };
    }

    await tenantPrisma.$transaction(async (tx) => {
      if (!supplier?.isActive) throw new Error("Supplier tidak ditemukan atau sudah nonaktif.");
      if (!packaging?.isActive) throw new Error("Kemasan tidak ditemukan atau sudah nonaktif.");

      const purchase = await tx.purchase.create({
        data: {
          tenantId,
          code:         purchaseCode,
          operationKey: input.operationKey,
          type:         "PACKAGING",
          supplierId:   input.supplierId,
          packagingId:  input.packagingId,
          quantityUnits: input.quantityUnits,
          pricePerUnit,
          shippingCost,
          totalCost: input.totalCost,
          status:       "COMPLETED",
          paymentStatus: payment.paymentStatus,
          paidAmount:   payment.paidAmount,
          dueDate,
          receivedAt,
          notes:        input.notes ?? null,
          createdById:  userId,
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
            notes: payment.paymentStatus === "PARTIAL" ? "Uang muka pembelian" : "Pembayaran pembelian",
            createdById: userId,
          },
        });
      }

      const lot = await tx.lot.create({
        data: {
          tenantId,
          packagingId: input.packagingId,
          supplierId: input.supplierId,
          purchaseId: purchase.id,
          batchCode: purchase.code,
          quantityUnit: input.quantityUnits,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          receivedAt,
          notes: input.lotNumber ? `Lot supplier: ${input.lotNumber}` : null,
        },
      });

      await createLotPlacementInTx(tx, tenantId, lot.id, {
        quantityUnit: input.quantityUnits,
      });

      await appendLedger(tx, {
        data: {
          packagingId:  input.packagingId,
          entryType:    "IN",
          refType:      "PURCHASE_PKG",
          refId:        purchase.id,
          quantityUnit: input.quantityUnits,
          incomingPrice: input.totalCost / input.quantityUnits,
          lotId: lot.id,
          lotNumber: lot.batchCode,
          expiryDate: input.bestBeforeDate ? new Date(`${input.bestBeforeDate}T00:00:00`) : null,
          notes:        `Kemasan datang: ${purchase.code}`,
          createdById:  userId,
        },
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
        "PACKAGING",
        Number(input.totalCost),
        Number(payment.paidAmount),
        supplier.name,
        { tx, tenantId, userId, date: receivedAt },
      );
    }, { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 });

    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    revalidatePath("/keuangan");
    revalidatePath("/laporan");

    return { success: true, purchaseCode };
  } catch (err) {
    console.error("[createPackagingPurchase]", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.operationKey) {
      const existing = await (await requireTenantPrisma()).purchase.findFirst({
        where: { operationKey: input.operationKey },
        select: { code: true },
      });
      if (existing) return { success: true, purchaseCode: existing.code };
    }
    return { success: false, error: err instanceof Error ? err.message : "Terjadi kesalahan." };
  }
}
// =============================================================================
// CREATE SUPPLY PURCHASE (DIRECT, NON-PO)
// =============================================================================

export async function createSupplyPurchaseAction(
  input: CreateSupplyPurchaseInput,
): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    if (!input.operationKey || !/^[0-9a-f-]{36}$/i.test(input.operationKey)) {
      return { success: false, error: "Identitas transaksi tidak valid. Buka ulang form lalu coba lagi." };
    }
    if (!Number.isFinite(input.supplyQuantity) || input.supplyQuantity <= 0) {
      return { success: false, error: "Kuantitas supply harus lebih dari 0." };
    }
    if (!Number.isFinite(input.totalCost) || input.totalCost <= 0) {
      return { success: false, error: "Total pembelian harus lebih dari 0." };
    }
    const shippingCost = Number(input.shippingCost ?? 0);
    if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost >= input.totalCost) {
      return { success: false, error: "Ongkos kirim harus lebih kecil dari total pembelian." };
    }

    const tenantPrisma = await requireTenantPrisma();
    const result = await createSupplyPurchase(tenantPrisma, tenantId, userId, {
      ...input,
      shippingCost,
    });

    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    revalidatePath("/keuangan");
    revalidatePath("/laporan");

    return { success: true, purchaseCode: result.purchaseCode };
  } catch (err) {
    console.error("[createSupplyPurchaseAction]", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.operationKey) {
      const existing = await (await requireTenantPrisma()).purchase.findFirst({
        where: { operationKey: input.operationKey },
        select: { code: true },
      });
      if (existing) return { success: true, purchaseCode: existing.code };
    }
    return { success: false, error: err instanceof Error ? err.message : "Terjadi kesalahan." };
  }
}
// =============================================================================
// CREATE PACKAGING (QUICK ADD)
// =============================================================================
export async function createPackaging(data: {
  code?: string;
  name: string;
  weightGrams: number;
  costPerUnit: number;
}) {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const name = data.name?.trim();
    if (!name) return { success: false as const, error: "Nama kemasan wajib diisi." };
    if (!Number.isFinite(data.weightGrams) || data.weightGrams < 0) {
      return { success: false as const, error: "Berat kemasan tidak valid." };
    }
    if (!Number.isFinite(data.costPerUnit) || data.costPerUnit < 0) {
      return { success: false as const, error: "Harga kemasan tidak valid." };
    }

    const tenantId = await getCurrentTenantId();
    const tp = await requireTenantPrisma();
    const duplicate = await tp.packaging.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { code: true, name: true },
    });
    if (duplicate) {
      return { success: false as const, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };
    }

    const code = data.code?.trim().toUpperCase() || `PKG-${randomBytes(3).toString("hex").toUpperCase()}`;
    const newPkg = await tp.packaging.create({
      data: {
        tenantId,
        code,
        name,
        weightGrams: data.weightGrams,
        costPerUnit: data.costPerUnit,
        isActive: true,
      },
    });

    // Refresh halaman agar dropdown kemasan otomatis mendapatkan data terbaru
    revalidatePath("/inventory"); 

    return {
      success: true as const,
      packagingId: newPkg.id,
      packaging: {
        id: newPkg.id,
        code: newPkg.code,
        name: newPkg.name,
        costPerUnit: Number(newPkg.costPerUnit),
      },
    };
  } catch (err) {
    console.error("[createPackaging]", err);
    return { 
      success: false as const, 
      error: "Gagal menyimpan kemasan. Pastikan kode kemasan unik dan belum digunakan." 
    };
  }
}
// =============================================================================
// STOCK OPNAME (ADJUSTMENT)
// =============================================================================

export async function adjustStock(input: {
  operationKey?: string;
  targetId: string;
  isPackaging: boolean;
  isSupply?: boolean;
  type: "IN" | "OUT";
  quantity: number;
  notes: string;
}) {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();

    // Validasi input
    if (input.quantity <= 0) {
      throw new Error("Kuantitas penyesuaian harus lebih dari 0");
    }

    if (input.isSupply) {
      const result = await adjustSupplyStock(
        await requireTenantPrisma(),
        tenantId,
        userId,
        {
          operationKey: input.operationKey,
          supplyItemId: input.targetId,
          type: input.type,
          quantity: input.quantity,
          notes: input.notes,
        },
      );
      if (!result.success) return { success: false, error: result.error ?? "Terjadi kesalahan." };
      revalidatePath("/inventory");
      return { success: true };
    }

    const refId = input.operationKey || "OPNAME-" + randomBytes(6).toString("hex").toUpperCase();

    await (await requireTenantPrisma()).$transaction(async (tx) => {
      // Cek idempotensi harus di dalam tx Serializable agar dua retry
      // konkuren dengan operationKey sama tidak lolos bersamaan.
      if (input.operationKey) {
        const existing = await tx.inventoryLedger.findFirst({
          where: { refId: input.operationKey, refType: { in: ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"] } },
          select: { id: true },
        });
        if (existing) return;
      }

      let qtyKg: number | null = null;
      let qtyUnit: number | null = null;
      let unitCost = 0;
      let productType: "GREEN_BEAN" | "ROASTED_BEAN" | "FINISHED_GOODS" | "PACKAGING" = "PACKAGING";
      const refType: "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" = input.type === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";

      if (input.isPackaging) {
        const packaging = await tx.packaging.findUnique({
          where: { id: input.targetId },
          select: { avgCostPerUnit: true, costPerUnit: true },
        });
        if (!packaging) throw new Error("Kemasan tidak ditemukan");
        qtyUnit = input.quantity;
        unitCost = Number(packaging.avgCostPerUnit ?? packaging.costPerUnit ?? 0);
      } else {
        const prod = await tx.product.findUnique({
          where: { id: input.targetId },
          select: { type: true, avgCostPerKg: true, lastHpp: true },
        });
        if (!prod) throw new Error("Produk tidak ditemukan");
        productType = prod.type;
        unitCost = prod.type === "FINISHED_GOODS"
          ? Number(prod.lastHpp ?? 0)
          : Number(prod.avgCostPerKg ?? 0);
        if (prod.type === "FINISHED_GOODS") {
          qtyUnit = input.quantity;
        } else {
          qtyKg = input.quantity;
        }
      }

      await appendLedger(tx, {
        data: {
          productId:     input.isPackaging ? null : input.targetId,
          packagingId:   input.isPackaging ? input.targetId : null,
          entryType:     input.type,
          refType,
          refId,
          quantityKg:    qtyKg,
          quantityUnit:  qtyUnit,
          incomingPrice: input.type === "IN" ? unitCost || undefined : undefined,
          notes:         input.notes || "Penyesuaian stok fisik (Opname)",
          createdById:   userId,
        }
      });

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "ADJUST",
        entityType: input.isPackaging ? "PackagingStock" : "ProductStock",
        entityId: input.targetId,
        metadata: {
          direction: input.type,
          quantity: input.quantity,
          notes: input.notes,
        },
      });

      await postStockAdjustment(
        refId,
        productType,
        input.type,
        input.quantity,
        unitCost,
        { tx, tenantId, userId },
      );
    }, { isolationLevel: "Serializable", maxWait: 15000, timeout: 60000 });

    revalidatePath("/inventory");

    return { success: true };
  } catch (err) {
    console.error("[adjustStock]", err);
    return { success: false, error: err instanceof Error ? err.message : "Terjadi kesalahan." };
  }
}

/**
 * Get reorder alert data for all products and packaging
 */
export async function getReorderAlertData() {
  const tp = await requireTenantPrisma();
  return getBatchReorderSummaries(tp);
}
