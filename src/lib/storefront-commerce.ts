import { appendFefoLedgerOut, appendLedger } from "./stock";
import { postSalesInvoice, postVoidReversal } from "./posting";
import { Prisma } from "@prisma/client";

// GrindSize is not directly exported from Prisma namespace, use string type
// The actual enum values are: WHOLE_BEAN, COARSE, MEDIUM_COARSE, MEDIUM, MEDIUM_FINE, FINE, ESPRESSO, CUSTOM
type GrindSize = 
  | "WHOLE_BEAN" 
  | "COARSE" 
  | "MEDIUM_COARSE" 
  | "MEDIUM" 
  | "MEDIUM_FINE" 
  | "FINE" 
  | "ESPRESSO" 
  | "CUSTOM";

// Kept structural so the helper works with both PrismaClient and a transaction client.
type StorefrontTx = any;

// KG-based products hold their balance in stockKg; unit-based products in stockUnit.
export function isKgBasedProductType(type: string | null | undefined) {
  return type === "GREEN_BEAN" || type === "ROASTED_BEAN";
}

function roundKg(value: number) {
  return Math.round(value * 1000) / 1000;
}

// Lock the product row FOR UPDATE so concurrent checkouts serialize on the
// same row before reading availability — no oversell under READ COMMITTED.
async function lockProductForUpdate(tx: StorefrontTx, tenantId: string, productId: string) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id", "type", "stockKg", "stockUnit" FROM "products" WHERE "id" = $1 AND "tenantId" = $2 FOR UPDATE`,
    productId,
    tenantId,
  ) as Array<{ id: string; type: string; stockKg: string | number | null; stockUnit: string | number | null }>;
  return rows[0];
}

async function aggregateActiveReservations(tx: StorefrontTx, tenantId: string, productId: string) {
  const agg = await tx.stockReservation.aggregate({
    // Reservasi ACTIVE yang sudah lewat expiresAt tapi belum di-sweep cron
    // tidak boleh mengunci stok — hitung tersedia sejak kedaluwarsa.
    where: { tenantId, productId, status: "ACTIVE", expiresAt: { gt: new Date() } },
    _sum: { quantity: true, quantityKg: true },
  });
  return {
    units: Number(agg._sum.quantity ?? 0),
    kg: Number(agg._sum.quantityKg ?? 0),
  };
}

export type StorefrontRules = {
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  flatShippingRate: number;
  freeShippingMinimum: number | null;
  taxRate: number;
};

export function calculateStorefrontTotals(
  subtotal: number,
  shippingMethod: "PICKUP" | "LOCAL_DELIVERY" | "STORE_COURIER" | "COURIER",
  rules: StorefrontRules,
) {
  if (!Number.isFinite(subtotal) || subtotal < 0) throw new Error("Subtotal tidak valid.");
  const pickup = shippingMethod === "PICKUP";
  if (pickup && !rules.pickupEnabled) throw new Error("Pengambilan di lokasi sedang tidak tersedia.");
  if (!pickup && !rules.deliveryEnabled) throw new Error("Pengiriman sedang tidak tersedia.");

  const freeShipping = !pickup
    && rules.freeShippingMinimum !== null
    && subtotal >= rules.freeShippingMinimum;
  const shippingCost = pickup || freeShipping ? 0 : Math.max(0, Math.round(rules.flatShippingRate));
  const tax = Math.max(0, Math.round(subtotal * Math.max(0, rules.taxRate) / 100));
  return { subtotal, tax, shippingCost, grandTotal: subtotal + tax + shippingCost };
}

