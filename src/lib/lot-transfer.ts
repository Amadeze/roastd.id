"use server";

import { requireRole, requireTenantPrisma, getCurrentTenantId, getSystemUserId } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { isSystemLocation, SYSTEM_LOCATION_ERROR } from "@/lib/system-location";
import { revalidatePath } from "next/cache";

export type TransferActionResult =
  | { success: true; transferId: string }
  | { success: false; error: string };

export interface TransferRow {
  id: string;
  lotId: string;
  batchCode: string;
  productName: string | null;
  sourceLocationName: string;
  sourceWarehouseName: string;
  destinationLocationName: string;
  destinationWarehouseName: string;
  quantityKg: number | null;
  quantityUnit: number | null;
  supplyQty: number | null;
  status: string;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
}

// Transaction-owned variant for operational workflows (roasting WIP, future
// controlled moves). It deliberately shares LocationTransfer persistence.
export async function transferLotInTx(tx: any, input: { tenantId: string; userId: string; lotId: string; sourceLocationId: string; destinationLocationId: string; quantityKg: number; notes?: string }) {
  if (!Number.isFinite(input.quantityKg) || input.quantityKg <= 0) throw new Error("Jumlah transfer harus lebih dari 0.");
  if (input.sourceLocationId === input.destinationLocationId) throw new Error("Sumber dan tujuan tidak boleh sama.");
  const [lot, sourceLocation, destinationLocation] = await Promise.all([
    tx.lot.findFirst({ where: { id: input.lotId, tenantId: input.tenantId }, select: { id: true } }),
    tx.location.findFirst({ where: { id: input.sourceLocationId, tenantId: input.tenantId, isActive: true }, select: { id: true } }),
    tx.location.findFirst({ where: { id: input.destinationLocationId, tenantId: input.tenantId, isActive: true }, select: { id: true } }),
  ]);
  if (!lot || !sourceLocation || !destinationLocation) throw new Error("Lot atau lokasi transfer tidak valid untuk tenant ini.");
  const source = await tx.lotPlacement.findFirst({ where: { tenantId: input.tenantId, lotId: input.lotId, locationId: input.sourceLocationId } });
  if (!source || Number(source.quantityKg) < input.quantityKg) throw new Error("Stok lokasi sumber tidak mencukupi.");
  await tx.lotPlacement.update({ where: { id: source.id }, data: { quantityKg: { decrement: input.quantityKg } } });
  await tx.lotPlacement.upsert({ where: { tenantId_lotId_locationId: { tenantId: input.tenantId, lotId: input.lotId, locationId: input.destinationLocationId } }, create: { tenantId: input.tenantId, lotId: input.lotId, locationId: input.destinationLocationId, quantityKg: input.quantityKg }, update: { quantityKg: { increment: input.quantityKg } } });
  return tx.locationTransfer.create({ data: { tenantId: input.tenantId, lotId: input.lotId, sourceLocationId: input.sourceLocationId, destinationLocationId: input.destinationLocationId, quantityKg: input.quantityKg, notes: input.notes, status: "COMPLETED", completedAt: new Date(), createdById: input.userId } });
}

/**
 * Atomically transfer quantity of a lot from one location to another.
 * Decrements source LotPlacement, increments (or upserts) destination
 * LotPlacement. Validates that source has sufficient quantity.
 */
