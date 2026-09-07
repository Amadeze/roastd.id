import { Prisma } from "@prisma/client";

import { recordAudit } from "@/lib/audit";
import { getCurrentDate } from "@/lib/date-utils";
import { transferLotInTx } from "@/lib/lot-transfer";
import { postRoastingBatch, postStockAdjustment } from "@/lib/posting";
import { analyzeRoastOutcome, type RoastOutcome } from "@/lib/roast-intent";
import { appendLedger } from "@/lib/stock";

// This module owns the inventory semantics of roasting. UI, Artisan, and
// Studio entry points call these primitives inside their own serializable
// transaction instead of maintaining separate stock policies.
type TransactionClient = any;

const KG_EPSILON = 0.000001;
const ROASTING_WIP_CODE = "SYS-ROASTING-WIP";
const ROASTING_WIP_PURPOSE = "ROASTING_WIP";

type LifecycleInput = {
  tenantId: string;
  userId: string;
  batchId: string;
  preferredLotId?: string | null;
};

export type RoastReservationResult = {
  reservationCount: number;
  reservedKg: number;
};

export type RoastChargeResult = {
  alreadyCharged: boolean;
  transferCount: number;
};

export type RoastCompletionResult = {
  alreadyCompleted: boolean;
  batchCode: string;
  actualOutputKg: number;
  outcome: RoastOutcome;
};

type ChargedReservation = {
  id: string;
  lotId: string;
  sourceLocationId: string | null;
  chargeTransferId: string | null;
  quantityKg: { toNumber(): number } | number | string;
};

type ChargeTransfer = {
  id: string;
  lotId: string;
  destinationLocationId: string;
};

function roundKg(value: number) {
  return Math.round(value * 1000) / 1000;
}

