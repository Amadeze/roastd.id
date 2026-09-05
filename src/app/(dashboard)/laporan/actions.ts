"use server";

import type { Prisma } from "@prisma/client";
import { getSystemUserId, getCurrentTenantId, requireFeature, requireTenantPrisma, getTenantTimezone } from "@/lib/auth";
import { getPayableAgingBucket } from "@/lib/purchase-payments";
import { revalidatePath, unstable_cache } from "next/cache";
import { getCurrentDate, dateToLocalRange, formatChartDate, getZonedDayRange, getTodayStringForTimezone } from "@/lib/date-utils";
import { weightedAverageCost } from "@/lib/financial-reporting";
import { formatRupiah } from "@/lib/format";
import {
  computeRevenue,
  computeNetProfit,
  computeTrend,
  computeAverageInvoice,
  type InputTotals,
} from "@/lib/report-finance";
import { computeCashMovement } from "@/lib/gl-cash-flow";
import { computeCoffeeFlowSales } from "@/lib/coffee-flow";
import { getRbCostPrioritizingCache, getFgHppPrioritizingCache } from "@/lib/costing";
import { computeValuationMetrics } from "@/lib/inventory-helpers";
import { prisma, withTenant } from "@/lib/prisma";
import { tenantQuery } from "@/lib/tenant-guard";

type DailyFinancialTotalRow = {
  dateKey: string;
  revenue: string;
  expenses: string;
};

type DailyChartPoint = {
  dateKey: string;
  label: string;
  start: Date;
  end: Date;
};

async function getDailyFinancialTotals(input: {
  tenantId: string;
  timezone: string;
  start: Date;
  end: Date;
}) {
  const fetchDailyRows = unstable_cache(
    async (tId: string, tz: string, s: string, e: string) => {
      return await tenantQuery<DailyFinancialTotalRow[]>(tId, async (t) => prisma.$queryRaw`
        SELECT
          daily."dateKey",
          COALESCE(SUM(daily.revenue), 0)::text AS revenue,
          COALESCE(SUM(daily.expenses), 0)::text AS expenses
        FROM (
          SELECT
            to_char(i."deliveredAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS "dateKey",
            i."grandTotal" - i."returnedAmount" AS revenue,
            0::numeric AS expenses
          FROM invoices i
          WHERE i."tenantId" = ${t}
            AND i."deliveredAt" IS NOT NULL
            AND (i."voidAt" IS NULL OR i."voidAt" >= ${new Date(e)})
            AND i."deliveredAt" >= ${new Date(s)}
            AND i."deliveredAt" < ${new Date(e)}

          UNION ALL

          SELECT
            to_char(ex.date AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS "dateKey",
            0::numeric AS revenue,
            ex.amount AS expenses
          FROM expenses ex
          WHERE ex."tenantId" = ${t}
            AND ex."voidAt" IS NULL
            AND ex.date >= ${new Date(s)}
            AND ex.date < ${new Date(e)}
        ) daily
        GROUP BY daily."dateKey"
      `);
    },
    ["daily-financial-totals-v3"],
    { revalidate: 300 }
  );

  const rows = await fetchDailyRows(input.tenantId, input.timezone, input.start.toISOString(), input.end.toISOString());

  return new Map(
    rows.map((row) => [
      row.dateKey,
      { revenue: Number(row.revenue), expenses: Number(row.expenses) },
    ]),
  );
}

function buildChartDaysFrom(startDate: string, count: number, timezone: string): DailyChartPoint[] {
  const seed = dateToLocalRange(startDate, timezone).start;
  return Array.from({ length: count }, (_, index) => {
    const day = getZonedDayRange(seed, timezone, index);
    return {
      dateKey: day.dateKey,
      label: formatChartDate(day.start, timezone),
      start: day.start,
      end: day.end,
    };
  });
}

export type ValuationRow = {
  id: string;
  code: string;
  name: string;
  category: "GREEN_BEAN" | "ROASTED_BEAN" | "FINISHED_GOODS" | "PACKAGING" | "SUPPLY";
  stock: number;
  unit: string;
  unitCost: number;
  totalValue: number;
  retailPrice?: number;
  potentialRevenue?: number;
  sampleWriteOff: number;
  /** Ambang "stok menipis" per item (pakai safety stock bila diaktifkan). */
  lowStockThreshold: number;
};

/** Ambang stok menipis: safety stock tenant bila diaktifkan, selain itu default sesuai satuan. */
function lowStockThresholdFor(
  unit: string,
  safetyStock?: { toNumber?: () => number } | number | null,
  enabled?: boolean,
): number {
  const safety = typeof safetyStock === "number" ? safetyStock : Number(safetyStock?.toNumber?.() ?? safetyStock ?? 0);
  if (enabled && safety > 0) return safety;
  return unit === "kg" ? 10 : 20;
}

export type InventoryValuationReport = {
  items: ValuationRow[];
  totalGreenBeanValue: number;
  totalRoastedBeanValue: number;
  totalFinishedGoodsValue: number;
  totalPackagingValue: number;
  totalSupplyValue: number;
  grandTotalValue: number;
  totalFinishedGoodsPotentialRevenue: number;
  totalFinishedGoodsMarginHealth: number;
  totalPotentialRevenue: number;
  totalMarginHealth: number;
  asOf: string;
  costMethod: "WEIGHTED_AVERAGE";
  zeroCostItemCount: number;
  totalSampleWriteOff: number;
};

/** Bucket timestamp ke interval 5 menit agar pemanggilan berulang (asOf "now") berbagi entri cache. */
function bucketIsoTo5Minutes(date: Date): string {
  const windowMs = 5 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs).toISOString();
}