export async function transferLot(data: {
  lotId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  quantityKg?: number;
  quantityUnit?: number;
  supplyQty?: number;
  notes?: string;
}): Promise<TransferActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const userId = await getSystemUserId();
    const tp = await requireTenantPrisma();

    if (data.sourceLocationId === data.destinationLocationId) {
      return { success: false, error: "Sumber dan tujuan tidak boleh sama." };
    }

    const qtyKg = Number(data.quantityKg ?? 0);
    const qtyUnit = Number(data.quantityUnit ?? 0);
    const qtySupply = Number(data.supplyQty ?? 0);

    if (qtyKg < 0 || qtyUnit < 0 || qtySupply < 0) {
      return { success: false, error: "Jumlah tidak boleh negatif." };
    }
    if (qtyKg === 0 && qtyUnit === 0 && qtySupply === 0) {
      return { success: false, error: "Jumlah harus lebih dari 0." };
    }

    const transferId = await tp.$transaction(async (tx) => {
      const lot = await tx.lot.findUnique({
        where: { id: data.lotId, tenantId },
        select: {
          quantityKg: true,
          quantityUnit: true,
          supplyItemId: true,
          productId: true,
          packagingId: true,
          consumedAt: true,
          product: { select: { type: true } },
        },
      });
      if (!lot) {
        throw new Error("LOT_NOT_FOUND");
      }
      if (lot.consumedAt) {
        throw new Error("CONSUMED_LOT");
      }

      const [sourceLocation, destinationLocation] = await Promise.all([
        tx.location.findFirst({
          where: { id: data.sourceLocationId, tenantId, isActive: true, warehouse: { isActive: true } },
          select: { isSystem: true },
        }),
        tx.location.findFirst({
          where: { id: data.destinationLocationId, tenantId, isActive: true, warehouse: { isActive: true } },
          select: { isSystem: true },
        }),
      ]);
      if (!sourceLocation || !destinationLocation) {
        throw new Error("LOCATION_NOT_FOUND");
      }
      if (isSystemLocation(sourceLocation)) {
        throw new Error("SYS_LOCATION_SOURCE");
      }
      if (isSystemLocation(destinationLocation)) {
        throw new Error("SYS_LOCATION_DESTINATION");
      }

      const validDimension = lot.supplyItemId
        ? qtySupply > 0 && qtyKg === 0 && qtyUnit === 0
        : lot.packagingId || lot.product?.type === "FINISHED_GOODS"
          ? qtyUnit > 0 && qtyKg === 0 && qtySupply === 0
          : Boolean(lot.productId) && qtyKg > 0 && qtyUnit === 0 && qtySupply === 0;
      if (!validDimension) {
        throw new Error("INVALID_LOT_DIMENSION");
      }

      const sourcePlacement = await tx.lotPlacement.findFirst({
        where: { tenantId, lotId: data.lotId, locationId: data.sourceLocationId },
      });

      if (!sourcePlacement) {
        throw new Error("SOURCE_PLACEMENT_NOT_FOUND");
      }

      const sourceKg = Number(sourcePlacement.quantityKg);
      const sourceUnit = sourcePlacement.quantityUnit;
      const sourceSupply = Number(sourcePlacement.supplyQty);

      if (lot.productId && Number(lot.quantityKg) > 0) {
        if (qtyKg > sourceKg) {
          throw new Error("INSUFFICIENT_SOURCE_KG");
        }
      }
      if (qtyUnit > sourceUnit) {
        throw new Error("INSUFFICIENT_SOURCE_UNIT");
      }
      if (qtySupply > sourceSupply) {
        throw new Error("INSUFFICIENT_SOURCE_SUPPLY");
      }

      // Guarded decrement (pola consumeLotPlacements): kondisi gte pada where
      // mencegah dua transfer konkuren sama-sama lolos cek lalu membuat
      // quantityKg/placement negatif (check-then-act race di READ COMMITTED).
      const decremented = await tx.lotPlacement.updateMany({
        where: {
          id: sourcePlacement.id,
          ...(qtyKg > 0 ? { quantityKg: { gte: qtyKg } } : {}),
          ...(qtyUnit > 0 ? { quantityUnit: { gte: qtyUnit } } : {}),
          ...(qtySupply > 0 ? { supplyQty: { gte: qtySupply } } : {}),
        },
        data: {
          quantityKg: { decrement: qtyKg },
          quantityUnit: { decrement: qtyUnit },
          supplyQty: { decrement: qtySupply },
        },
      });
      if (decremented.count !== 1) {
        // Kalah race dengan transfer lain — placement berubah sejak dibaca.
        // Baca ulang untuk melempar error kekurangan yang tepat.
        const fresh = await tx.lotPlacement.findUnique({
          where: { id: sourcePlacement.id },
          select: { quantityKg: true, quantityUnit: true, supplyQty: true },
        });
        if (qtyKg > Number(fresh?.quantityKg ?? 0)) {
          throw new Error("INSUFFICIENT_SOURCE_KG");
        }
        if (qtyUnit > (fresh?.quantityUnit ?? 0)) {
          throw new Error("INSUFFICIENT_SOURCE_UNIT");
        }
        if (qtySupply > Number(fresh?.supplyQty ?? 0)) {
          throw new Error("INSUFFICIENT_SOURCE_SUPPLY");
        }
        throw new Error("SOURCE_PLACEMENT_CHANGED");
      }

      await tx.lotPlacement.upsert({
        where: {
          tenantId_lotId_locationId: {
            tenantId,
            lotId: data.lotId,
            locationId: data.destinationLocationId,
          },
        },
        create: {
          tenantId,
          lotId: data.lotId,
          locationId: data.destinationLocationId,
          quantityKg: qtyKg,
          quantityUnit: qtyUnit,
          supplyQty: qtySupply,
        },
        update: {
          quantityKg: { increment: qtyKg },
          quantityUnit: { increment: qtyUnit },
          supplyQty: { increment: qtySupply },
        },
      });

      const transfer = await tx.locationTransfer.create({
        data: {
          tenantId,
          lotId: data.lotId,
          sourceLocationId: data.sourceLocationId,
          destinationLocationId: data.destinationLocationId,
          quantityKg: qtyKg || null,
          quantityUnit: qtyUnit || null,
          supplyQty: qtySupply || null,
          notes: data.notes,
          status: "COMPLETED",
          completedAt: new Date(),
          createdById: userId,
        },
      });

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "TRANSFER_LOT",
        entityType: "LocationTransfer",
        entityId: transfer.id,
        metadata: {
          lotId: data.lotId,
          sourceLocationId: data.sourceLocationId,
          destinationLocationId: data.destinationLocationId,
          quantityKg: qtyKg,
          quantityUnit: qtyUnit,
          supplyQty: qtySupply,
        },
      });

      return transfer.id;
    });

    revalidatePath("/gudang");
    revalidatePath("/inventory/lots");
    revalidatePath(`/inventory/lots/${data.lotId}`);
    return { success: true, transferId };
  } catch (err: any) {
    console.error("[transferLot]", err);
    const msg = err?.message ?? "Gagal memindah lot.";
    if (msg === "LOT_NOT_FOUND") return { success: false, error: "Lot tidak ditemukan." };
    if (msg === "CONSUMED_LOT") return { success: false, error: "Lot sudah terkonsumsi; tidak dapat dipindah." };
    if (msg === "LOCATION_NOT_FOUND") return { success: false, error: "Lokasi tidak ditemukan." };
    if (msg === "SYS_LOCATION_SOURCE" || msg === "SYS_LOCATION_DESTINATION") {
      return { success: false, error: SYSTEM_LOCATION_ERROR };
    }
    if (msg === "SOURCE_PLACEMENT_NOT_FOUND") return { success: false, error: "Lot tidak ditempatkan di lokasi sumber." };
    if (msg === "INSUFFICIENT_SOURCE_KG") return { success: false, error: "Stok kg di lokasi sumber tidak mencukupi." };
    if (msg === "INSUFFICIENT_SOURCE_UNIT") return { success: false, error: "Stok unit di lokasi sumber tidak mencukupi." };
    if (msg === "INSUFFICIENT_SOURCE_SUPPLY") return { success: false, error: "Stok supply di lokasi sumber tidak mencukupi." };
    if (msg === "INVALID_LOT_DIMENSION") return { success: false, error: "Satuan transfer tidak sesuai dengan jenis lot." };
    if (msg === "SOURCE_PLACEMENT_CHANGED") return { success: false, error: "Stok lokasi berubah saat transfer diproses. Coba ulangi." };
    return { success: false, error: msg };
  }
}

/**
 * List transfer history for a given lot.
 */
export async function getTransferHistory(lotId: string): Promise<TransferRow[]> {
  const tenantId = await getCurrentTenantId();
  const transfers = await requireTenantPrisma().then((tp) =>
    tp.locationTransfer.findMany({
      where: { tenantId, lotId },
      include: {
        lot: { select: { batchCode: true, product: { select: { name: true } } } },
        sourceLocation: { include: { warehouse: { select: { name: true } } } },
        destinationLocation: { include: { warehouse: { select: { name: true } } } },
        createdBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return transfers.map((t) => ({
    id: t.id,
    lotId: t.lotId,
    batchCode: t.lot.batchCode,
    productName: t.lot.product?.name ?? null,
    sourceLocationName: t.sourceLocation.name,
    sourceWarehouseName: t.sourceLocation.warehouse.name,
    destinationLocationName: t.destinationLocation.name,
    destinationWarehouseName: t.destinationLocation.warehouse.name,
    quantityKg: t.quantityKg ? Number(t.quantityKg) : null,
    quantityUnit: t.quantityUnit ?? null,
    supplyQty: t.supplyQty ? Number(t.supplyQty) : null,
    status: t.status,
    notes: t.notes,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  }));
}