export async function fulfillWalkInSaleStock(
  tx: StorefrontTx,
  input: {
    tenantId: string;
    invoiceId: string;
    invoiceCode: string;
    createdById: string;
    items: Array<{ productId: string; quantity: number; quantityKg?: number | null }>;
  },
) {
  const items = [...input.items].sort((left, right) => left.productId.localeCompare(right.productId));

  // Reservations are promises to other customers. Lock the same product rows
  // used by reserveInvoiceStock before checking available-to-promise so a
  // walk-in handover cannot consume those promised units.
  for (const item of items) {
    const product = await lockProductForUpdate(tx, input.tenantId, item.productId);
    if (!product) throw new Error("Produk tidak ditemukan.");
    const reserved = await aggregateActiveReservations(tx, input.tenantId, item.productId);

    const isKgBased = isKgBasedProductType(product.type);
    if (isKgBased) {
      if (!Number.isFinite(item.quantityKg ?? NaN)) {
        throw new Error("quantityKg wajib diisi untuk produk berbasis kg.");
      }
      const requestedKg = Number(item.quantityKg);
      if (requestedKg <= 0) {
        throw new Error("Berat penjualan harus lebih dari 0 kg.");
      }
      const availableKg = Math.max(0, Number(product.stockKg ?? 0) - reserved.kg);
      if (requestedKg > availableKg) {
        if (reserved.kg > 0) {
          throw new Error(
            `Stok tersedia untuk kasir tidak cukup. ${reserved.kg.toFixed(3)} kg sedang dicadangkan untuk pesanan lain.`,
          );
        }
        throw new Error("Stok produk tidak cukup untuk menyelesaikan transaksi.");
      }
    } else {
      const availableUnits = Math.max(0, Number(product.stockUnit ?? 0) - reserved.units);
      if (item.quantity > availableUnits) {
        if (reserved.units > 0) {
          throw new Error(
            `Stok tersedia untuk kasir tidak cukup. ${reserved.units} unit sedang dicadangkan untuk pesanan lain.`,
          );
        }
        throw new Error("Stok produk tidak cukup untuk menyelesaikan transaksi.");
      }
    }
  }

  for (const item of items) {
    const product = await lockProductForUpdate(tx, input.tenantId, item.productId);
    if (!product) throw new Error("Produk tidak ditemukan.");
    const isKgBased = isKgBasedProductType(product.type);
    if (isKgBased) {
      await appendFefoLedgerOut(tx, {
        tenantId: input.tenantId,
        productId: item.productId,
        refType: "SALE_FG_OUT",
        refId: input.invoiceId,
        quantityKg: Number(item.quantityKg),
        notes: `Penjualan walk-in ${input.invoiceCode}`,
        createdById: input.createdById,
      });
    } else {
      await appendFefoLedgerOut(tx, {
        tenantId: input.tenantId,
        productId: item.productId,
        refType: "SALE_FG_OUT",
        refId: input.invoiceId,
        quantityUnit: item.quantity,
        notes: `Penjualan walk-in ${input.invoiceCode}`,
        createdById: input.createdById,
      });
    }
  }
}