// Laporan valuasi memindai seluruh ledger per produk — mahal pada tenant besar.
// Core dipisah agar bisa dicache per tenant (auth/fitur tetap dicek di wrapper).
const getInventoryValuationCore = unstable_cache(
  async (tenantId: string, asOfIso: string): Promise<InventoryValuationReport> => {
    const tp = withTenant(tenantId);
    const asOf = new Date(asOfIso);
  // Lima read independen — paralel, bukan lima round-trip sekuensial.
  const [products, roasts, supplyItems, allPackaging, sampleComponents] = await Promise.all([
  tp.product.findMany({
    where: { isActive: true },
    include: {
      purchases: {
        where: {
          status: { in: ["COMPLETED", "VOID"] },
          receivedAt: { lte: asOf },
          OR: [{ voidAt: null }, { voidAt: { gt: asOf } }],
        },
        select: { weightKg: true, totalCost: true },
      },
      productionBatches: {
        where: {
          status: { in: ["COMPLETED", "VOID"] },
          producedAt: { lte: asOf },
          OR: [{ voidAt: null }, { voidAt: { gt: asOf } }],
        },
        select: { unitsProduced: true, hppPerUnit: true },
      },
      ledgerEntries: {
        where: { createdAt: { lte: asOf } },
        select: { entryType: true, quantityKg: true, quantityUnit: true },
      },
      // Untuk hitung HPP dari resep
      recipes: {
        where: { isActive: true },
        select: {
          packagingId: true,
          items: {
            select: {
              productId: true,
              gramsPerUnit: true,
            },
          },
          supplyItems: {
            select: {
              supplyItemId: true,
              quantityPerUnit: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  }),
  tp.parentRoastingBatch.findMany({
    where: {
      status: { in: ["COMPLETED", "VOID"] },
      AND: [{ OR: [{ voidAt: null }, { voidAt: { gt: asOf } }] }],
      OR: [
        { completedAt: { lte: asOf } },
        { completedAt: null, createdAt: { lte: asOf } },
      ],
    },
    select: {
      inputProductId: true,
      outputProductId: true,
      targetWeightKg: true,
      actualOutputKg: true,
    },
  }),
  tp.inventorySupplyItem.findMany({
    select: {
      id: true,
      avgCostPerUnit: true,
      costPerUnit: true,
      packaging: { select: { id: true } },
    },
  }),
  tp.packaging.findMany({
    select: { id: true, costPerUnit: true, supplyItemId: true },
  }),
  tp.sampleUsageComponent.findMany({
    where: {
      sampleUsage: { status: "COMPLETED", givenAt: { lte: asOf } },
    },
    select: {
      productId: true,
      packagingId: true,
      quantityKg: true,
      quantityUnit: true,
      unitCost: true,
    },
  }),
  ]);

  const greenBeanCost = new Map<string, number>();
  for (const product of products.filter((row) => row.type === "GREEN_BEAN")) {
    greenBeanCost.set(product.id, weightedAverageCost(product.purchases.map((purchase) => ({
      quantity: Number(purchase.weightKg ?? 0),
      totalCost: Number(purchase.totalCost),
    }))));
  }

  const roastedBeanCost = new Map<string, number>();
  for (const product of products.filter((row) => row.type === "ROASTED_BEAN")) {
    const batchesForThisRb = roasts
      .filter((roast) => roast.outputProductId === product.id)
      .map((roast) => ({
        inputProductId: roast.inputProductId,
        targetWeightKg: roast.targetWeightKg,
        actualOutputKg: roast.actualOutputKg,
      }));
    const avgCostDb = Number(product.avgCostPerKg ?? 0);
    roastedBeanCost.set(product.id, getRbCostPrioritizingCache(avgCostDb, batchesForThisRb, greenBeanCost));
  }

  // Fetch packaging data for recipe-based HPP calculation.
  // Package yang sudah dimapping ke InventorySupplyItem memakai biaya
  // canonical (avgCostPerUnit); kemasan legacy tetap memakai costPerUnit.
  const packagingMap = new Map<string, number>();
  const supplyCostMap = new Map<string, number>();
  const packagingSupplyItemByPackagingId = new Map<string, string>();
  for (const item of supplyItems) {
    const cost = Number(item.avgCostPerUnit ?? 0) || Number(item.costPerUnit ?? 0);
    supplyCostMap.set(item.id, cost);
    if (item.packaging) {
      packagingSupplyItemByPackagingId.set(item.packaging.id, item.id);
      packagingMap.set(item.packaging.id, cost);
    }
  }
  for (const pkg of allPackaging) {
    if (pkg.supplyItemId) continue; // mapped → cost canonical sudah masuk via supply item
    packagingMap.set(pkg.id, Number(pkg.costPerUnit));
  }

  const sampleWriteOffMap = new Map<string, number>();
  for (const comp of sampleComponents) {
    const key = comp.productId ?? comp.packagingId;
    if (!key) continue;
    const cost = Number(comp.unitCost) * (comp.quantityKg ? Number(comp.quantityKg) : (comp.quantityUnit ?? 0));
    sampleWriteOffMap.set(key, (sampleWriteOffMap.get(key) ?? 0) + cost);
  }

  const items: ValuationRow[] = [];

  for (const p of products) {
    if (p.type === "GREEN_BEAN" || p.type === "ROASTED_BEAN") {
      const stockKg = p.ledgerEntries.reduce((stock, entry) => {
        const quantity = Number(entry.quantityKg ?? 0);
        return stock + (entry.entryType === "IN" ? quantity : -quantity);
      }, 0);
      const unitCost = p.type === "GREEN_BEAN"
        ? greenBeanCost.get(p.id) ?? 0
        : roastedBeanCost.get(p.id) ?? 0;

      if (stockKg > 0.0005) {
        const retailPrice = p.type === "ROASTED_BEAN" ? Number(p.price || 0) : undefined;
        const potentialRevenue = p.type === "ROASTED_BEAN" ? stockKg * (retailPrice || 0) : undefined;

        items.push({
          id: p.id,
          code: p.code,
          name: p.name,
          category: p.type as "GREEN_BEAN" | "ROASTED_BEAN",
          stock: stockKg,
          unit: "kg",
          unitCost,
          totalValue: stockKg * unitCost,
          sampleWriteOff: sampleWriteOffMap.get(p.id) ?? 0,
          lowStockThreshold: lowStockThresholdFor("kg", p.safetyStockQuantity, p.reorderAlertEnabled),
          ...(p.type === "ROASTED_BEAN" && { retailPrice, potentialRevenue }),
        });
      }
    } else if (p.type === "FINISHED_GOODS") {
      const stockUnit = p.ledgerEntries.reduce((stock, entry) => {
        const quantity = Number(entry.quantityUnit ?? 0);
        return stock + (entry.entryType === "IN" ? quantity : -quantity);
      }, 0);
      // Prioritas: HPP terakhir, lalu HPP dari batch produksi terakhir, lalu fallback ke resep
      const lastHpp = p.avgCostPerKg ? Number(p.avgCostPerKg) : null;
      const lastProductionHpp = p.productionBatches[0]?.hppPerUnit ? Number(p.productionBatches[0].hppPerUnit) : null;
      const recipe = p.recipes?.[0];
      
      const unitCost = getFgHppPrioritizingCache(
        lastHpp,
        lastProductionHpp,
        recipe?.items ?? [],
        recipe?.packagingId,
        roastedBeanCost,
        packagingMap,
        0,
        undefined,
        recipe?.supplyItems as Array<{
          supplyItemId: string;
          quantityPerUnit: { toNumber(): number } | number | string;
        }>,
        supplyCostMap,
        recipe?.packagingId ? packagingSupplyItemByPackagingId.get(recipe.packagingId) : undefined,
      );
      const retailPrice = Number(p.price || 0);
      const potentialRevenue = stockUnit * retailPrice;
      
      if (stockUnit > 0) {
        items.push({
          id: p.id,
          code: p.code,
          name: p.name,
          category: "FINISHED_GOODS",
          stock: stockUnit,
          unit: "pcs",
          unitCost,
          totalValue: stockUnit * unitCost,
          sampleWriteOff: sampleWriteOffMap.get(p.id) ?? 0,
          lowStockThreshold: lowStockThresholdFor("pcs", p.safetyStockQuantity, p.reorderAlertEnabled),
          retailPrice,
          potentialRevenue,
        });
      }
    }
  }

  const packagings = await tp.packaging.findMany({
    where: { isActive: true, supplyItemId: null }, // dual-read: mapped → dinilai via InventorySupplyItem
    include: {
      purchases: {
        where: {
          status: { in: ["COMPLETED", "VOID"] },
          receivedAt: { lte: asOf },
          OR: [{ voidAt: null }, { voidAt: { gt: asOf } }],
        },
        select: { quantityUnits: true, totalCost: true },
      },
      ledgerEntries: {
        where: { createdAt: { lte: asOf } },
        select: { entryType: true, quantityUnit: true },
      },
    },
    orderBy: { name: "asc" },
  });

  for (const pkg of packagings) {
    const stockUnit = pkg.ledgerEntries.reduce((stock, entry) => {
      const quantity = Number(entry.quantityUnit ?? 0);
      return stock + (entry.entryType === "IN" ? quantity : -quantity);
    }, 0);

    if (stockUnit > 0) {
      const calculatedCost = weightedAverageCost(pkg.purchases.map((purchase) => ({
        quantity: Number(purchase.quantityUnits ?? 0),
        totalCost: Number(purchase.totalCost),
      })));
      const unitCost = calculatedCost || Number(pkg.costPerUnit);
items.push({
        id: pkg.id,
        code: pkg.code,
        name: pkg.name,
        category: "PACKAGING",
        stock: stockUnit,
        unit: "pcs",
        unitCost,
        totalValue: stockUnit * unitCost,

        sampleWriteOff: sampleWriteOffMap.get(pkg.id) ?? 0,
        lowStockThreshold: lowStockThresholdFor("pcs", pkg.safetyStockQuantity, pkg.reorderAlertEnabled),
      });
    }
  }

  // Supply items (canonical non-kopi: kemasan, bahan, merchandise, dll.)
  const supplyStockRows = await tp.inventorySupplyItem.findMany({
    where: { isActive: true },
    include: {
      purchases: {
        where: {
          status: { in: ["COMPLETED", "VOID"] },
          receivedAt: { lte: asOf },
          OR: [{ voidAt: null }, { voidAt: { gt: asOf } }],
        },
        select: { supplyQuantity: true, totalCost: true },
      },
      ledgerEntries: {
        where: { createdAt: { lte: asOf } },
        select: { entryType: true, supplyQuantity: true },
      },
    },
    orderBy: { name: "asc" },
  });

  for (const item of supplyStockRows) {
    const stock = item.ledgerEntries.reduce((stockSum, entry) => {
      const quantity = Number(entry.supplyQuantity ?? 0);
      return stockSum + (entry.entryType === "IN" ? quantity : -quantity);
    }, 0);

    if (stock > 0.0005) {
      const calculatedWac = weightedAverageCost(item.purchases.map((purchase) => ({
        quantity: Number(purchase.supplyQuantity ?? 0),
        totalCost: Number(purchase.totalCost),
      })));
      // Biaya canonical: moving average dari ledger (appendLedger); WAC pembelian
      // sebagai fallback bila avgCost belum tersedia.
      const unitCost = Number(item.avgCostPerUnit ?? 0) || calculatedWac || Number(item.costPerUnit ?? 0);
      items.push({
        id: item.id,
        code: item.code,
        name: item.name,
        category: "SUPPLY",
        stock,
        unit: item.baseUnit,
        unitCost,
        totalValue: stock * unitCost,
        sampleWriteOff: 0,
        lowStockThreshold: lowStockThresholdFor("pcs", item.safetyStockQuantity, item.reorderAlertEnabled),
      });
    }
  }

  const metrics = computeValuationMetrics(items);

  return {
    items,
    ...metrics,
    asOf: asOf.toISOString(),
    costMethod: "WEIGHTED_AVERAGE",
  };
  },
  ["inventory-valuation-v1"],
  { revalidate: 300 },
);

export async function getInventoryValuationReport(asOf = getCurrentDate()): Promise<InventoryValuationReport> {
  await requireFeature("ADVANCED_REPORTS");
  const tenantId = await getCurrentTenantId();
  return getInventoryValuationCore(tenantId, bucketIsoTo5Minutes(asOf));
}

// =============================================================================
// BALANCE SHEET (NERACA)
// =============================================================================

export type BalanceSheetReport = {
  asOf: string;
  status: "DRAFT";
  warnings: string[];
  businessName: string;
  assets: {
    cashAndBank: number;
    accountsReceivable: number;
    inventory: number;
    totalAssets: number;
  };
  liabilities: {
    accountsPayable: number;
    totalLiabilities: number;
    aging: {
      current: number;
      overdue1To30: number;
      overdue31To60: number;
      overdue61Plus: number;
    };
    trackingNote: string;
  };
  equity: {
    contributedCapital: number;
    withdrawals: number;
    retainedEarnings: number;
    distributedProfit: number;
    /** Akun bertipe EQUITY di luar kode standar 3-1000/3-1010/3-1020/3-1030. */
    otherEquity: number;
    totalEquity: number;
  };
};

export async function getBalanceSheetReport(
  inventoryValue?: number,
  asOf = getCurrentDate(),
): Promise<BalanceSheetReport> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();
  const tenantId = await getCurrentTenantId();

  const accounts = await tp.account.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, type: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const lineGroups = accountIds.length > 0
    ? await tp.journalLine.groupBy({
        by: ["accountId"],
        where: { accountId: { in: accountIds }, journalEntry: { tenantId } },
        _sum: { debit: true, credit: true },
      })
    : [];

  const balanceMap = new Map(lineGroups.map((l) => [
    l.accountId,
    { debit: Number(l._sum.debit ?? 0), credit: Number(l._sum.credit ?? 0) },
  ]));

  const saldo = (acctId: string, type: string) => {
    const b = balanceMap.get(acctId) ?? { debit: 0, credit: 0 };
    return type === "ASSET" || type === "EXPENSE" ? b.debit - b.credit : b.credit - b.debit;
  };

  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const liabilityAccounts = accounts.filter((a) => a.type === "LIABILITY");
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");

  const byCode = (code: string) => accounts.find((a) => a.code === code);
  const sumBal = (codes: string[]) => codes.reduce((s, c) => {
    const a = byCode(c);
    return s + (a ? saldo(a.id, a.type) : 0);
  }, 0);

  const cashCodes = ["1-1000", "1-1010", "1-1020"];
  const receivCodes = ["1-1100"];
  const invCodes = ["1-1200", "1-1210", "1-1220", "1-1230"];

  const cashAndBank = sumBal(cashCodes);
  const accountsReceivable = sumBal(receivCodes);
  const inventoryFromGl = sumBal(invCodes);

  let inventory = inventoryFromGl;
  if (inventoryValue !== undefined) {
    inventory = inventoryValue;
  } else if (inventoryFromGl <= 0) {
    const inventoryReport = await getInventoryValuationReport(asOf);
    inventory = inventoryReport.grandTotalValue;
  }

  const otherAssets = assetAccounts
    .filter((a) => ![...cashCodes, ...receivCodes, ...invCodes].includes(a.code))
    .reduce((s, a) => s + saldo(a.id, a.type), 0);
  const totalAssets = cashAndBank + accountsReceivable + inventory + otherAssets;

  const payableCodes = ["2-1000"];
  const accountsPayable = sumBal(payableCodes);
  const otherLiabilities = liabilityAccounts
    .filter((a) => !payableCodes.includes(a.code))
    .reduce((s, a) => s + saldo(a.id, a.type), 0);
  const totalLiabilities = accountsPayable + otherLiabilities;

  const payablePurchases = await tp.purchase.findMany({
    where: {
      status: { in: ["COMPLETED", "VOID"] },
      receivedAt: { lte: asOf },
      OR: [{ voidAt: null }, { voidAt: { gt: asOf } }],
    },
    select: {
      totalCost: true,
      dueDate: true,
      paidAmount: true,
    },
  });
  const aging: BalanceSheetReport["liabilities"]["aging"] = { current: 0, overdue1To30: 0, overdue31To60: 0, overdue61Plus: 0 };
  for (const p of payablePurchases) {
    // paidAmount sudah kumulatif (pembayaran awal + SupplierPayment + void);
    // jangan menjumlah ulang SupplierPayment — pembayaran awal embedded
    // (tanpa jurnal SUPPLIER_PAYMENT) hanya terlihat di paidAmount.
    const bal = Math.max(0, Number(p.totalCost) - Number(p.paidAmount));
    if (bal <= 0.01) continue;
    const bucket = getPayableAgingBucket(p.dueDate, asOf);
    if (bucket === "CURRENT") aging.current += bal;
    else if (bucket === "OVERDUE_1_30") aging.overdue1To30 += bal;
    else if (bucket === "OVERDUE_31_60") aging.overdue31To60 += bal;
    else aging.overdue61Plus += bal;
  }

  const contributedCapital = sumBal(["3-1000"]);
  const withdrawals = sumBal(["3-1010"]);
  const retainedEarnings = sumBal(["3-1020"]);
  const currentYearProfit = sumBal(["3-1030"]);

  const totalRevenue = revenueAccounts.reduce((s, a) => s + saldo(a.id, a.type), 0);
  const totalExpense = expenseAccounts.reduce((s, a) => s + saldo(a.id, a.type), 0);
  const netIncome = totalRevenue - totalExpense;

  // Ekuitas lain: SEMUA akun bertipe EQUITY di luar kode standar 3-1000/3-1010/
  // 3-1020/3-1030 tetap masuk neraca (mis. modal setoran tambahan dengan akun
  // kustom). Saldo normal ekuitas = kredit, sama seperti perhitungan di atas.
  const equityCodes = ["3-1000", "3-1010", "3-1020", "3-1030"];
  const equityAccounts = accounts.filter((a) => a.type === "EQUITY");
  const otherEquity = equityAccounts
    .filter((a) => !equityCodes.includes(a.code))
    .reduce((s, a) => s + saldo(a.id, a.type), 0);

  const totalEquity = contributedCapital - withdrawals + retainedEarnings + currentYearProfit + otherEquity + netIncome;

  const warnings: string[] = [];
  if (accountsReceivable > 0) warnings.push(`Piutang: ${formatRupiah(accountsReceivable)} (dari GL)`);
  if (accountsPayable > 0) warnings.push(`Hutang: ${formatRupiah(accountsPayable)} (dari GL)`);
  if (inventoryFromGl <= 0 && inventory > 0) warnings.push("Persediaan dari Inventory Valuation");
  warnings.push(`${accountIds.length} akun GL aktif, ${lineGroups.length} memiliki saldo`);

  return {
    asOf: asOf.toISOString(),
    status: "DRAFT",
    warnings,
    businessName: (await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    }))?.name?.trim() || "",
    assets: { cashAndBank, accountsReceivable, inventory, totalAssets },
    liabilities: {
      accountsPayable,
      totalLiabilities,
      aging,
      trackingNote: otherLiabilities > 0 ? `Termasuk ${formatRupiah(otherLiabilities)} kewajiban lain` : "",
    },
equity: {
    contributedCapital,
    withdrawals,
    retainedEarnings,
    distributedProfit: 0,
    otherEquity,
    totalEquity,
  },
  };
}



export type GreenBeanFlow = {
  id: string;
  name: string;
  boughtKg: number;
  roastedKg: number;
  adjustmentOutKg: number;
  currentStockKg: number;
  avgPurchasePrice: number;
};

export type RoastedBeanFlow = {
  id: string;
  name: string;
  producedKg: number;
  roastLossKg: number;
  packagedKg: number;
  adjustmentOutKg: number;
  sampleOutKg: number;
  currentStockKg: number;
  roastLossValue: number;
};

export type FinishedGoodsFlow = {
  id: string;
  name: string;
  producedUnits: number;
  /** Net terjual = SALE_FG_OUT − RETURN_FG_IN (ledger kanonik). */
  soldUnits: number;
  returnedUnits: number;
  adjustmentOutUnits: number;
  sampleOutUnits: number;
  currentStockUnits: number;
  weightPerUnitGrams: number;
  soldEquivalentKg: number;
  producedEquivalentKg: number;
  salesRevenue: number;
  cogs: number;
  grossProfit: number;
  /**
   * Estimasi biaya per unit memakai RECIPE TERBARU (biaya saat ini) —
   * HANYA untuk informasi, TIDAK dipakai dalam cogs/grossProfit yang
   * selalu memakai snapshot InvoiceItem.hpp historis (2F.2).
   */
  currentRecipeCostPerUnit: number;
};

export type CoffeeFlowReport = {
  greenBeans: GreenBeanFlow[];
  roastedBeans: RoastedBeanFlow[];
  finishedGoods: FinishedGoodsFlow[];
  periodStart: string | null;
  periodEnd: string;
};

// Coffee-flow memuat seluruh ledger < periodEnd per produk — titik termahal
// di laporan. Core dicache per tenant; wrapper tetap memvalidasi fitur & sesi.
const getCoffeeFlowCore = unstable_cache(
  async (tenantId: string, periodStartIso: string | null, periodEndIso: string): Promise<CoffeeFlowReport> => {
    const tp = withTenant(tenantId);
    const periodStart = periodStartIso ? new Date(periodStartIso) : undefined;
    const periodEnd = new Date(periodEndIso);
  const products = await tp.product.findMany({
    where: { isActive: true },
    include: {
      ledgerEntries: {
        // Stok "saat ini" = saldo ledger sampai akhir periode (2F.2):
        // entri SEBELUM periode tetap dihitung, hanya dibatasi < periodEnd.
        where: { createdAt: { lt: periodEnd } },
      },
      recipes: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          items: true,
          supplyItems: { include: { supplyItem: true } },
        },
      },
      purchases: { 
        where: { 
          status: "COMPLETED", 
          receivedAt: { 
            lt: periodEnd,
            ...(periodStart ? { gte: periodStart } : {})
          } 
        } 
      },
      invoiceItems: { 
        where: {
          invoice: {
            deliveredAt: {
              lt: periodEnd,
              ...(periodStart ? { gte: periodStart } : {})
            },
            OR: [{ voidAt: null }, { voidAt: { gt: periodEnd } }],
          }
        },
        include: {
          invoice: {
            select: {
              status: true,
              deliveredAt: true,
              voidAt: true,
              subtotal: true,
              grandTotal: true,
              returnedAmount: true,
            }
          }
        }
      },
      productionBatches: {
        where: { status: "COMPLETED" },
        orderBy: { producedAt: "desc" },
        take: 1
      }
    }
  });
  const activeSampleIds = new Set((await tp.sampleUsage.findMany({
    where: { status: "COMPLETED", givenAt: { lt: periodEnd, ...(periodStart ? { gte: periodStart } : {}) } },
    select: { id: true },
  })).map((sample) => sample.id));

  const greenBeans: GreenBeanFlow[] = [];
  const roastedBeans: RoastedBeanFlow[] = [];
  const finishedGoods: FinishedGoodsFlow[] = [];
  const inPeriod = (date: Date) => !periodStart || date >= periodStart;

  // Fetch dependencies
  const roastingBatches = await tp.parentRoastingBatch.findMany({
    where: { status: "COMPLETED", createdAt: { lt: periodEnd, ...(periodStart ? { gte: periodStart } : {}) } },
    select: { outputProductId: true, inputProductId: true, targetWeightKg: true, actualOutputKg: true },
  });

  const allPackaging = await tp.packaging.findMany({ select: { id: true, costPerUnit: true, supplyItemId: true } });
  const packagingCostMap = new Map<string, number>();
  const supplyCostMap = new Map<string, number>();
  const packagingSupplyItemByPackagingId = new Map<string, string>();
  for (const item of await tp.inventorySupplyItem.findMany({
    select: { id: true, avgCostPerUnit: true, costPerUnit: true, packaging: { select: { id: true } } },
  })) {
    const cost = Number(item.avgCostPerUnit ?? 0) || Number(item.costPerUnit ?? 0);
    supplyCostMap.set(item.id, cost);
    if (item.packaging) {
      packagingSupplyItemByPackagingId.set(item.packaging.id, item.id);
      packagingCostMap.set(item.packaging.id, cost);
    }
  }
  for (const pkg of allPackaging) {
    if (pkg.supplyItemId) continue; // mapped → cost canonical via supply item
    packagingCostMap.set(pkg.id, Number(pkg.costPerUnit));
  }

  // Compute greenBeanCostMap
  const greenBeanCostMap = new Map<string, number>();
  for (const p of products) {
    if (p.type === "GREEN_BEAN") {
      let totalPurCost = 0; let totalPurKg = 0;
      for (const pur of p.purchases) {
        totalPurCost += Number(pur.totalCost);
        totalPurKg += Number(pur.weightKg);
      }
      greenBeanCostMap.set(p.id, totalPurKg > 0 ? totalPurCost / totalPurKg : 0);
    }
  }

  // Compute roastedBeanCostMap
  const roastedBeanCostMap = new Map<string, number>();
  for (const p of products) {
    if (p.type === "ROASTED_BEAN") {
      const batchesForThisRb = roastingBatches
        .filter((roast) => roast.outputProductId === p.id)
        .map((roast) => ({
          inputProductId: roast.inputProductId,
          targetWeightKg: roast.targetWeightKg,
          actualOutputKg: roast.actualOutputKg,
        }));
      const avgCostDb = Number(p.avgCostPerKg ?? 0);
      roastedBeanCostMap.set(p.id, getRbCostPrioritizingCache(avgCostDb, batchesForThisRb, greenBeanCostMap));
    }
  }

  // Compute recipeHppMap
  const recipeHppMap = new Map<string, number>();
  for (const p of products) {
    if (p.type === "FINISHED_GOODS" && p.recipes.length > 0) {
      const lastHpp = p.avgCostPerKg ? Number(p.avgCostPerKg) : null;
      const lastProductionHpp = p.productionBatches[0]?.hppPerUnit ? Number(p.productionBatches[0].hppPerUnit) : null;
      const recipe = p.recipes[0];
      
      const cost = getFgHppPrioritizingCache(
        lastHpp,
        lastProductionHpp,
        recipe.items ?? [],
        recipe.packagingId,
        roastedBeanCostMap,
        packagingCostMap,
        0,
        undefined,
        recipe.supplyItems.map((item) => ({
          supplyItemId: item.supplyItemId,
          quantityPerUnit: Number(item.quantityPerUnit),
        })),
        supplyCostMap,
        recipe.packagingId ? packagingSupplyItemByPackagingId.get(recipe.packagingId) : undefined,
      );
      if (cost > 0) recipeHppMap.set(p.id, cost);
    }
  }

  for (const p of products) {
    if (p.type === "GREEN_BEAN") {
      let bought = 0, roasted = 0, adjOut = 0, stock = 0;
      for (const l of p.ledgerEntries) {
        const qty = Number(l.quantityKg || 0);
        if (l.entryType === "IN") stock += qty; else stock -= qty;
        if (!inPeriod(l.createdAt)) continue;
        if (l.refType === "PURCHASE_GB" && l.entryType === "IN") bought += qty;
        if (l.refType === "ROASTING_GB_OUT" && l.entryType === "OUT") roasted += qty;
        if (l.refType === "ADJUSTMENT_OUT" && l.entryType === "OUT") adjOut += qty;
      }
      
      let totalPurCost = 0; let totalPurKg = 0;
      for (const pur of p.purchases) {
        totalPurCost += Number(pur.totalCost);
        totalPurKg += Number(pur.weightKg);
      }
      const avgPurchasePrice = totalPurKg > 0 ? totalPurCost / totalPurKg : 0;

      greenBeans.push({
        id: p.id, name: p.name, boughtKg: bought, roastedKg: roasted, adjustmentOutKg: adjOut, currentStockKg: stock,
        avgPurchasePrice
      });
    } else if (p.type === "ROASTED_BEAN") {
      let produced = 0, packaged = 0, adjOut = 0, sampleOut = 0, stock = 0;
      for (const l of p.ledgerEntries) {
        const qty = Number(l.quantityKg || 0);
        if (l.entryType === "IN") stock += qty; else stock -= qty;
        if (!inPeriod(l.createdAt)) continue;
        if (l.refType === "ROASTING_RB_IN" && l.entryType === "IN") produced += qty;
        if (l.refType === "PRODUCTION_RB_OUT" && l.entryType === "OUT") packaged += qty;
        if (l.refType === "ADJUSTMENT_OUT" && l.entryType === "OUT") adjOut += qty;
        if (l.refType === "SAMPLE_RB_OUT" && l.entryType === "OUT" && activeSampleIds.has(l.refId)) sampleOut += qty;
      }
      
      roastedBeans.push({
        id: p.id, name: p.name, producedKg: produced, roastLossKg: 0, packagedKg: packaged, adjustmentOutKg: adjOut, sampleOutKg: sampleOut, currentStockKg: stock,
        roastLossValue: 0
      });
    } else if (p.type === "FINISHED_GOODS") {
      let producedU = 0, soldU = 0, returnedU = 0, adjOutU = 0, sampleOutU = 0, stockU = 0;
      for (const l of p.ledgerEntries) {
        const qty = Number(l.quantityUnit || 0);
        if (l.entryType === "IN") stockU += qty; else stockU -= qty;
        if (!inPeriod(l.createdAt)) continue;
        if (l.refType === "PRODUCTION_FG_IN" && l.entryType === "IN") producedU += qty;
        if (l.refType === "SALE_FG_OUT" && l.entryType === "OUT") soldU += qty;
        if (l.refType === "RETURN_FG_IN" && l.entryType === "IN") returnedU += qty;
        if (l.refType === "ADJUSTMENT_OUT" && l.entryType === "OUT") adjOutU += qty;
        if (l.refType === "SAMPLE_FG_OUT" && l.entryType === "OUT" && activeSampleIds.has(l.refId)) sampleOutU += qty;
      }

      // Pendapatan & COGS HISTORIS: hanya nota DISERAHKAN dalam periode,
      // net retur proporsional per nota, HPP dari snapshot InvoiceItem.hpp.
      const { revenue, cogs } = computeCoffeeFlowSales(p.invoiceItems.map((item) => ({
        quantity: Number(item.quantity),
        subtotal: Number(item.subtotal),
        hpp: Number(item.hpp),
        invoice: {
          deliveredAt: item.invoice.deliveredAt,
          status: item.invoice.status,
          voidAt: item.invoice.voidAt,
          subtotal: Number(item.invoice.subtotal),
          grandTotal: Number(item.invoice.grandTotal),
          returnedAmount: Number(item.invoice.returnedAmount ?? 0),
        },
      })));
      const salesRevenue = revenue;
      const grossProfit = salesRevenue - cogs;

      const weightGrams = p.recipes.length > 0 ? Number(p.recipes[0].outputGrams) : 0;
      finishedGoods.push({
        id: p.id, name: p.name, producedUnits: producedU, soldUnits: soldU, returnedUnits: returnedU, adjustmentOutUnits: adjOutU, sampleOutUnits: sampleOutU, currentStockUnits: stockU,
        weightPerUnitGrams: weightGrams,
        soldEquivalentKg: (soldU - returnedU) * weightGrams / 1000,
        producedEquivalentKg: (producedU * weightGrams) / 1000,
        salesRevenue, cogs, grossProfit,
        currentRecipeCostPerUnit: recipeHppMap.get(p.id) ?? 0,
      });
    }
  }


  
  for (const rb of roastedBeans) {
    const batches = roastingBatches.filter(b => b.outputProductId === rb.id);
    let totalInput = 0;
    let totalOutput = 0;
    let totalLossValue = 0;
    for (const b of batches) {
      const inW = Number(b.targetWeightKg);
      const outW = Number(b.actualOutputKg);
      totalInput += inW;
      totalOutput += outW;
      const lossKg = inW - outW;
      const gbPrice = greenBeans.find(gb => gb.id === b.inputProductId)?.avgPurchasePrice || 0;
      totalLossValue += lossKg * gbPrice;
    }
    rb.roastLossKg = totalInput - totalOutput;
    rb.roastLossValue = totalLossValue;
  }

  return {
    greenBeans,
    roastedBeans,
    finishedGoods,
    periodStart: periodStart?.toISOString() ?? null,
    periodEnd: periodEnd.toISOString(),
  };
  },
  ["coffee-flow-v1"],
  { revalidate: 300 },
);

