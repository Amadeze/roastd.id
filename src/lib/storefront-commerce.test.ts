import { describe, expect, it, vi } from "vitest";
import { allocateProducedStockToDemand, calculateStorefrontTotals } from "./storefront-commerce";

const rules = {
  pickupEnabled: true,
  deliveryEnabled: true,
  flatShippingRate: 20_000,
  freeShippingMinimum: 300_000,
  taxRate: 11,
};

describe("calculateStorefrontTotals", () => {
  it("keeps pickup free and calculates tenant tax", () => {
    expect(calculateStorefrontTotals(100_000, "PICKUP", rules)).toEqual({
      subtotal: 100_000, tax: 11_000, shippingCost: 0, grandTotal: 111_000,
    });
  });

  it("applies flat shipping below the free-shipping minimum", () => {
    expect(calculateStorefrontTotals(100_000, "LOCAL_DELIVERY", rules).grandTotal).toBe(131_000);
  });

  it("waives shipping at the configured minimum", () => {
    expect(calculateStorefrontTotals(300_000, "COURIER", rules).shippingCost).toBe(0);
  });

  it("rejects a disabled delivery method", () => {
    expect(() => calculateStorefrontTotals(100_000, "COURIER", { ...rules, deliveryEnabled: false })).toThrow();
  });
});

describe("allocateProducedStockToDemand", () => {
  function transaction() {
    return {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        { id: "finished-good-1", type: "FINISHED_GOODS", stockKg: 0, stockUnit: 2000 },
      ]),
      stockReservation: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null, quantityKg: null } }),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      fulfillmentTask: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: { update: vi.fn().mockResolvedValue({}) },
    };
  }

  function tasks(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `task-${i}`,
      invoiceId: `invoice-${i}`,
      shortageQuantity: 10,
      reservedQuantity: 0,
      status: "OPEN",
      invoice: {
        id: `invoice-${i}`,
        code: `INV-${String(i).padStart(4, "0")}`,
        status: "UNPAID",
        createdById: "user-1",
        reservationExpiresAt: null,
        items: [],
      },
    }));
  }

  it("allocates to demands beyond the 100-task cap without leaving stock idle", async () => {
    const tx = transaction();
    const openTasks = tasks(105);
    tx.fulfillmentTask.findMany.mockImplementation(({ take } = {}) =>
      Promise.resolve(take ? openTasks.slice(0, take) : openTasks),
    );

    const result = await allocateProducedStockToDemand(tx, {
      tenantId: "tenant-1",
      productId: "finished-good-1",
      createdById: "user-1",
    });

    expect(result).toEqual({ allocatedUnits: 1050, completedTasks: 105 });
    expect(tx.stockReservation.create).toHaveBeenCalledTimes(105);
    expect(tx.fulfillmentTask.update).toHaveBeenCalledTimes(105);
    expect(tx.fulfillmentTask.update).toHaveBeenCalledWith({
      where: { id: "task-104" },
      data: expect.objectContaining({ status: "COMPLETED", shortageQuantity: 0 }),
    });
    expect(tx.invoice.update).toHaveBeenCalledTimes(105);
  });

  it("does not allocate to cancelled or voided invoices within the batch", async () => {
    const tx = transaction();
    const openTasks = tasks(102);
    openTasks[50].invoice.status = "VOID";
    tx.fulfillmentTask.findMany.mockImplementation(({ take } = {}) =>
      Promise.resolve(take ? openTasks.slice(0, take) : openTasks),
    );

    const result = await allocateProducedStockToDemand(tx, {
      tenantId: "tenant-1",
      productId: "finished-good-1",
      createdById: "user-1",
    });

    expect(result.allocatedUnits).toBe(1010);
    expect(result.completedTasks).toBe(101);
    expect(tx.fulfillmentTask.update).toHaveBeenCalledWith({
      where: { id: "task-50" },
      data: { status: "CANCELLED" },
    });
    expect(tx.stockReservation.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invoiceId: "invoice-50", productId: "finished-good-1" }) }),
    );
  });
});