export async function reserveInvoiceStock(
  tx: StorefrontTx,
  input: {
    tenantId: string;
    invoiceId: string;
    expiresAt: Date;
    items: Array<{ productId: string; quantity: number; quantityKg?: number | null; grindSize?: GrindSize | null; customGrindLabel?: string | null }>;
  },
) {
  let hasShortage = false;
  const items = [...input.items].sort((left, right) => left.productId.localeCompare(right.productId));
  for (const item of items) {
    const product = await lockProductForUpdate(tx, input.tenantId, item.productId);
    if (!product) throw new Error("Produk tidak ditemukan.");
    const reserved = await aggregateActiveReservations(tx, input.tenantId, item.productId);

    const isKgBased = isKgBasedProductType(product.type);
    if (isKgBased) {
      // Ketersediaan KG berasal dari stockKg (cache ledger) dikurangi
      // reservasi ACTIVE dalam kg — bukan dari stockUnit.
      // quantityKg WAJIB diisi untuk produk berbasis kg (ROASTED_BEAN/GREEN_BEAN).
      if (!Number.isFinite(item.quantityKg ?? NaN)) {
        throw new Error("quantityKg wajib diisi untuk produk berbasis kg.");
      }
      const requestedKg = Number(item.quantityKg);
      if (requestedKg <= 0) {
        throw new Error("Berat reservasi harus lebih dari 0 kg.");
      }
      const availableKg = Math.max(0, Number(product.stockKg ?? 0) - reserved.kg);
      const reservedKg = roundKg(Math.min(requestedKg, availableKg));
      const fullyReserved = reservedKg >= roundKg(requestedKg);
      hasShortage ||= !fullyReserved;

      if (reservedKg > 0) {
        await tx.stockReservation.create({
          data: {
            tenantId: input.tenantId,
            invoiceId: input.invoiceId,
            productId: item.productId,
            // `quantity` preserves the number of customer packages. For a
            // kg-backed product, quantityKg is the authoritative stock value.
            quantity: item.quantity,
            quantityKg: reservedKg,
            grindSize: item.grindSize ?? null,
            customGrindLabel: item.customGrindLabel ?? null,
            expiresAt: input.expiresAt,
          },
        });
      }
      if (!fullyReserved) {
        await tx.fulfillmentTask.create({
          data: {
            tenantId: input.tenantId,
            invoiceId: input.invoiceId,
            productId: item.productId,
            requestedQuantity: item.quantity,
            // A partial material reservation cannot be mapped safely to a
            // specific package when variants have different weights. Keep
            // the whole grouped line open until its exact kg requirement is met.
            reservedQuantity: 0,
            shortageQuantity: item.quantity,
            notes: "Dibuat otomatis dari checkout storefront; prioritaskan produksi dan packing.",
          },
        });
      }
      continue;
    }

    const availableUnits = Math.max(0, Number(product.stockUnit ?? 0) - reserved.units);
    const reservedUnits = Math.min(item.quantity, availableUnits);
    const shortage = item.quantity - reservedUnits;
    hasShortage ||= shortage > 0;

    if (reservedUnits > 0) {
      await tx.stockReservation.create({
        data: {
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          productId: item.productId,
          quantity: reservedUnits,
          quantityKg: null,
          grindSize: item.grindSize ?? null,
          customGrindLabel: item.customGrindLabel ?? null,
          expiresAt: input.expiresAt,
        },
      });
    }
    if (shortage > 0) {
      await tx.fulfillmentTask.create({
        data: {
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          productId: item.productId,
          requestedQuantity: item.quantity,
          reservedQuantity: reservedUnits,
          shortageQuantity: shortage,
          notes: "Dibuat otomatis dari checkout storefront; prioritaskan produksi dan packing.",
        },
      });
    }
  }
  return { hasShortage };
}