export async function getCoffeeFlowReport(
  periodStart?: Date,
  periodEnd = getCurrentDate(),
): Promise<CoffeeFlowReport> {
  await requireFeature("ADVANCED_REPORTS");
  const tenantId = await getCurrentTenantId();
  return getCoffeeFlowCore(
    tenantId,
    periodStart ? bucketIsoTo5Minutes(periodStart) : null,
    bucketIsoTo5Minutes(periodEnd),
  );
}

// =============================================================================
// SAMPLE USAGE REPORT
// =============================================================================

export type SampleReport = {
  totalSamples: number;
  totalCost: number;
  totalGrams: number;
  bySourceType: { source: string; count: number; cost: number; grams: number }[];
  byProduct: { productName: string; quantityKg: number; quantityUnit: number; cost: number }[];
  topRecipients: { recipient: string; count: number; cost: number }[];
  monthlyTrend: { month: string; count: number; cost: number }[];
};

export async function getSampleReport(
  periodStart?: Date,
  periodEnd = getCurrentDate(),
): Promise<SampleReport> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();

  const samples = await tp.sampleUsage.findMany({
    where: {
      status: "COMPLETED",
      givenAt: { lt: periodEnd, ...(periodStart ? { gte: periodStart } : {}) },
    },
    select: {
      id: true,
      sourceType: true,
      sourceLabel: true,
      packCount: true,
      totalGrams: true,
      totalCost: true,
      recipient: true,
      givenAt: true,
      components: {
        select: {
          label: true,
          quantityKg: true,
          quantityUnit: true,
          unitCost: true,
          totalCost: true,
          product: { select: { name: true, type: true } },
          packaging: { select: { name: true } },
        },
      },
    },
    orderBy: { givenAt: "desc" },
  });

  // Aggregate by source type
  const sourceTypeMap = new Map<string, { count: number; cost: number; grams: number }>();
  for (const s of samples) {
    const key = s.sourceType;
    const entry = sourceTypeMap.get(key) ?? { count: 0, cost: 0, grams: 0 };
    entry.count += s.packCount;
    entry.cost += Number(s.totalCost);
    entry.grams += Number(s.totalGrams);
    sourceTypeMap.set(key, entry);
  }
  const bySourceType = Array.from(sourceTypeMap.entries()).map(([source, data]) => ({
    source,
    ...data,
  }));

  // Aggregate by product
  const productMap = new Map<string, { quantityKg: number; quantityUnit: number; cost: number }>();
  for (const s of samples) {
    for (const comp of s.components) {
      const name = comp.product?.name ?? comp.packaging?.name ?? comp.label;
      const entry = productMap.get(name) ?? { quantityKg: 0, quantityUnit: 0, cost: 0 };
      entry.quantityKg += comp.quantityKg ? Number(comp.quantityKg) : 0;
      entry.quantityUnit += comp.quantityUnit ?? 0;
      entry.cost += Number(comp.totalCost);
      productMap.set(name, entry);
    }
  }
  const byProduct = Array.from(productMap.entries())
    .map(([productName, data]) => ({ productName, ...data }))
    .sort((a, b) => b.cost - a.cost);

  // Top recipients
  const recipientMap = new Map<string, { count: number; cost: number }>();
  for (const s of samples) {
    const name = s.recipient?.trim() || "Tidak disebutkan";
    const entry = recipientMap.get(name) ?? { count: 0, cost: 0 };
    entry.count += 1;
    entry.cost += Number(s.totalCost);
    recipientMap.set(name, entry);
  }
  const topRecipients = Array.from(recipientMap.entries())
    .map(([recipient, data]) => ({ recipient, ...data }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  // Monthly trend (last 6 months)
  const monthlyTrend: { month: string; count: number; cost: number }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const label = new Intl.DateTimeFormat("id-ID", { month: "short", year: "2-digit" }).format(d);
    const monthSamples = samples.filter(
      (s) => s.givenAt >= d && s.givenAt < nextMonth,
    );
    monthlyTrend.push({
      month: label,
      count: monthSamples.reduce((sum, s) => sum + s.packCount, 0),
      cost: monthSamples.reduce((sum, s) => sum + Number(s.totalCost), 0),
    });
  }

  return {
    totalSamples: samples.length,
    totalCost: samples.reduce((sum, s) => sum + Number(s.totalCost), 0),
    totalGrams: samples.reduce((sum, s) => sum + Number(s.totalGrams), 0),
    bySourceType,
    byProduct,
    topRecipients,
    monthlyTrend,
  };
}