async function lockBatch(tx: TransactionClient, tenantId: string, batchId: string) {
  const locked = await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "parent_roasting_batches"
    WHERE "id" = ${batchId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `) as { id: string }[];
  if (locked.length !== 1) throw new Error("Batch roasting tidak ditemukan untuk tenant ini.");
}

export async function resolveRoastingWipLocationInTx(
  tx: TransactionClient,
  tenantId: string,
  sourceLocationId: string,
): Promise<string> {
  const source = await tx.location.findFirst({
    where: {
      id: sourceLocationId,
      tenantId,
      isActive: true,
      warehouse: { isActive: true },
    },
    select: { warehouseId: true },
  });
  if (!source) throw new Error("Lokasi sumber Green Bean tidak aktif atau bukan milik tenant.");

  const location = await tx.location.upsert({
    where: {
      tenantId_warehouseId_code: {
        tenantId,
        warehouseId: source.warehouseId,
        code: ROASTING_WIP_CODE,
      },
    },
    update: {
      name: "Roasting WIP",
      zone: "WIP",
      isActive: true,
      isDefault: false,
      isSystem: true,
      systemPurpose: ROASTING_WIP_PURPOSE,
    },
    create: {
      tenantId,
      warehouseId: source.warehouseId,
      code: ROASTING_WIP_CODE,
      name: "Roasting WIP",
      zone: "WIP",
      isSystem: true,
      systemPurpose: ROASTING_WIP_PURPOSE,
    },
    select: { id: true },
  });
  return location.id;
}

async function resolveOutputLocationInTx(
  tx: TransactionClient,
  tenantId: string,
  destinationLocationId?: string | null,
): Promise<string> {
  if (destinationLocationId) {
    const requested = await tx.location.findFirst({
      where: { id: destinationLocationId, tenantId, isActive: true, isSystem: false },
      select: { id: true },
    });
    if (!requested) throw new Error("Lokasi tujuan Roasted Bean tidak valid untuk tenant ini.");
    return requested.id;
  }

  const existing = await tx.location.findFirst({
    where: { tenantId, isActive: true, isSystem: false },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  if (existing) return existing.id;

  const warehouse = await tx.warehouse.upsert({
    where: { tenantId_code: { tenantId, code: "WH-01" } },
    update: { isActive: true },
    create: {
      tenantId,
      code: "WH-01",
      name: "Gudang Utama",
      isActive: true,
      isDefault: true,
    },
    select: { id: true },
  });
  const location = await tx.location.upsert({
    where: {
      tenantId_warehouseId_code: {
        tenantId,
        warehouseId: warehouse.id,
        code: "A-01",
      },
    },
    update: { isActive: true, isDefault: true, isSystem: false, systemPurpose: null },
    create: {
      tenantId,
      warehouseId: warehouse.id,
      code: "A-01",
      name: "Penyimpanan Utama",
      isDefault: true,
    },
    select: { id: true },
  });
  return location.id;
}

export async function reserveRoastMaterialsInTx(
  tx: TransactionClient,
  input: LifecycleInput,
): Promise<RoastReservationResult> {
  await lockBatch(tx, input.tenantId, input.batchId);
  const batch = await tx.parentRoastingBatch.findFirst({
    where: { id: input.batchId, tenantId: input.tenantId },
    select: {
      id: true,
      code: true,
      inputProductId: true,
      targetWeightKg: true,
      lifecycleStatus: true,
    },
  });
  if (!batch) throw new Error("Batch roasting tidak ditemukan.");

  if (["RESERVED", "CHARGED", "COMPLETED"].includes(batch.lifecycleStatus)) {
    const reservations = await tx.roastMaterialReservation.findMany({
      where: { tenantId: input.tenantId, parentBatchId: batch.id },
      select: { quantityKg: true },
    });
    return {
      reservationCount: reservations.length,
      reservedKg: roundKg(reservations.reduce((sum: number, row: any) => sum + Number(row.quantityKg), 0)),
    };
  }
  if (batch.lifecycleStatus !== "PLANNED") {
    throw new Error("Batch tidak dapat direservasi dari status saat ini.");
  }

  // Lock every eligible physical placement before calculating availability.
  // Concurrent reservers therefore serialize on the same placement rows.
  await tx.$queryRaw(Prisma.sql`
    SELECT p."id"
    FROM "lot_placements" p
    JOIN "lots" l ON l."id" = p."lotId"
    JOIN "locations" loc ON loc."id" = p."locationId"
    JOIN "warehouses" wh ON wh."id" = loc."warehouseId"
    WHERE p."tenantId" = ${input.tenantId}
      AND l."tenantId" = ${input.tenantId}
      AND l."productId" = ${batch.inputProductId}
      AND l."consumedAt" IS NULL
      -- Lot berstatus HOLD sedang dikarantina QC: jangan direservasi.
      AND l."qcStatus" <> 'HOLD'
      AND p."quantityKg" > 0
      AND loc."isActive" = true
      AND loc."isSystem" = false
      AND wh."isActive" = true
    ORDER BY l."expiryDate" ASC NULLS LAST, l."receivedAt" ASC, l."createdAt" ASC, p."createdAt" ASC
    FOR UPDATE OF p, l
  `);

  const [placements, activeReservations] = await Promise.all([
    tx.lotPlacement.findMany({
      where: {
        tenantId: input.tenantId,
        quantityKg: { gt: 0 },
        lot: {
          tenantId: input.tenantId,
          productId: batch.inputProductId,
          consumedAt: null,
          qcStatus: { not: "HOLD" },
        },
        location: {
          isActive: true,
          isSystem: false,
          warehouse: { isActive: true },
        },
      },
      select: {
        id: true,
        lotId: true,
        locationId: true,
        quantityKg: true,
        createdAt: true,
        lot: { select: { expiryDate: true, receivedAt: true, createdAt: true } },
      },
    }),
    tx.roastMaterialReservation.findMany({
      where: {
        tenantId: input.tenantId,
        status: "ACTIVE",
        lot: { productId: batch.inputProductId },
      },
      select: { lotId: true, sourceLocationId: true, quantityKg: true },
    }),
  ]);

  placements.sort((left: any, right: any) => {
    // Prefer the lot the operator explicitly chose to roast (continuity:
    // "Roast this lot"). Still falls back to FEFO for the rest / shortfall.
    if (input.preferredLotId) {
      const lp = left.lotId === input.preferredLotId ? 0 : 1;
      const rp = right.lotId === input.preferredLotId ? 0 : 1;
      if (lp !== rp) return lp - rp;
    }
    const leftExpiry = left.lot.expiryDate ? new Date(left.lot.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    const rightExpiry = right.lot.expiryDate ? new Date(right.lot.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
    return leftExpiry - rightExpiry
      || new Date(left.lot.receivedAt).getTime() - new Date(right.lot.receivedAt).getTime()
      || new Date(left.lot.createdAt).getTime() - new Date(right.lot.createdAt).getTime()
      || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });

  const reservedByPlacement = new Map<string, number>();
  for (const reservation of activeReservations) {
    const key = `${reservation.lotId}:${reservation.sourceLocationId}`;
    reservedByPlacement.set(key, (reservedByPlacement.get(key) ?? 0) + Number(reservation.quantityKg));
  }

  let remaining = Number(batch.targetWeightKg);
  let reservationCount = 0;
  for (const placement of placements) {
    if (remaining <= KG_EPSILON) break;
    const key = `${placement.lotId}:${placement.locationId}`;
    const available = Math.max(0, Number(placement.quantityKg) - (reservedByPlacement.get(key) ?? 0));
    if (available <= KG_EPSILON) continue;
    const quantityKg = roundKg(Math.min(remaining, available));
    if (quantityKg <= KG_EPSILON) continue;

    await tx.roastMaterialReservation.create({
      data: {
        tenantId: input.tenantId,
        parentBatchId: batch.id,
        lotId: placement.lotId,
        sourceLocationId: placement.locationId,
        quantityKg,
        status: "ACTIVE",
      },
    });
    reservationCount += 1;
    remaining = roundKg(remaining - quantityKg);
  }

  if (remaining > KG_EPSILON) {
    throw new Error(
      `Stok Green Bean yang tersedia di lokasi tidak cukup. Kekurangan ${remaining.toFixed(3)} kg setelah reservation aktif diperhitungkan.`,
    );
  }

  const claimed = await tx.parentRoastingBatch.updateMany({
    where: { id: batch.id, tenantId: input.tenantId, lifecycleStatus: "PLANNED" },
    data: { lifecycleStatus: "RESERVED" },
  });
  if (claimed.count !== 1) throw new Error("Status batch berubah saat material direservasi.");

  await recordAudit(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: "RESERVE",
    entityType: "ParentRoastingBatch",
    entityId: batch.id,
    before: { lifecycleStatus: "PLANNED" },
    after: { lifecycleStatus: "RESERVED", reservedKg: Number(batch.targetWeightKg) },
  });
  return { reservationCount, reservedKg: Number(batch.targetWeightKg) };
}

export async function chargeRoastMaterialsInTx(
  tx: TransactionClient,
  input: LifecycleInput,
): Promise<RoastChargeResult> {
  await lockBatch(tx, input.tenantId, input.batchId);
  const batch = await tx.parentRoastingBatch.findFirst({
    where: { id: input.batchId, tenantId: input.tenantId },
    select: { id: true, code: true, lifecycleStatus: true },
  });
  if (!batch) throw new Error("Batch roasting tidak ditemukan.");
  if (batch.lifecycleStatus === "CHARGED") {
    const transferCount = await tx.roastMaterialReservation.count({
      where: { tenantId: input.tenantId, parentBatchId: batch.id, status: "CHARGED" },
    });
    return { alreadyCharged: true, transferCount };
  }
  if (batch.lifecycleStatus !== "RESERVED") {
    throw new Error("Batch harus berstatus RESERVED sebelum Green Bean di-charge.");
  }

  const reservations = await tx.roastMaterialReservation.findMany({
    where: { tenantId: input.tenantId, parentBatchId: batch.id, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (reservations.length === 0) throw new Error("Reservation aktif untuk batch tidak ditemukan.");

  for (const reservation of reservations) {
    const wipLocationId = await resolveRoastingWipLocationInTx(
      tx,
      input.tenantId,
      reservation.sourceLocationId,
    );
    const transfer = await transferLotInTx(tx, {
      tenantId: input.tenantId,
      userId: input.userId,
      lotId: reservation.lotId,
      sourceLocationId: reservation.sourceLocationId,
      destinationLocationId: wipLocationId,
      quantityKg: Number(reservation.quantityKg),
      notes: `Charge roasting ${batch.code}`,
    });
    const updated = await tx.roastMaterialReservation.updateMany({
      where: { id: reservation.id, tenantId: input.tenantId, status: "ACTIVE" },
      data: { status: "CHARGED", chargeTransferId: transfer.id },
    });
    if (updated.count !== 1) throw new Error("Reservation berubah saat proses charge.");
  }

  const claimed = await tx.parentRoastingBatch.updateMany({
    where: { id: batch.id, tenantId: input.tenantId, lifecycleStatus: "RESERVED" },
    data: { lifecycleStatus: "CHARGED" },
  });
  if (claimed.count !== 1) throw new Error("Batch sudah di-charge oleh proses lain.");

  await recordAudit(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: "CHARGE",
    entityType: "ParentRoastingBatch",
    entityId: batch.id,
    before: { lifecycleStatus: "RESERVED" },
    after: { lifecycleStatus: "CHARGED", transferCount: reservations.length },
  });
  return { alreadyCharged: false, transferCount: reservations.length };
}

async function consumeChargedReservationInTx(
  tx: TransactionClient,
  input: LifecycleInput,
  batch: any,
  reservation: any,
  refType: "ROASTING_GB_OUT" | "ADJUSTMENT_OUT",
) {
  const transfer = reservation.chargeTransferId
    ? await tx.locationTransfer.findFirst({
        where: {
          id: reservation.chargeTransferId,
          tenantId: input.tenantId,
          lotId: reservation.lotId,
          status: "COMPLETED",
        },
        select: { destinationLocationId: true },
      })
    : null;
  if (!transfer) throw new Error("Jejak transfer charge untuk reservation tidak ditemukan.");

  const quantityKg = Number(reservation.quantityKg);
  const placement = await tx.lotPlacement.updateMany({
    where: {
      tenantId: input.tenantId,
      lotId: reservation.lotId,
      locationId: transfer.destinationLocationId,
      quantityKg: { gte: quantityKg },
    },
    data: { quantityKg: { decrement: quantityKg } },
  });
  if (placement.count !== 1) throw new Error("Stok fisik ROASTING-WIP tidak mencukupi.");

  await appendLedger(tx, {
    tenantId: input.tenantId,
    productId: batch.inputProductId,
    entryType: "OUT",
    refType,
    refId: batch.id,
    quantityKg,
    lotId: reservation.lotId,
    lotNumber: reservation.lot.batchCode,
    expiryDate: reservation.lot.expiryDate,
    notes: refType === "ROASTING_GB_OUT"
      ? `Roasting: ${batch.code}`
      : `Green Bean hilang/scrap: ${batch.code}`,
    createdById: input.userId,
  });
}

export async function completeRoastInTx(
  tx: TransactionClient,
  input: LifecycleInput & {
    actualOutputKg: number;
    destinationLocationId?: string | null;
    source?: string;
  },
): Promise<RoastCompletionResult> {
  if (!Number.isFinite(input.actualOutputKg) || input.actualOutputKg <= 0) {
    throw new Error("Berat hasil harus lebih dari 0.");
  }
  await lockBatch(tx, input.tenantId, input.batchId);
  const batch = await tx.parentRoastingBatch.findFirst({
    where: { id: input.batchId, tenantId: input.tenantId },
    select: {
      id: true,
      code: true,
      status: true,
      lifecycleStatus: true,
      inputProductId: true,
      outputProductId: true,
      targetWeightKg: true,
      actualOutputKg: true,
      inputProduct: { select: { avgCostPerKg: true, name: true } },
      outputProduct: { select: { name: true } },
    },
  });
  if (!batch) throw new Error("Batch roasting tidak ditemukan.");
  const inputKg = Number(batch.targetWeightKg);
  if (input.actualOutputKg >= inputKg) {
    throw new Error("Berat hasil harus lebih kecil dari Green Bean yang di-charge.");
  }
  if (batch.lifecycleStatus === "COMPLETED" && batch.actualOutputKg != null) {
    const recorded = Number(batch.actualOutputKg);
    if (Math.abs(recorded - input.actualOutputKg) > KG_EPSILON) {
      throw new Error("Batch sudah selesai dengan berat hasil yang berbeda.");
    }
    return {
      alreadyCompleted: true,
      batchCode: batch.code,
      actualOutputKg: recorded,
      outcome: analyzeRoastOutcome(inputKg, recorded),
    };
  }
  if (batch.status !== "PENDING" || batch.lifecycleStatus !== "CHARGED") {
    throw new Error("Batch harus berstatus CHARGED sebelum dapat diselesaikan.");
  }

  const recentComparable = await tx.parentRoastingBatch.findMany({
    where: {
      tenantId: input.tenantId,
      id: { not: batch.id },
      inputProductId: batch.inputProductId,
      outputProductId: batch.outputProductId,
      status: "COMPLETED",
      totalShrinkagePercent: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: 10,
    select: { totalShrinkagePercent: true },
  });
  const outcome = analyzeRoastOutcome(
    inputKg,
    input.actualOutputKg,
    recentComparable.map((row: any) => Number(row.totalShrinkagePercent)),
  );
  const claimed = await tx.parentRoastingBatch.updateMany({
    where: {
      id: batch.id,
      tenantId: input.tenantId,
      status: "PENDING",
      lifecycleStatus: "CHARGED",
    },
    data: {
      status: "COMPLETED",
      lifecycleStatus: "COMPLETED",
      actualOutputKg: input.actualOutputKg,
      totalShrinkagePercent: outcome.lossPercent,
      completedAt: getCurrentDate(),
    },
  });
  if (claimed.count !== 1) throw new Error("Batch sudah diselesaikan oleh proses lain.");

  const reservations = await tx.roastMaterialReservation.findMany({
    where: { tenantId: input.tenantId, parentBatchId: batch.id, status: "CHARGED" },
    orderBy: { createdAt: "asc" },
    include: { lot: { select: { batchCode: true, expiryDate: true } } },
  });
  if (reservations.length === 0) throw new Error("Reservation CHARGED untuk batch tidak ditemukan.");
  const reservedKg = roundKg(
    reservations.reduce((sum: number, row: any) => sum + Number(row.quantityKg), 0),
  );
  if (Math.abs(reservedKg - inputKg) > KG_EPSILON) {
    throw new Error("Total reservation tidak sama dengan target input batch.");
  }

  for (const reservation of reservations) {
    await consumeChargedReservationInTx(tx, input, batch, reservation, "ROASTING_GB_OUT");
    const updated = await tx.roastMaterialReservation.updateMany({
      where: { id: reservation.id, tenantId: input.tenantId, status: "CHARGED" },
      data: { status: "CONSUMED", consumedAt: getCurrentDate() },
    });
    if (updated.count !== 1) throw new Error("Reservation sudah dikonsumsi oleh proses lain.");
  }

  const destinationId = await resolveOutputLocationInTx(
    tx,
    input.tenantId,
    input.destinationLocationId,
  );
  const outputLot = await tx.lot.create({
    data: {
      tenantId: input.tenantId,
      productId: batch.outputProductId,
      batchCode: `${batch.code}-RB`,
      quantityKg: input.actualOutputKg,
      receivedAt: getCurrentDate(),
      notes: `Hasil roasting ${batch.code}`,
    },
  });
  await tx.lotPlacement.create({
    data: {
      tenantId: input.tenantId,
      lotId: outputLot.id,
      locationId: destinationId,
      quantityKg: input.actualOutputKg,
    },
  });

  const inputCost = Number(batch.inputProduct.avgCostPerKg ?? 0) * inputKg;
  await appendLedger(tx, {
    tenantId: input.tenantId,
    productId: batch.outputProductId,
    entryType: "IN",
    refType: "ROASTING_RB_IN",
    refId: batch.id,
    quantityKg: input.actualOutputKg,
    incomingPrice: inputCost / input.actualOutputKg,
    lotId: outputLot.id,
    lotNumber: outputLot.batchCode,
    notes: `Roasting: ${batch.code}`,
    createdById: input.userId,
  });
  await postRoastingBatch(
    batch.id,
    inputCost,
    inputKg,
    input.actualOutputKg,
    batch.inputProduct.name,
    batch.outputProduct.name,
    { tx, tenantId: input.tenantId, userId: input.userId },
  );
  await recordAudit(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: "COMPLETE",
    entityType: "ParentRoastingBatch",
    entityId: batch.id,
    before: { status: batch.status, lifecycleStatus: batch.lifecycleStatus },
    after: {
      status: "COMPLETED",
      lifecycleStatus: "COMPLETED",
      actualOutputKg: input.actualOutputKg,
      totalShrinkagePercent: outcome.lossPercent,
    },
    metadata: { source: input.source ?? "WEB", outputLotId: outputLot.id, destinationLocationId: destinationId },
  });
  return {
    alreadyCompleted: false,
    batchCode: batch.code,
    actualOutputKg: input.actualOutputKg,
    outcome,
  };
}

export async function cancelRoastInTx(
  tx: TransactionClient,
  input: LifecycleInput & { reason: string },
) {
  await lockBatch(tx, input.tenantId, input.batchId);
  const batch = await tx.parentRoastingBatch.findFirst({
    where: { id: input.batchId, tenantId: input.tenantId },
    select: { id: true, lifecycleStatus: true },
  });
  if (!batch) throw new Error("Batch roasting tidak ditemukan.");
  if (batch.lifecycleStatus === "CANCELLED") return { alreadyCancelled: true };
  if (!["PLANNED", "RESERVED"].includes(batch.lifecycleStatus)) {
    throw new Error("Hanya batch yang belum di-charge yang dapat dibatalkan.");
  }
  await tx.roastMaterialReservation.updateMany({
    where: { tenantId: input.tenantId, parentBatchId: batch.id, status: "ACTIVE" },
    data: { status: "RELEASED", releasedAt: getCurrentDate() },
  });
  await tx.parentRoastingBatch.update({
    where: { id: batch.id },
    data: {
      status: "VOID",
      lifecycleStatus: "CANCELLED",
      voidReason: input.reason.trim(),
      voidAt: getCurrentDate(),
    },
  });
  await recordAudit(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: "CANCEL",
    entityType: "ParentRoastingBatch",
    entityId: batch.id,
    before: { lifecycleStatus: batch.lifecycleStatus },
    after: { lifecycleStatus: "CANCELLED", reason: input.reason.trim() },
  });
  return { alreadyCancelled: false };
}

export async function abortRoastInTx(
  tx: TransactionClient,
  input: LifecycleInput & { reason: string; mode: "RECOVERABLE" | "SCRAP" },
) {
  if (!input.reason.trim()) throw new Error("Alasan abort wajib diisi.");
  await lockBatch(tx, input.tenantId, input.batchId);
  const batch = await tx.parentRoastingBatch.findFirst({
    where: { id: input.batchId, tenantId: input.tenantId },
    select: {
      id: true,
      code: true,
      lifecycleStatus: true,
      inputProductId: true,
      inputProduct: { select: { avgCostPerKg: true } },
    },
  });
  if (!batch) throw new Error("Batch roasting tidak ditemukan.");
  if (batch.lifecycleStatus === "ABORTED") return { alreadyAborted: true };
  if (batch.lifecycleStatus !== "CHARGED") {
    throw new Error("Hanya batch CHARGED yang dapat di-abort.");
  }

  const reservations: ChargedReservation[] = await tx.roastMaterialReservation.findMany({
    where: { tenantId: input.tenantId, parentBatchId: batch.id, status: "CHARGED" },
    orderBy: { createdAt: "asc" },
    include: { lot: { select: { batchCode: true, expiryDate: true } } },
  });
  if (reservations.length === 0) throw new Error("Reservation CHARGED untuk batch tidak ditemukan.");

  // Batch lookup jejak transfer charge + lokasi sumber untuk semua reservation
  // sekaligus — mengganti findFirst per reservation di dalam tx.
  const chargeTransferIds = reservations
    .map((reservation) => reservation.chargeTransferId)
    .filter((transferId): transferId is string => Boolean(transferId));
  const chargeTransfers: ChargeTransfer[] = chargeTransferIds.length > 0
    ? await tx.locationTransfer.findMany({
        where: { id: { in: chargeTransferIds }, tenantId: input.tenantId, status: "COMPLETED" },
        select: { id: true, lotId: true, destinationLocationId: true },
      })
    : [];
  const chargeTransferById = new Map(chargeTransfers.map((transfer) => [transfer.id, transfer]));

  const recoverableSourceIds = input.mode === "RECOVERABLE"
    ? Array.from(new Set(
        reservations
          .map((reservation) => reservation.sourceLocationId)
          .filter((locationId): locationId is string => Boolean(locationId)),
      ))
    : [];
  const activeSourceLocations: Array<{ id: string }> = recoverableSourceIds.length > 0
    ? await tx.location.findMany({
        where: { id: { in: recoverableSourceIds }, tenantId: input.tenantId, isActive: true },
        select: { id: true },
      })
    : [];
  const activeSourceLocationIds = new Set(activeSourceLocations.map((location) => location.id));

  for (const reservation of reservations) {
    const transfer = reservation.chargeTransferId
      ? chargeTransferById.get(reservation.chargeTransferId)
      : null;
    if (!transfer || transfer.lotId !== reservation.lotId) {
      throw new Error("Jejak transfer charge untuk reservation tidak ditemukan.");
    }

    if (input.mode === "RECOVERABLE") {
      const destinationId = reservation.sourceLocationId != null && activeSourceLocationIds.has(reservation.sourceLocationId)
        ? reservation.sourceLocationId
        : await resolveOutputLocationInTx(tx, input.tenantId, null);
      await transferLotInTx(tx, {
        tenantId: input.tenantId,
        userId: input.userId,
        lotId: reservation.lotId,
        sourceLocationId: transfer.destinationLocationId,
        destinationLocationId: destinationId,
        quantityKg: Number(reservation.quantityKg),
        notes: `Abort recoverable roasting ${batch.code}: ${input.reason.trim()}`,
      });
    } else {
      await consumeChargedReservationInTx(tx, input, batch, reservation, "ADJUSTMENT_OUT");
    }
  }

  // Data release identik untuk semua reservation dalam satu abort — satu
  // updateMany menggantikan update per baris.
  await tx.roastMaterialReservation.updateMany({
    where: { id: { in: reservations.map((reservation) => reservation.id) } },
    data: {
      status: "RELEASED",
      releasedAt: getCurrentDate(),
      ...(input.mode === "SCRAP" ? { consumedAt: getCurrentDate() } : {}),
    },
  });

  if (input.mode === "SCRAP") {
    const quantityKg = reservations.reduce((sum: number, row: any) => sum + Number(row.quantityKg), 0);
    await postStockAdjustment(
      batch.id,
      "GREEN_BEAN",
      "OUT",
      quantityKg,
      Number(batch.inputProduct.avgCostPerKg ?? 0),
      { tx, tenantId: input.tenantId, userId: input.userId },
    );
  }
  await tx.parentRoastingBatch.update({
    where: { id: batch.id },
    data: {
      status: "VOID",
      lifecycleStatus: "ABORTED",
      voidReason: input.reason.trim(),
      voidAt: getCurrentDate(),
    },
  });
  await recordAudit(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    action: input.mode === "SCRAP" ? "ABORT_SCRAP" : "ABORT_RECOVERABLE",
    entityType: "ParentRoastingBatch",
    entityId: batch.id,
    before: { lifecycleStatus: "CHARGED" },
    after: { lifecycleStatus: "ABORTED", reason: input.reason.trim() },
  });
  return { alreadyAborted: false };
}