export async function markInvoicePaidForFulfillment(
  tx: StorefrontTx,
  input: { tenantId: string; invoiceId: string; invoiceCode: string; createdById: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const openTasks = await tx.fulfillmentTask.count({
    where: { tenantId: input.tenantId, invoiceId: input.invoiceId, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  await tx.invoice.update({
    where: { id: input.invoiceId },
    data: {
      paidAt: now,
      fulfillmentStatus: openTasks > 0 ? "NEEDS_PRODUCTION" : "READY_TO_PACK",
    },
  });
  return { consumedReservations: 0, hasOpenTasks: openTasks > 0 };
}

export async function fulfillInvoiceAtHandover(
  tx: StorefrontTx,
  input: { tenantId: string; invoiceId: string; createdById: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId },
    include: {
      customer: { select: { name: true } },
      items: {
        select: {
          productId: true,
          quantity: true,
          hpp: true,
          netWeightGrams: true,
          product: { select: { type: true } },
        },
      },
    },
  });
  if (!invoice) throw new Error("Invoice tidak ditemukan.");
  if (invoice.fulfillmentStatus === "DELIVERED") return { alreadyFulfilled: true };
  if (invoice.status === "VOID" || invoice.status === "RETURNED") throw new Error("Invoice tidak dapat diserahkan.");

  const openTasks = await tx.fulfillmentTask.count({
    where: { tenantId: input.tenantId, invoiceId: invoice.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  if (openTasks > 0) throw new Error("Produksi untuk pesanan ini belum selesai.");

  const reservations = await tx.stockReservation.findMany({
    where: { tenantId: input.tenantId, invoiceId: invoice.id, status: "ACTIVE" },
  });
  // Offering lines reserve in kg (1 unit = 1 kg on the roasted bean product);
  // product lines reserve in stock units. A single product is never used in
  // both modes, so the two maps stay independent per product.
  const kgReservedByProduct = new Map<string, number>();
  const unitReservedByProduct = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.quantityKg != null) {
      kgReservedByProduct.set(
        reservation.productId,
        (kgReservedByProduct.get(reservation.productId) ?? 0) + Number(reservation.quantityKg),
      );
    } else {
      unitReservedByProduct.set(
        reservation.productId,
        (unitReservedByProduct.get(reservation.productId) ?? 0) + Number(reservation.quantity),
      );
    }
  }
  for (const item of invoice.items) {
    const netWeightGrams = Number(item.netWeightGrams ?? 0);
    if (netWeightGrams > 0) {
      const requiredKg = Math.round((Number(item.quantity) * netWeightGrams / 1000) * 1000) / 1000;
      if ((kgReservedByProduct.get(item.productId) ?? 0) < requiredKg) {
        throw new Error("Stok pesanan belum seluruhnya dialokasikan.");
      }
    } else if ((unitReservedByProduct.get(item.productId) ?? 0) < Number(item.quantity)) {
      throw new Error("Stok pesanan belum seluruhnya dialokasikan.");
    }
  }

  for (const reservation of reservations) {
    // Kg-mode reservations (offering lines) consume the roasted bean product
    // balance in kg; unit-mode reservations consume stock units.
    const isKgReservation = reservation.quantityKg != null;
    await appendFefoLedgerOut(tx, {
      tenantId: input.tenantId,
      productId: reservation.productId,
      refType: "SALE_FG_OUT",
      refId: invoice.id,
      quantityUnit: isKgReservation ? 0 : Number(reservation.quantity),
      quantityKg: isKgReservation ? Number(reservation.quantityKg) : 0,
      notes: `Penyerahan pesanan: ${invoice.code}`,
      createdById: input.createdById,
    });
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { status: "CONSUMED", consumedAt: now },
    });
  }
  await postSalesInvoice(
    invoice.id,
    Number(invoice.grandTotal),
    Number(invoice.paidAmount),
    invoice.customer.name,
    invoice.items.map((item: { product: { type: string }; hpp: unknown; quantity: unknown }) => ({
      productType: item.product.type,
      hpp: Number(item.hpp),
      quantity: Number(item.quantity),
    })),
    { tx, tenantId: input.tenantId, userId: input.createdById, date: now },
    Number(invoice.tax),
    Number(invoice.pphWithholding ?? 0),
  );
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { fulfillmentStatus: "DELIVERED", deliveredAt: now },
  });
  await tx.fulfillmentTask.updateMany({
    where: { invoiceId: invoice.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
    data: { status: "COMPLETED", completedAt: now },
  });
  return { alreadyFulfilled: false, fulfilledReservations: reservations.length };
}