// =============================================================================
// SALES REPORT
// =============================================================================

export type ProductProfitability = {
  productId: string;
  name: string;
  quantity: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  margin: number;
};

export type ReturnsAnalytics = {
  totalReturned: number;
  /** % nilai diretur terhadap pendapatan bersih periode. */
  returnPercent: number;
  returnedInvoiceCount: number;
  topReturnedProducts: { name: string; quantity: number; value: number }[];
  topReasons: { reason: string; count: number; total: number }[];
  topCustomers: { name: string; count: number; total: number }[];
};

export type SalesReportData = {
  totalRevenue: number;
  invoiceCount: number;
  avgInvoice: number;
  topCustomer: string;
  revenueTrend: { date: string; revenue: number }[];
  salesByProduct: { name: string; value: number }[];
  productProfitability: ProductProfitability[];
  returns: ReturnsAnalytics;
  detailLimit: number;
  detailTruncated: boolean;
  invoices: {
    id: string;
    code: string;
    date: string;
    customer: string;
    amount: number;
    status: string;
  }[];
};

export async function getSalesReport(startDate: string, endDate: string): Promise<SalesReportData> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();
  const tenantId = await getCurrentTenantId();

  // Get tenant timezone for correct date handling
  const timezone = await getTenantTimezone();

  // Convert date strings to UTC range using tenant timezone
  const { start: startUTC, end: endUTC } = dateToLocalRange(endDate, timezone);
  // Use start of startDate for the lower bound
  const { start: rangeStartUTC } = dateToLocalRange(startDate, timezone);

