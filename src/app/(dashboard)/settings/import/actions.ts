"use server";

import { parseLegacyStockFile } from "@/lib/legacy-stock-importer/parser";
import { normalizeLegacyStockRows } from "@/lib/legacy-stock-importer/normalizer";
import { validateLegacyStockRows } from "@/lib/legacy-stock-importer/validator";
import { resolveLegacyStockDryRun } from "@/lib/legacy-stock-importer/resolver";
import { buildResolverContext } from "@/lib/legacy-stock-importer/resolver-context";
import { applyLegacyOpeningStock } from "@/lib/legacy-stock-importer/apply-legacy-opening-stock";
import { requireRole, getCurrentTenantId, getSystemUserId } from "@/lib/auth";

import type {
  LegacyStockRawRow,
  LegacyStockDryRunResult,
  OpeningStockResult,
} from "@/lib/legacy-stock-importer/types";

export interface ParseFileResult {
  rawRows: LegacyStockRawRow[];
  errors: string[];
  rowCount: number;
  fileName: string;
  fileSize: number;
}

export async function parseUploadedFileAction(
  formData: FormData,
): Promise<ParseFileResult> {
  await requireRole("OWNER", "MANAGER");

  const file = formData.get("file") as File | null;
  if (!file) {
    return { rawRows: [], errors: ["Tidak ada file yang diunggah."], rowCount: 0, fileName: "", fileSize: 0 };
  }

  const fileName = file.name;
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await parseLegacyStockFile(buffer, fileName);

  return {
    rawRows: result.rawRows,
    errors: result.errors,
    rowCount: result.rowCount,
    fileName,
    fileSize: buffer.length,
  };
}

export async function dryRunAction(
  rawRows: LegacyStockRawRow[],
): Promise<LegacyStockDryRunResult> {
  await requireRole("OWNER", "MANAGER");
  const tenantId = await getCurrentTenantId();

  const normalized = normalizeLegacyStockRows(rawRows);
  const validated = validateLegacyStockRows(normalized);

  const ctx = buildResolverContext(tenantId);
  const dryRun = await resolveLegacyStockDryRun(validated, ctx);

  return {
    summary: dryRun.summary,
    rows: dryRun.rows,
  };
}

export async function applyOpeningStockAction(
  rawRows: LegacyStockRawRow[],
  operationKey: string,
): Promise<OpeningStockResult> {
  await requireRole("OWNER", "MANAGER");
  const tenantId = await getCurrentTenantId();
  const userId = await getSystemUserId();

  return applyLegacyOpeningStock({
    operationKey,
    tenantId,
    userId,
    rawRows,
  });
}