export async function releaseInvoiceReservations(
  tx: StorefrontTx,
  invoiceId: string,
  status: "RELEASED" | "EXPIRED" = "RELEASED",
  now = new Date(),
) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, tenantId: true, status: true, paidAmount: true, fulfillmentStatus: true, createdById: true, code: true },
  });
  if (!invoice) throw new Error("Invoice tidak ditemukan.");

  if (invoice.status === "PAID" || invoice.status === "PARTIAL" || Number(invoice.paidAmount) > 0) {
    throw new Error("Invoice yang sudah dibayar tidak dapat dibatalkan otomatis. Batalkan pembayaran terlebih dahulu.");
  }

  const saleEntries = await tx.inventoryLedger.findMany({
    where: { tenantId: invoice.tenantId, refId: invoiceId, refType: "SALE_FG_OUT", entryType: "OUT" },
  });

  if (saleEntries.length > 0) {
    for (const entry of saleEntries) {
      await appendLedger(tx, {
        data: {
          tenantId: invoice.tenantId,
          productId: entry.productId,
          entryType: "IN",
          refType: "VOID_REVERSAL",
          refId: invoiceId,
          reversalOfLedgerId: entry.id,
          quantityUnit: entry.quantityUnit,
          lotId: entry.lotId,
          lotNumber: entry.lotNumber,
          expiryDate: entry.expiryDate,
          notes: `VOID reversal: ${invoice.code}`,
          createdById: invoice.createdById,
        },
      });
      if (entry.lotId) {
        await tx.lot.update({ where: { id: entry.lotId }, data: { consumedAt: null } });
      }
    }
    await postVoidReversal("INVOICE", invoiceId, `Reservation ${status.toLowerCase()}`, { tx, tenantId: invoice.tenantId, userId: invoice.createdById, date: now });
  }

  await tx.stockReservation.updateMany({
    where: { invoiceId, status: "ACTIVE" },
    data: { status, releasedAt: now },
  });
  await tx.fulfillmentTask.updateMany({
    where: { invoiceId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    data: { status: "CANCELLED" },
  });
  await tx.invoice.update({ where: { id: invoiceId }, data: { fulfillmentStatus: "CANCELLED" } });
}