// Basis pendapatan konsisten: invoice yang SUDAH DISERAHKAN (deliveredAt)
// dan belum di-void dalam periode — pendapatan diakui saat penyerahan.
  const reportWhere = {
    deliveredAt: { gte: rangeStartUTC, lte: endUTC },
    OR: [{ voidAt: null }, { voidAt: { gt: endUTC } }],
  } satisfies Prisma.InvoiceWhereInput;
  const detailLimit = 500;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const chartDayCount = Math.max(1, Math.min(daysDiff + 1, 30));
  const chartDays = buildChartDaysFrom(startDate, chartDayCount, timezone);

  type ProductSalesRow = { name: string; value: string };
  type TopCustomerRow = { name: string };
  type ProductProfitRow = { productId: string; name: string; quantity: number; revenue: string; cogs: string };
  type ReturnAggRow = { count: number; total: string };
  type ReturnProductRow = { name: string; quantity: number; value: string };
  type ReturnReasonRow = { reason: string; count: number; total: string };
  type ReturnCustomerRow = { name: string; count: number; total: string };
  const [paidTotal, invoiceCount, topCustomers, invoices, dailyTotals, productSales, productProfitabilityRaw, returnsAgg, returnProducts, returnReasons, returnCustomers] = await Promise.all([
    tp.invoice.aggregate({
      where: reportWhere,
      _sum: { grandTotal: true, returnedAmount: true },
    }),
    tp.invoice.count({ where: reportWhere }),
    tenantQuery<TopCustomerRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT c.name
      FROM invoices i
      JOIN customers c ON c.id = i."customerId"
      WHERE i."tenantId" = ${t}
        AND c."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY c.id, c.name
      ORDER BY SUM(i."grandTotal") DESC
      LIMIT 10
    `),
    tp.invoice.findMany({
      where: reportWhere,
      select: {
        id: true,
        code: true,
        issuedAt: true,
        grandTotal: true,
        status: true,
        customer: { select: { name: true } },
      },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: detailLimit,
    }),
    getDailyFinancialTotals({
      tenantId,
      timezone,
      start: chartDays[0].start,
      end: chartDays.at(-1)!.end,
    }),
    tenantQuery<ProductSalesRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        COALESCE(p.category::text, 'OTHER') AS name,
        COALESCE(SUM(ii.subtotal), 0)::text AS value
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii."invoiceId"
      JOIN products p ON p.id = ii."productId"
      WHERE i."tenantId" = ${t}
        AND ii."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY p.category
      ORDER BY SUM(ii.subtotal) DESC
    `),
    // Profitabilitas per produk: HPP HISTORIS dari snapshot InvoiceItem.hpp,
    // diskon & retur dialokasikan proporsional per nota (faktor neto).
    tenantQuery<ProductProfitRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        p.id AS "productId",
        p.name,
        COALESCE(SUM(ii.quantity), 0)::int AS quantity,
        COALESCE(SUM(ii.subtotal * net."netFactor"), 0)::text AS revenue,
        COALESCE(SUM(ii."hpp" * ii.quantity * net."netFactor"), 0)::text AS cogs
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii."invoiceId"
      JOIN products p ON p.id = ii."productId"
      JOIN (
        SELECT id,
          GREATEST("grandTotal" - COALESCE("returnedAmount", 0), 0)
            / NULLIF(subtotal, 0) AS "netFactor"
        FROM invoices
      ) net ON net.id = i.id
      WHERE i."tenantId" = ${t}
        AND ii."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY p.id, p.name
      ORDER BY revenue DESC
    `),
    // Analitik retur: CreditNote (retur PENJUALAN) terbit untuk nota
    // yang diserahkan dalam periode.
    tenantQuery<ReturnAggRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT cn."invoiceId")::int AS count,
        COALESCE(SUM(cn.total), 0)::text AS total
      FROM credit_notes cn
      JOIN invoices i ON i.id = cn."invoiceId"
      WHERE cn."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
    `),
    tenantQuery<ReturnProductRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        p.name,
        COALESCE(SUM(cni.quantity), 0)::int AS quantity,
        COALESCE(SUM(cni.subtotal), 0)::text AS value
      FROM credit_note_items cni
      JOIN credit_notes cn ON cn.id = cni."creditNoteId"
      JOIN invoices i ON i.id = cn."invoiceId"
      JOIN products p ON p.id = cni."productId"
      WHERE cn."tenantId" = ${t}
        AND cni."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY p.name
      ORDER BY quantity DESC
      LIMIT 10
    `),
    tenantQuery<ReturnReasonRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        cn.reason,
        COUNT(*)::int AS count,
        COALESCE(SUM(cn.total), 0)::text AS total
      FROM credit_notes cn
      JOIN invoices i ON i.id = cn."invoiceId"
      WHERE cn."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY cn.reason
      ORDER BY total DESC
      LIMIT 10
    `),
    tenantQuery<ReturnCustomerRow[]>(tenantId, async (t) => prisma.$queryRaw`
      SELECT
        c.name,
        COUNT(DISTINCT cn.id)::int AS count,
        COALESCE(SUM(cn.total), 0)::text AS total
      FROM credit_notes cn
      JOIN invoices i ON i.id = cn."invoiceId"
      JOIN customers c ON c.id = i."customerId"
      WHERE cn."tenantId" = ${t}
        AND c."tenantId" = ${t}
        AND i."deliveredAt" >= ${rangeStartUTC}
        AND i."deliveredAt" <= ${endUTC}
        AND (i."voidAt" IS NULL OR i."voidAt" > ${endUTC})
      GROUP BY c.id, c.name
      ORDER BY total DESC
      LIMIT 10
    `),
  ]);

