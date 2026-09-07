// =============================================================================
// LEGACY STOCK IMPORTER — OPENING STOCK APPLY (COMMIT 2)
// =============================================================================
// Transactional, idempotent application of validated legacy stock rows as
// opening stock. Reuses existing runtime: appendLedger, lot creation,
// Product / InventorySupplyItem / Packaging master creation.
//
// refType: ADJUSTMENT_IN (existing LedgerRefType enum — no migration needed)
// Accounting: inventory-only (no Opening Equity journal on Commit 2);
// report accounting opening-balance as a separate scope.

 
type TransactionClient = any;

import { requireTenantPrisma } from "@/lib/auth";
import { appendLedger } from "@/lib/stock";
import { recordAudit } from "@/lib/audit";
import type {
  LegacyStockRawRow,
  LegacyStockNormalizedRow,
  LegacyStockValidatedRow,
  OpeningStockResult,
  OpeningStockRowResult,
} from "./types";
import { normalizeLegacyStockRows } from "./normalizer";
import { validateLegacyStockRows } from "./validator";
import { resolveLegacyStockDryRun } from "./resolver";
import { buildResolverContext } from "./resolver-context";

const LEDGER_REF_TYPE = "ADJUSTMENT_IN" as const;

export interface ApplyOpeningStockInput {
  operationKey: string;
  tenantId: string;
  userId: string;
  rawRows: LegacyStockRawRow[];
}

function generateBatchCode(operationKey: string, rowNumber: number): string {
  return `${operationKey}:L${rowNumber}`;
}

function computeOpeningValue(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost * 100) / 100;
}