export async function allocateProducedStockToDemand(
  tx: StorefrontTx,
  input: { tenantId: string; productId: string; createdById: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const product = await lockProductForUpdate(tx, input.tenantId, input.productId);
  if (!product) throw new Error("Produk tidak ditemukan.");
  const isKgBased = isKgBasedProductType(product.type);
  const reserved = await aggregateActiveReservations(tx, input.tenantId, input.productId);
  // GB/RB products hold their balance in kg; FG/PACKAGING products in units.
  let available = isKgBased
    ? Math.max(0, Number(product.stockKg ?? 0) - reserved.kg)
    : Math.max(0, Number(product.stockUnit ?? 0) - reserved.units);
  if (available === 0) return { allocatedUnits: 0, completedTasks: 0 };

  const tasks = await tx.fulfillmentTask.findMany({
    where: { tenantId: input.tenantId, productId: input.productId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    include: {
      invoice: {
        select: {
          id: true,
          code: true,
          status: true,
          createdById: true,
          reservationExpiresAt: true,
          items: {
            where: { productId: input.productId },
            select: { quantity: true, netWeightGrams: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  let allocatedUnits = 0;
  let completedTasks = 0;
  for (const task of tasks) {
    if (available <= 0) break;
    if (task.invoice.status === "VOID" || task.invoice.status === "RETURNED") {
      await tx.fulfillmentTask.update({ where: { id: task.id }, data: { status: "CANCELLED" } });
      continue;
    }
    if (isKgBased) {
      const requiredKgFromSnapshot = roundKg(task.invoice.items.reduce(
        (sum: number, item: { quantity: unknown; netWeightGrams: unknown }) =>
          sum + (Number(item.quantity) * Number(item.netWeightGrams ?? 0) / 1000),
        0,
      ));
      // Legacy tasks created before offering snapshots used one task unit per
      // kg. Preserve that fallback, while new offering orders use exact weight.
      const requiredKg = requiredKgFromSnapshot > 0
        ? requiredKgFromSnapshot
        : Number(task.requestedQuantity);
      // Unique key (invoiceId, productId) diganti (invoiceId, productId,
      // grindSize) sejak migrasi 012. Jalur alokasi selalu tanpa grind
      // (grindSize null), dan NULL tidak unik di Postgres, jadi lookup +
      // branch manual menggantikan upsert compound key lama.
      const currentReservation = await tx.stockReservation.findFirst({
        where: { invoiceId: task.invoiceId, productId: input.productId, grindSize: null },
        select: { id: true, quantityKg: true },
      });
      const alreadyReservedKg = Number(currentReservation?.quantityKg ?? 0);
      const missingKg = roundKg(Math.max(0, requiredKg - alreadyReservedKg));
      const allocatedKg = roundKg(Math.min(available, missingKg));
      if (allocatedKg <= 0) continue;

      if (currentReservation) {
        await tx.stockReservation.update({
          where: { id: currentReservation.id },
          data: {
            quantity: task.requestedQuantity,
            quantityKg: { increment: allocatedKg },
            status: "ACTIVE",
            releasedAt: null,
          },
        });
      } else {
        await tx.stockReservation.create({
          data: {
            tenantId: input.tenantId,
            invoiceId: task.invoiceId,
            productId: input.productId,
            quantity: task.requestedQuantity,
            quantityKg: allocatedKg,
            expiresAt: task.invoice.reservationExpiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          },
        });
      }
      const completed = roundKg(missingKg - allocatedKg) <= 0;
      await tx.fulfillmentTask.update({
        where: { id: task.id },
        data: {
          reservedQuantity: completed ? task.requestedQuantity : 0,
          shortageQuantity: completed ? 0 : task.requestedQuantity,
          status: completed ? "COMPLETED" : "IN_PROGRESS",
          completedAt: completed ? now : null,
        },
      });
      if (completed) {
        completedTasks += 1;
        const remaining = await tx.fulfillmentTask.count({
          where: { invoiceId: task.invoiceId, id: { not: task.id }, status: { in: ["OPEN", "IN_PROGRESS"] } },
        });
        if (remaining === 0) {
          await tx.invoice.update({
            where: { id: task.invoiceId },
            data: { fulfillmentStatus: task.invoice.status === "PAID" ? "READY_TO_PACK" : "AWAITING_PAYMENT" },
          });
        }
        allocatedUnits += task.requestedQuantity;
      }
      available = roundKg(available - allocatedKg);
      continue;
    }

    const allocated = Math.min(available, task.shortageQuantity);
    const allocatedUnitsDelta = allocated;
    // Compound key lama (invoiceId, productId) sudah tidak ada sejak migrasi
    // 012 — pakai findFirst + branch manual (grindSize null tidak unik di PG).
    const currentUnitReservation = await tx.stockReservation.findFirst({
      where: { invoiceId: task.invoiceId, productId: input.productId, grindSize: null },
      select: { id: true },
    });
    if (currentUnitReservation) {
      await tx.stockReservation.update({
        where: { id: currentUnitReservation.id },
        data: {
          quantity: { increment: allocatedUnitsDelta },
          quantityKg: undefined,
          status: "ACTIVE",
          releasedAt: null,
        },
      });
    } else {
      await tx.stockReservation.create({
        data: {
          tenantId: input.tenantId, invoiceId: task.invoiceId, productId: input.productId,
          quantity: allocatedUnitsDelta,
          quantityKg: null,
          expiresAt: task.invoice.reservationExpiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1_000),
        },
      });
    }
    const shortageQuantity = task.shortageQuantity - allocatedUnitsDelta;
    const completed = shortageQuantity === 0;
    await tx.fulfillmentTask.update({
      where: { id: task.id },
      data: {
        reservedQuantity: { increment: allocatedUnitsDelta }, shortageQuantity,
        status: completed ? "COMPLETED" : "IN_PROGRESS", completedAt: completed ? now : null,
      },
    });
    if (completed) {
      completedTasks += 1;
      const remaining = await tx.fulfillmentTask.count({
        where: { invoiceId: task.invoiceId, id: { not: task.id }, status: { in: ["OPEN", "IN_PROGRESS"] } },
      });
      if (remaining === 0) {
        await tx.invoice.update({
          where: { id: task.invoiceId },
          data: { fulfillmentStatus: task.invoice.status === "PAID" ? "READY_TO_PACK" : "AWAITING_PAYMENT" },
        });
      }
    }
    available -= allocated;
    allocatedUnits += allocatedUnitsDelta;
  }
  return { allocatedUnits, completedTasks };
}