const totalRevenue = computeRevenue([
    { grandTotal: paidTotal._sum.grandTotal, returnedAmount: paidTotal._sum.returnedAmount },
  ]);
  const avgInvoice = computeAverageInvoice(totalRevenue, invoiceCount);

  const topCustomer = topCustomers[0]?.name ?? "-";
  const revenueTrend = chartDays.map((day) => ({
    date: day.label,
    revenue: dailyTotals.get(day.dateKey)?.revenue ?? 0,
  }));
  const salesByProduct = productSales.map((row) => ({
    name: row.name,
    value: Number(row.value),
  }));
  const productProfitability: ProductProfitability[] = productProfitabilityRaw.map((row) => {
    const revenue = Number(row.revenue);
    const cogs = Number(row.cogs);
    return {
      productId: row.productId,
      name: row.name,
      quantity: Number(row.quantity),
      revenue,
      cogs,
      grossProfit: revenue - cogs,
      margin: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0,
    };
  });
  const totalReturned = Number(returnsAgg[0]?.total ?? 0);
  const returns: ReturnsAnalytics = {
    totalReturned,
    returnPercent: totalRevenue > 0 ? (totalReturned / totalRevenue) * 100 : 0,
    returnedInvoiceCount: Number(returnsAgg[0]?.count ?? 0),
    topReturnedProducts: returnProducts.map((row) => ({
      name: row.name,
      quantity: Number(row.quantity),
      value: Number(row.value),
    })),
    topReasons: returnReasons.map((row) => ({
      reason: row.reason,
      count: Number(row.count),
      total: Number(row.total),
    })),
    topCustomers: returnCustomers.map((row) => ({
      name: row.name,
      count: Number(row.count),
      total: Number(row.total),
    })),
  };

  return {
    totalRevenue,
    invoiceCount,
    avgInvoice,
    topCustomer,
    revenueTrend,
    salesByProduct,
    productProfitability,
    returns,
    detailLimit,
    detailTruncated: invoiceCount > detailLimit,
    invoices: invoices.map((i) => ({
      id: i.id,
      code: i.code,
      date: i.issuedAt.toISOString(),
      customer: i.customer.name,
      amount: Number(i.grandTotal),
      status: i.status,
    })),
  };
}