async function generatePackagingCode(tx: TransactionClient, tenantId: string): Promise<string> {
  const existing = await tx.packaging.findMany({
    where: { tenantId, code: { startsWith: "PKG-" } },
    select: { code: true },
  });
  let max = 0;
  for (const row of existing) {
    const match = row.code.match(/^PKG-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PKG-${String(max + 1).padStart(3, "0")}`;
}

async function resolveSupplierId(
  tx: TransactionClient,
  tenantId: string,
  supplierCode?: string,
): Promise<string | null> {
  if (!supplierCode) return null;
  const supplier = await tx.supplier.findFirst({
    where: { tenantId, code: supplierCode },
    select: { id: true },
  });
  return supplier?.id ?? null;
}

async function createOrUpdateLot(
  tx: TransactionClient,
  tenantId: string,
  entityId: string,
  entityType: "PRODUCT" | "SUPPLY",
  row: LegacyStockValidatedRow,
  operationKey: string,
): Promise<string | null> {
  const batchCode = generateBatchCode(operationKey, row.rowNumber);
  const supplierId = await resolveSupplierId(tx, tenantId, row.supplierCode);

  const lotData: Record<string, unknown> = {
    tenantId,
    batchCode,
    receivedAt: row.receivedAt ?? new Date(),
    expiryDate: row.expiryDate ?? null,
    supplierId: supplierId,
    notes: `Opening stock import: ${operationKey}`,
  };

  let quantityField: string;
  let quantityValue: number;

  if (entityType === "SUPPLY") {
    lotData.supplyItemId = entityId;
    lotData.productId = null;
    lotData.packagingId = null;
    quantityField = "supplyQuantity";
    quantityValue = row.quantity;
  } else if (row.type === "FINISHED_GOODS") {
    lotData.productId = entityId;
    lotData.packagingId = null;
    lotData.supplyItemId = null;
    quantityField = "quantityUnit";
    quantityValue = row.quantity;
  } else {
    lotData.productId = entityId;
    lotData.packagingId = null;
    lotData.supplyItemId = null;
    quantityField = "quantityKg";
    quantityValue = row.quantity;
  }

  const lot = await tx.lot.upsert({
    where: {
      tenantId_batchCode: { tenantId, batchCode },
    },
    create: { ...lotData, [quantityField]: quantityValue },
    update: {
      [quantityField]: quantityValue,
      expiryDate: row.expiryDate ?? null,
      receivedAt: row.receivedAt ?? new Date(),
    },
    select: { id: true },
  });

  return lot.id;
}

async function checkExistingStock(
  tx: TransactionClient,
  row: LegacyStockValidatedRow,
  entityId: string,
  entityType: "PRODUCT" | "SUPPLY",
): Promise<void> {
  if (entityType === "SUPPLY") {
    const supply = await tx.inventorySupplyItem.findUnique({
      where: { id: entityId },
      select: { stockQuantity: true },
    });
    if (supply && Number(supply.stockQuantity) > 0) {
      throw new Error(
        `Cannot apply opening stock for existing supply "${row.code}" — non-zero stock balance already exists.`,
      );
    }
  } else {
    const product = await tx.product.findUnique({
      where: { id: entityId },
      select: { stockKg: true, stockUnit: true },
    });
    const hasStock =
      Number(product?.stockKg ?? 0) > 0 || Number(product?.stockUnit ?? 0) > 0;
    if (hasStock) {
      throw new Error(
        `Cannot apply opening stock for existing product "${row.code}" — non-zero stock balance already exists.`,
      );
    }
  }
}

async function ensureSupplyMaster(
  tx: TransactionClient,
  tenantId: string,
  row: LegacyStockValidatedRow,
): Promise<{ id: string; existing: boolean }> {
  const existing = await tx.inventorySupplyItem.findUnique({
    where: { tenantId_code: { tenantId, code: row.code } },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id, existing: true };
  }

  const item = await tx.inventorySupplyItem.create({
    data: {
      tenantId,
      code: row.code,
      name: row.name,
      category: row.category,
      baseUnit: row.baseUnit,
      costPerUnit: row.unitCost,
      stockQuantity: 0,
      avgCostPerUnit: 0,
      trackLot: true,
      isActive: true,
      reorderAlertEnabled: false,
      leadTimeDays: 7,
      safetyStockQuantity: 0,
      reorderLookbackDays: 30,
      consumableInProduction: false,
      includeInProductHpp: false,
    },
  });

  if (row.category === "PACKAGING") {
    const packagingCode = await generatePackagingCode(tx, tenantId);
    await tx.packaging.create({
      data: {
        tenantId,
        code: packagingCode,
        name: row.name,
        weightGrams: row.tareWeightGrams ?? row.capacityGrams ?? 0,
        costPerUnit: row.unitCost,
        isActive: true,
        supplyItemId: item.id,
      },
    });
  }

  return { id: item.id, existing: false };
}

async function ensureProductMeta(
  tx: TransactionClient,
  tenantId: string,
  row: LegacyStockValidatedRow,
): Promise<{ id: string; existing: boolean }> {
  const existing = await tx.product.findUnique({
    where: { tenantId_code: { tenantId, code: row.code } },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id, existing: true };
  }
  const product = await tx.product.create({
    data: {
      tenantId,
      code: row.code,
      name: row.name,
      type: row.type,
      origin: row.origin ?? null,
      roastLevel: row.type === "ROASTED_BEAN" ? (row.roastLevel ?? null) : null,
      netWeightGrams: row.netWeightGrams ?? null,
      isActive: true,
    },
  });
  return { id: product.id, existing: false };
}

async function buildIdempotentResult(
  operationKey: string,
  tenantId: string,
  validated: LegacyStockValidatedRow[],
  tx: TransactionClient,
): Promise<OpeningStockResult> {
  const entries = await tx.inventoryLedger.findMany({
    where: { tenantId, refId: operationKey, refType: LEDGER_REF_TYPE },
    select: {
      productId: true,
      supplyItemId: true,
      lotId: true,
      quantityKg: true,
      quantityUnit: true,
      supplyQuantity: true,
    },
  });

  const rows: OpeningStockRowResult[] = validated.map((row, idx) => {
    const entry = entries[idx];
    const isSupply = row.type === "SUPPLY";
    const entityId = isSupply ? entry?.supplyItemId : entry?.productId;
    const quantity = isSupply
      ? Number(entry?.supplyQuantity ?? row.quantity)
      : row.type === "FINISHED_GOODS"
        ? Number(entry?.quantityUnit ?? row.quantity)
        : Number(entry?.quantityKg ?? row.quantity);
    return {
      rowNumber: row.rowNumber,
      entityId: entityId ?? "",
      entityType: isSupply ? "SUPPLY" : "PRODUCT",
      code: row.code,
      action: "MATCH",
      ...(entry?.lotId ? { lotId: entry.lotId } : {}),
      ledgerRefId: operationKey,
      quantity,
      unitCost: row.unitCost,
      openingValue: computeOpeningValue(quantity, row.unitCost),
    };
  });

  return {
    importId: operationKey,
    operationKey,
    totalRows: validated.length,
    createdMasters: 0,
    matchedMasters: rows.length,
    lotsCreated: 0,
    ledgerEntriesCreated: 0,
    totalOpeningValue: 0,
    rows,
    errors: [],
  };
}

export async function applyLegacyOpeningStock(
  input: ApplyOpeningStockInput,
): Promise<OpeningStockResult> {
  const { operationKey, tenantId, userId, rawRows } = input;

  if (!operationKey) {
    return {
      importId: "",
      operationKey,
      totalRows: 0,
      createdMasters: 0,
      matchedMasters: 0,
      lotsCreated: 0,
      ledgerEntriesCreated: 0,
      totalOpeningValue: 0,
      rows: [],
      errors: ["operationKey is required."],
    };
  }

  // Step 1: Normalize + validate (reuse Commit 1 contracts)
  const normalized: LegacyStockNormalizedRow[] = normalizeLegacyStockRows(rawRows);
  const validated: LegacyStockValidatedRow[] = validateLegacyStockRows(normalized);

  // Step 2: Reject if any row has validation errors
  const invalidRows = validated.filter((r) => !r.isValid);
  if (invalidRows.length > 0) {
    const errors = invalidRows.map(
      (r) => `Row ${r.rowNumber}: ${r.errors.map((e) => e.message).join("; ")}`,
    );
    return {
      importId: "",
      operationKey,
      totalRows: validated.length,
      createdMasters: 0,
      matchedMasters: 0,
      lotsCreated: 0,
      ledgerEntriesCreated: 0,
      totalOpeningValue: 0,
      rows: [],
      errors,
    };
  }

  // Step 3: Idempotency check — has this import been applied before?
  const txClient = await requireTenantPrisma();

  const existing = await txClient.inventoryLedger.findFirst({
    where: {
      tenantId,
      refId: operationKey,
      refType: LEDGER_REF_TYPE,
    },
    select: { id: true },
  });

  if (existing) {
    return await buildIdempotentResult(operationKey, tenantId, validated, txClient);
  }

  // Step 4: Resolve tenant-scoped (re-resolve CREATE/MATCH to confirm safety)
  const ctx = buildResolverContext(tenantId);
  const dryRun = await resolveLegacyStockDryRun(validated, ctx);
  if (dryRun.summary.errorCount > 0) {
    return {
      importId: "",
      operationKey,
      totalRows: validated.length,
      createdMasters: 0,
      matchedMasters: 0,
      lotsCreated: 0,
      ledgerEntriesCreated: 0,
      totalOpeningValue: 0,
      rows: [],
      errors: ["Resolved rows contain errors; cannot apply."],
    };
  }

  // Step 5: Apply in Serializable transaction with bounded retry on serialization failures
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await txClient.$transaction(
        async (tx: TransactionClient) => {
          // Re-check idempotency inside tx (race condition protection)
          const alreadyApplied = await tx.inventoryLedger.findFirst({
            where: {
              tenantId,
              refId: operationKey,
              refType: LEDGER_REF_TYPE,
            },
            select: { id: true },
          });

          if (alreadyApplied) {
            return await buildIdempotentResult(operationKey, tenantId, validated, tx);
          }

          const rowResults: OpeningStockRowResult[] = [];
          let createdMasters = 0;
          let matchedMasters = 0;
          let lotsCreated = 0;
          let ledgerEntriesCreated = 0;
          let totalOpeningValue = 0;
          const importCreatedIds = new Set<string>();

          for (const row of validated) {
            let entityId: string;
            let entityType: "PRODUCT" | "SUPPLY";
            let existing: boolean;

            if (row.type === "SUPPLY") {
              const result = await ensureSupplyMaster(tx, tenantId, row);
              entityId = result.id;
              entityType = "SUPPLY";
              existing = result.existing;
            } else {
              const result = await ensureProductMeta(tx, tenantId, row);
              entityId = result.id;
              entityType = "PRODUCT";
              existing = result.existing;
            }

            const createdThisImport = importCreatedIds.has(entityId);
            if (!existing) {
              importCreatedIds.add(entityId);
            }

            const action = existing ? "MATCH" : "CREATE";

            if (existing && !createdThisImport) {
              await checkExistingStock(tx, row, entityId, entityType);
            }

            let lotId: string | undefined;
            if (row.lotNumber) {
              lotId =
                (await createOrUpdateLot(tx, tenantId, entityId, entityType, row, operationKey)) ??
                undefined;
            }

            const openingValue = computeOpeningValue(row.quantity, row.unitCost);

            if (entityType === "SUPPLY") {
              await appendLedger(tx, {
                data: {
                  tenantId,
                  supplyItemId: entityId,
                  entryType: "IN",
                  refType: LEDGER_REF_TYPE,
                  refId: operationKey,
                  supplyQuantity: row.quantity,
                  incomingPrice: row.unitCost || undefined,
                  lotId: lotId ?? null,
                  lotNumber: row.lotNumber ?? null,
                  expiryDate: row.expiryDate ?? null,
                  notes: `Opening stock import (${operationKey})`,
                  createdById: userId,
                },
              });
            } else {
              const isFinishedGoods = row.type === "FINISHED_GOODS";
              await appendLedger(tx, {
                data: {
                  tenantId,
                  productId: entityId,
                  entryType: "IN",
                  refType: LEDGER_REF_TYPE,
                  refId: operationKey,
                  quantityKg: isFinishedGoods ? null : row.quantity,
                  quantityUnit: isFinishedGoods ? Math.round(row.quantity) : null,
                  incomingPrice: row.unitCost || undefined,
                  lotId: lotId ?? null,
                  lotNumber: row.lotNumber ?? null,
                  expiryDate: row.expiryDate ?? null,
                  notes: `Opening stock import (${operationKey})`,
                  createdById: userId,
                },
              });
            }

            const rowResult: OpeningStockRowResult = {
              rowNumber: row.rowNumber,
              entityId,
              entityType,
              code: row.code,
              action,
              ...(lotId ? { lotId } : {}),
              ledgerRefId: operationKey,
              quantity: row.quantity,
              unitCost: row.unitCost,
              openingValue,
            };
            rowResults.push(rowResult);

            if (action === "CREATE") createdMasters++;
            else matchedMasters++;
            if (rowResult.lotId) lotsCreated++;
            ledgerEntriesCreated++;
            totalOpeningValue += rowResult.openingValue;
          }

          await recordAudit(tx, {
            tenantId,
            userId,
            action: "OPENING_STOCK_IMPORT",
            entityType: "LegacyStockImport",
            entityId: operationKey,
            metadata: {
              totalRows: validated.length,
              createdMasters,
              matchedMasters,
              lotsCreated,
              ledgerEntriesCreated,
              totalOpeningValue,
            },
          });

          return {
            importId: operationKey,
            operationKey,
            totalRows: validated.length,
            createdMasters,
            matchedMasters,
            lotsCreated,
            ledgerEntriesCreated,
            totalOpeningValue: Math.round(totalOpeningValue * 100) / 100,
            rows: rowResults,
            errors: [],
          };
        },
        {
          isolationLevel: "Serializable",
          maxWait: 15000,
          timeout: 60000,
        },
      );
      return result;
    } catch (err: any) {
      if (err?.code === "P2034" && attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      return {
        importId: "",
        operationKey,
        totalRows: validated.length,
        createdMasters: 0,
        matchedMasters: 0,
        lotsCreated: 0,
        ledgerEntriesCreated: 0,
        totalOpeningValue: 0,
        rows: [],
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  throw new Error("Max retry attempts exceeded for opening stock import.");
}