// =============================================================================
// EXPENSE REPORT
// =============================================================================

export type ExpenseReportData = {
  totalExpenses: number;
  totalPurchases: number;
  outstandingPayable: number;
  profit: number;
  expenseTrend: { date: string; expenses: number }[];
  expensesByCategory: { name: string; value: number }[];
  expenses: {
    id: string;
    date: string;
    category: string;
    description: string;
    amount: number;
    status: string;
  }[];
};

export async function getExpenseReport(startDate: string, endDate: string): Promise<ExpenseReportData> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();

  // Get tenant timezone for correct date handling
  const timezone = await getTenantTimezone();

  // Convert date strings to UTC range using tenant timezone
  const { start: rangeStartUTC, end: rangeEndUTC } = dateToLocalRange(endDate, timezone);
  const { start: rangeStartOnly } = dateToLocalRange(startDate, timezone);

  const [expenses, purchases] = await Promise.all([
    tp.expense.findMany({
      where: {
        date: { gte: rangeStartOnly, lte: rangeEndUTC },
        OR: [{ voidAt: null }, { voidAt: { gt: rangeEndUTC } }],
      },
      orderBy: { date: "desc" },
    }),
    tp.purchase.findMany({
      where: {
        receivedAt: { gte: rangeStartOnly, lte: rangeEndUTC },
        OR: [
          { status: "COMPLETED" },
          { status: "VOID", voidAt: { gt: rangeEndUTC } },
        ],
      },
      select: {
        totalCost: true,
        paidAmount: true,
        voidAt: true,
        receivedAt: true,
        code: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.totalCost), 0);
  // Hutang per pembelian = total biaya − total yang sudah dibayar (paidAmount
  // sudah kumulatif: pembayaran awal saat penerimaan + SupplierPayment + void).
  const outstandingPayable = purchases.reduce(
    (sum, p) => sum + Math.max(0, Number(p.totalCost) - Number(p.paidAmount)),
    0,
  );

  // Get revenue for profit calculation (basis penyerahan)
  const invoices = await tp.invoice.findMany({
    where: {
      deliveredAt: { gte: rangeStartOnly, lte: rangeEndUTC },
      OR: [{ voidAt: null }, { voidAt: { gt: rangeEndUTC } }],
    },
  });
  const totalRevenue = invoices.reduce((sum, i) => sum + Number(i.grandTotal) - Number(i.returnedAmount), 0);
  // Net profit konsisten: Revenue - Expenses - Purchases.
  const profit = computeNetProfit({
    revenue: totalRevenue,
    expenses: totalExpenses,
    purchases: totalPurchases,
  });

  // Expense trend (based on date range) using tenant timezone
  const expenseTrend: { date: string; expenses: number }[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const chartDays = Math.min(daysDiff + 1, 30);

  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() + (chartDays - 1 - i));
    const dayStr = formatChartDate(d, timezone);
    const dayExpenses = expenses.filter(
      (e) => formatChartDate(e.date, timezone) === dayStr
    );
    expenseTrend.push({
      date: dayStr,
      expenses: dayExpenses.reduce((sum, e) => sum + Number(e.amount), 0),
    });
  }

  // Expenses by category
  const categoryMap = new Map<string, number>();
  expenses.forEach((e) => {
    categoryMap.set(e.category, (categoryMap.get(e.category) || 0) + Number(e.amount));
  });
  const expensesByCategory = Array.from(categoryMap.entries()).map(([name, value]) => ({ name, value }));

  return {
    totalExpenses,
    totalPurchases,
    outstandingPayable,
    profit,
    expenseTrend,
    expensesByCategory,
    expenses: expenses.map((e) => ({
      id: e.id,
      date: e.date.toISOString(),
      category: e.category,
      description: e.description || "-",
      amount: Number(e.amount),
      status: e.voidAt ? "Dibatal" : "Tercatat",
    })),
  };
}

// =============================================================================
// ROASTING REPORT
// =============================================================================

export type RoastingReportData = {
  totalBatches: number;
  totalGbUsed: number;
  totalRbProduced: number;
  avgYield: number;
  lossPercent: number;
  totalLossKg: number;
  yieldTrend: { date: string; yield: number }[];
  batches: {
    id: string;
    date: string;
    gbInput: number;
    rbOutput: number;
    yield: number;
    machine: string;
  }[];
};

export async function getRoastingReport(startDate: string, endDate: string): Promise<RoastingReportData> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();

  // Get tenant timezone for correct date handling
  const timezone = await getTenantTimezone();

  // Convert date strings to UTC range using tenant timezone
  const { start: rangeStartUTC, end: rangeEndUTC } = dateToLocalRange(endDate, timezone);
  const { start: rangeStartOnly } = dateToLocalRange(startDate, timezone);

  const batches = await tp.parentRoastingBatch.findMany({
    where: {
      completedAt: { gte: rangeStartOnly, lte: rangeEndUTC },
      status: { in: ["COMPLETED", "VOID"] },
      OR: [{ voidAt: null }, { voidAt: { gt: rangeEndUTC } }],
    },
    include: {
      inputProduct: { select: { name: true } },
      outputProduct: { select: { name: true } },
    },
    orderBy: { completedAt: "desc" },
  });

  // Fetch machine names separately
  const machineIds = batches.map((b) => b.machineId).filter((id): id is string => id !== null);
  const machines = await tp.machine.findMany({
    where: { id: { in: machineIds } },
    select: { id: true, name: true },
  });
  const machineMap = new Map(machines.map((m) => [m.id, m.name]));

  const totalBatches = batches.length;
  const totalGbUsed = batches.reduce((sum, b) => sum + Number(b.targetWeightKg), 0);
  const totalRbProduced = batches.reduce((sum, b) => sum + Number(b.actualOutputKg || 0), 0);
  const avgYield = totalGbUsed > 0 ? (totalRbProduced / totalGbUsed) * 100 : 0;
  const lossPercent = 100 - avgYield;

  // Yield trend (based on date range) using tenant timezone
  const yieldTrend: { date: string; yield: number }[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const chartDays = Math.min(daysDiff + 1, 30);

  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() + (chartDays - 1 - i));
    const dayStr = formatChartDate(d, timezone);
    const dayBatches = batches.filter(
      (b) => formatChartDate(b.completedAt || b.createdAt, timezone) === dayStr
    );
    const dayGb = dayBatches.reduce((sum, b) => sum + Number(b.targetWeightKg), 0);
    const dayRb = dayBatches.reduce((sum, b) => sum + Number(b.actualOutputKg || 0), 0);
    yieldTrend.push({
      date: dayStr,
      yield: dayGb > 0 ? (dayRb / dayGb) * 100 : 0,
    });
  }

  return {
    totalBatches,
    totalGbUsed,
    totalRbProduced,
    avgYield,
    lossPercent,
    totalLossKg: Math.max(0, totalGbUsed - totalRbProduced),
    yieldTrend,
    batches: batches.map((b) => ({
      id: b.id,
      date: (b.completedAt || b.createdAt).toISOString(),
      gbInput: Number(b.targetWeightKg),
      rbOutput: Number(b.actualOutputKg || 0),
      yield: Number(b.targetWeightKg) > 0
        ? (Number(b.actualOutputKg || 0) / Number(b.targetWeightKg)) * 100
        : 0,
      machine: b.machineId ? (machineMap.get(b.machineId) || "-") : "-",
    })),
  };
}

// =============================================================================
// PRODUCTION REPORT
// =============================================================================

export type ProductionReportData = {
  totalBatches: number;
  totalRbUsed: number;
  totalFgProduced: number;
  totalFgKg: number;
  totalPackagingUsed: number;
  efficiency: number;
  productionTrend: { date: string; units: number }[];
  batches: {
    id: string;
    date: string;
    sku: string;
    rbUsed: number;
    fgOutput: number;
    recipe: string;
    status: string;
  }[];
};

export async function getProductionReport(startDate: string, endDate: string): Promise<ProductionReportData> {
  await requireFeature("ADVANCED_REPORTS");
  const tp = await requireTenantPrisma();

  // Get tenant timezone for correct date handling
  const timezone = await getTenantTimezone();

  // Convert date strings to UTC range using tenant timezone
  const { start: rangeStartUTC, end: rangeEndUTC } = dateToLocalRange(endDate, timezone);
  const { start: rangeStartOnly } = dateToLocalRange(startDate, timezone);

  const batches = await tp.productionBatch.findMany({
    where: {
      producedAt: { gte: rangeStartOnly, lte: rangeEndUTC },
      status: { in: ["COMPLETED", "VOID"] },
      OR: [{ voidAt: null }, { voidAt: { gt: rangeEndUTC } }],
    },
    include: {
      outputProduct: { select: { name: true } },
      recipe: { select: { name: true, outputGrams: true } },
    },
    orderBy: { producedAt: "desc" },
  });

  const totalBatches = batches.length;
  const totalRbUsed = batches.reduce((sum, b) => sum + Number(b.totalRbUsedKg), 0);
  const totalFgProduced = batches.reduce((sum, b) => sum + b.unitsProduced, 0);
  const totalPackagingUsed = batches.reduce((sum, b) => sum + b.unitsProduced, 0); // 1:1 with FG

  // Hasil bahan dari resep: kg produk jadi ÷ kg bahan × 100.
  // Berbasis berat per unit outputsGrams -> hanya akurat bila resep punya berat.
  const totalFgKg = batches.reduce((sum, b) => {
    const grams = Number(b.recipe?.outputGrams ?? 0);
    return sum + (grams > 0 ? (b.unitsProduced * grams) / 1000 : 0);
  }, 0);
  const efficiency = totalRbUsed > 0 ? (totalFgKg / totalRbUsed) * 100 : 0;

  // Production trend (based on date range) using tenant timezone
  const productionTrend: { date: string; units: number }[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const chartDays = Math.min(daysDiff + 1, 30);

  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() + (chartDays - 1 - i));
    const dayStr = formatChartDate(d, timezone);
    const dayBatches = batches.filter(
      (b) => formatChartDate(b.producedAt || b.createdAt, timezone) === dayStr
    );
    productionTrend.push({
      date: dayStr,
      units: dayBatches.reduce((sum, b) => sum + b.unitsProduced, 0),
    });
  }

  return {
    totalBatches,
    totalRbUsed,
    totalFgProduced,
    totalFgKg,
    totalPackagingUsed,
    efficiency,
    productionTrend,
    batches: batches.map((b) => ({
      id: b.id,
      date: (b.producedAt || b.createdAt).toISOString(),
      sku: b.outputProduct?.name || "-",
      rbUsed: Number(b.totalRbUsedKg),
      fgOutput: b.unitsProduced,
      recipe: b.recipe?.name || "-",
      status: b.status,
    })),
  };
}

// =============================================================================
// KEUANGAN OVERVIEW REPORT
// =============================================================================

export type KeuanganOverviewData = {
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  cashFlow: number;
  /** Persen vs periode sebelumnya; `null` bila periode sebelumnya nol/tidak terbandingkan. */
  revenueTrend: number | null;
  expensesTrend: number | null;
  profitTrend: number | null;
  cashFlowTrend: number | null;
  revenueVsExpensesChart: { date: string; revenue: number; expenses: number }[];
  expenseByCategory: { name: string; value: number }[];
};

export async function getKeuanganOverview(startDate?: string, endDate?: string): Promise<KeuanganOverviewData> {
  await requireFeature("ADVANCED_REPORTS");

  const now = new Date();
  const timezone = await getTenantTimezone();

  // Use tenant timezone for date ranges
  const startStr = startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endStr = endDate || getTodayStringForTimezone(timezone);

  const { start: rangeStart } = dateToLocalRange(startStr, timezone);
  const { end: rangeEnd } = dateToLocalRange(endStr, timezone);

  const tp = await requireTenantPrisma();
  const tenantId = await getCurrentTenantId();

  const periodLength = rangeEnd.getTime() - rangeStart.getTime();
  const prevStart = new Date(rangeStart.getTime() - periodLength);
  const prevEnd = new Date(rangeStart.getTime() - 1);

  const daysDiff = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24));
  const chartDayCount = Math.max(1, Math.min(daysDiff + 1, 30));
  const chartDays = buildChartDaysFrom(startStr, chartDayCount, timezone);

  // Aggregate in PostgreSQL instead of loading every invoice/expense into Node.
  const deliveredWhere = (from: Date, to: Date) => ({
    deliveredAt: { gte: from, lte: to },
    OR: [{ voidAt: null }, { voidAt: { gt: to } }],
  });
const [invoiceTotal, expenseGroups, prevInvoiceTotal, prevExpenseTotal, purchaseTotal, prevPurchaseTotal, dailyTotals, cashMovement, prevCashMovement] = await Promise.all([
    tp.invoice.aggregate({
      where: deliveredWhere(rangeStart, rangeEnd),
      _sum: { grandTotal: true, returnedAmount: true },
    }),
    tp.expense.groupBy({
      by: ["category"],
      where: {
        date: { gte: rangeStart, lte: rangeEnd },
        voidAt: null,
      },
      _sum: { amount: true },
    }),
    tp.invoice.aggregate({
      where: deliveredWhere(prevStart, prevEnd),
      _sum: { grandTotal: true, returnedAmount: true },
    }),
    tp.expense.aggregate({
      where: { date: { gte: prevStart, lte: prevEnd }, voidAt: null },
      _sum: { amount: true },
    }),
    tp.purchase.aggregate({
      where: {
        receivedAt: { gte: rangeStart, lte: rangeEnd },
        OR: [
          { status: "COMPLETED" },
          { status: "VOID", voidAt: { gt: rangeEnd } },
        ],
      },
      _sum: { totalCost: true },
    }),
    tp.purchase.aggregate({
      where: {
        receivedAt: { gte: prevStart, lte: prevEnd },
        OR: [
          { status: "COMPLETED" },
          { status: "VOID", voidAt: { gt: prevEnd } },
        ],
      },
      _sum: { totalCost: true },
    }),
    getDailyFinancialTotals({
      tenantId,
      timezone,
      start: chartDays[0].start,
      end: chartDays.at(-1)!.end,
    }),
    computeCashMovement({ tp, tenantId, start: rangeStart, end: rangeEnd }),
    computeCashMovement({ tp, tenantId, start: prevStart, end: prevEnd }),
  ]);

const totalRevenue = Number(invoiceTotal._sum.grandTotal ?? 0) - Number(invoiceTotal._sum.returnedAmount ?? 0);
  const totalExpenses = expenseGroups.reduce(
    (sum, group) => sum + Number(group._sum.amount ?? 0),
    0,
  );
  const totalPurchases = Number(purchaseTotal._sum.totalCost ?? 0);

  const lastRevenue = Number(prevInvoiceTotal._sum.grandTotal ?? 0) - Number(prevInvoiceTotal._sum.returnedAmount ?? 0);
  const lastExpenses = Number(prevExpenseTotal._sum.amount ?? 0);
  const prevPurchases = Number(prevPurchaseTotal._sum.totalCost ?? 0);

  // NET PROFIT = Revenue - Expenses - Purchases (basis penyerahan).
  // ARUS KAS = pergerakan NYATA kas pada akun 1-1000 di buku besar
  // (src/lib/gl-cash-flow.ts) — bukan revenue - expenses.
  const netProfit = computeNetProfit({
    revenue: totalRevenue,
    expenses: totalExpenses,
    purchases: totalPurchases,
  });
  const lastNetProfit = computeNetProfit({
    revenue: lastRevenue,
    expenses: lastExpenses,
    purchases: prevPurchases,
  });
  const cashFlow = cashMovement.net;
  const lastCashFlow = prevCashMovement.net;

  const revenueTrend = computeTrend(totalRevenue, lastRevenue);
  const expensesTrend = computeTrend(totalExpenses, lastExpenses);
  const profitTrend = computeTrend(netProfit, lastNetProfit);
  const cashFlowTrend = computeTrend(cashFlow, lastCashFlow);

  const revenueVsExpensesChart = chartDays.map((day) => {
    const totals = dailyTotals.get(day.dateKey);
    return {
      date: day.label,
      revenue: totals?.revenue ?? 0,
      expenses: totals?.expenses ?? 0,
    };
  });

  // Expense by category
  const expenseByCategory = expenseGroups.map((group) => ({
    name: group.category,
    value: Number(group._sum.amount ?? 0),
  }));

  return {
    totalRevenue,
    totalExpenses,
    netProfit,
    cashFlow,
    revenueTrend,
    expensesTrend,
    profitTrend,
    cashFlowTrend,
    revenueVsExpensesChart,
    expenseByCategory,
  };
}
