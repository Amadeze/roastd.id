import { describe, expect, it, vi } from "vitest";

import { appendFefoLedgerOut, appendLedger, recomputeProductCostInTx } from "./stock";

function transaction(updateCount = 1) {
  return {
    product: {
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
    packaging: {
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
      findUnique: vi.fn(),
    },
    inventoryLedger: {
      create: vi.fn(async ({ data }) => ({ id: "ledger-1", ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    lot: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    lotPlacement: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventorySupplyItem: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    roastMaterialReservation: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantityKg: null } }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

describe("appendLedger", () => {
  it("normalizes the existing { data } call shape", async () => {
    const tx = transaction();
    await appendLedger(tx, {
      data: {
        productId: "product-1",
        entryType: "IN",
        refType: "ADJUSTMENT_IN",
        refId: "ref-1",
        quantityUnit: 5,
        createdById: "user-1",
      },
    });

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { stockUnit: { increment: 5 } },
    });
    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: "product-1", quantityUnit: 5 }),
    });
  });

  it("atomically rejects outbound stock that is unavailable", async () => {
    const tx = transaction(0);

    await expect(
      appendLedger(tx, {
        data: {
          productId: "product-1",
          entryType: "OUT",
          refType: "SALE_FG_OUT",
          refId: "invoice-1",
          quantityUnit: 6,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("Stok produk tidak cukup");

    expect(tx.inventoryLedger.create).not.toHaveBeenCalled();
  });

  it("rejects kg OUT when the quantity is committed to active/charged roast reservations", async () => {
    const tx = transaction(0);
    tx.roastMaterialReservation.aggregate.mockResolvedValue({
      _sum: { quantityKg: 8 },
    });

    await expect(
      appendLedger(tx, {
        data: {
          tenantId: "tenant-1",
          productId: "green-bean-1",
          entryType: "OUT",
          refType: "EXPERIMENTAL_COMPONENT_OUT",
          refId: "eksperimen-batch-1",
          quantityKg: 5,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("sedang dicadangkan untuk roasting");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "green-bean-1", stockKg: { gte: 13 } },
      data: { stockKg: { decrement: 5 }, avgCostPerKg: undefined },
    });
    expect(tx.inventoryLedger.create).not.toHaveBeenCalled();
  });

  it("counts only ACTIVE/CHARGED reservations of the same product, excluding the caller's own batch", async () => {
    const tx = transaction(0);
    tx.roastMaterialReservation.aggregate.mockResolvedValue({
      _sum: { quantityKg: 8 },
    });

    await appendLedger(tx, {
      data: {
        tenantId: "tenant-1",
        productId: "green-bean-1",
        entryType: "OUT",
        refType: "ROASTING_GB_OUT",
        refId: "batch-1",
        quantityKg: 8,
        createdById: "user-1",
      },
    }).catch(() => {});

    expect(tx.roastMaterialReservation.aggregate).toHaveBeenCalledWith({
      _sum: { quantityKg: true },
      where: {
        tenantId: "tenant-1",
        status: { in: ["ACTIVE", "CHARGED"] },
        parentBatchId: { not: "batch-1" },
        lot: { productId: "green-bean-1" },
      },
    });
  });

  it("does not query reservations for inbound or unit-only entries", async () => {
    const tx = transaction();

    await appendLedger(tx, {
      data: {
        tenantId: "tenant-1",
        productId: "product-1",
        entryType: "IN",
        refType: "PURCHASE_GB",
        refId: "purchase-1",
        quantityKg: 5,
        createdById: "user-1",
      },
    });

    expect(tx.roastMaterialReservation.aggregate).not.toHaveBeenCalled();
  });

  it("requires exactly one inventory target and a positive quantity", async () => {
    const tx = transaction();

    await expect(
      appendLedger(tx, {
        data: {
          productId: "product-1",
          packagingId: "packaging-1",
          entryType: "IN",
          quantityUnit: 1,
        },
      }),
    ).rejects.toThrow("exactly one");

    await expect(
      appendLedger(tx, {
        data: {
          productId: "product-1",
          entryType: "IN",
          quantityUnit: 0,
        },
      }),
    ).rejects.toThrow("greater than zero");
  });

  it("stores lotNumber and expiryDate on ledger entry", async () => {
    const tx = transaction();
    await appendLedger(tx, {
      data: {
        productId: "product-1",
        entryType: "IN",
        refType: "PURCHASE_GB",
        refId: "purchase-1",
        quantityKg: 50,
        lotNumber: "LOT-2024-001",
        expiryDate: new Date("2025-06-01"),
        createdById: "user-1",
      },
    });

    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lotNumber: "LOT-2024-001",
        expiryDate: new Date("2025-06-01"),
        quantityKg: 50,
      }),
    });
  });

  it("computes weighted average cost for product (GB/RB)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "100",
      stockUnit: 0,
      avgCostPerKg: "50000",
    });

    await appendLedger(tx, {
      data: {
        productId: "product-1",
        entryType: "IN",
        refType: "PURCHASE_GB",
        refId: "purchase-2",
        quantityKg: 50,
        incomingPrice: 60000,
        createdById: "user-1",
      },
    });

    const expectedAvg = (100 * 50000 + 50 * 60000) / (100 + 50);
    expect(tx.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "product-1" },
        data: expect.objectContaining({
          stockKg: { increment: 50 },
          avgCostPerKg: expectedAvg,
        }),
      }),
    );
  });

  it("computes weighted average cost for packaging", async () => {
    const tx = transaction();
    tx.packaging.findUnique = vi.fn().mockResolvedValue({
      stockUnit: 200,
      avgCostPerUnit: "5000",
    });

    await appendLedger(tx, {
      data: {
        packagingId: "packaging-1",
        entryType: "IN",
        refType: "PURCHASE_PKG",
        refId: "purchase-3",
        quantityUnit: 100,
        incomingPrice: 5500,
        createdById: "user-1",
      },
    });

    const expectedAvg = (200 * 5000 + 100 * 5500) / (200 + 100);
    expect(tx.packaging.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "packaging-1" },
        data: expect.objectContaining({
          stockUnit: { increment: 100 },
          avgCostPerUnit: expectedAvg,
        }),
      }),
    );
  });

  it("rejects IN entry with incomingPrice for FG (unit-based)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "0",
      stockUnit: 10,
      avgCostPerKg: "0",
    });

    await appendLedger(tx, {
      data: {
        productId: "product-fg-1",
        entryType: "IN",
        refType: "PRODUCTION_FG_IN",
        refId: "batch-1",
        quantityUnit: 50,
        incomingPrice: 15000,
        createdById: "user-1",
      },
    });

    // FG should NOT update avgCostPerKg — only stockUnit
    const updateCall = (tx.product.updateMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0].data.stockUnit).toEqual({ increment: 50 });
    expect(updateCall[0].data.avgCostPerKg).toBeUndefined();
  });

  it("supply IN: updates supply cache with moving average and writes supplyQuantity only", async () => {
    const tx = transaction();
    tx.inventorySupplyItem.findUnique = vi.fn().mockResolvedValue({
      tenantId: "tenant-1",
      stockQuantity: "40",
      avgCostPerUnit: "5000",
    });

    await appendLedger(tx, {
      data: {
        tenantId: "tenant-1",
        supplyItemId: "supply-1",
        entryType: "IN",
        refType: "SUPPLY_PURCHASE_IN",
        refId: "purchase-1",
        supplyQuantity: 10,
        incomingPrice: 5500,
        createdById: "user-1",
      },
    });

    const expectedAvg = (40 * 5000 + 10 * 5500) / (40 + 10);
    expect(tx.inventorySupplyItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "supply-1", tenantId: "tenant-1" },
        data: {
          stockQuantity: { increment: 10 },
          avgCostPerUnit: expectedAvg,
        },
      }),
    );
    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplyItemId: "supply-1",
        supplyQuantity: 10,
      }),
    });
    expect(tx.packaging.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("supply entry must not use quantityKg/quantityUnit and quantity must be positive", async () => {
    const tx = transaction();

    await expect(
      appendLedger(tx, {
        data: {
          tenantId: "tenant-1",
          supplyItemId: "supply-1",
          entryType: "IN",
          refType: "SUPPLY_PURCHASE_IN",
          refId: "purchase-1",
          quantityKg: 5,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("Supply quantity must be a positive number.");

    await expect(
      appendLedger(tx, {
        data: {
          tenantId: "tenant-1",
          supplyItemId: "supply-1",
          entryType: "IN",
          refType: "SUPPLY_PURCHASE_IN",
          refId: "purchase-1",
          supplyQuantity: 0,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("positive");

    await expect(
      appendLedger(tx, {
        data: {
          tenantId: "tenant-1",
          supplyItemId: "supply-1",
          packagingId: "packaging-1",
          entryType: "IN",
          refType: "SUPPLY_PURCHASE_IN",
          refId: "purchase-1",
          supplyQuantity: 1,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("exactly one");
  });

  it("supply OUT: rejects with controlled error when cache stock is insufficient", async () => {
    const tx = transaction();
    tx.inventorySupplyItem.updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      appendLedger(tx, {
        data: {
          tenantId: "tenant-1",
          supplyItemId: "supply-1",
          entryType: "OUT",
          refType: "SUPPLY_ADJUSTMENT_OUT",
          refId: "opname-1",
          supplyQuantity: 6,
          createdById: "user-1",
        },
      }),
    ).rejects.toThrow("Stok supply tidak cukup");

    expect(tx.inventoryLedger.create).not.toHaveBeenCalled();
  });
});

describe("appendFefoLedgerOut", () => {
  it("depletes placed stock with the canonical lot consumption", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([{ id: "lot-1" }]);
    tx.lot.findMany.mockResolvedValue([
      {
        id: "lot-1",
        batchCode: "LOT-1",
        expiryDate: null,
        quantityKg: 10,
        quantityUnit: 0,
        supplyQuantity: 0,
        inventoryLedgers: [{ entryType: "IN", quantityKg: 10, quantityUnit: null, supplyQuantity: null }],
      },
    ]);
    tx.lotPlacement.findMany.mockResolvedValue([
      { id: "placement-a", quantityKg: 4, quantityUnit: 0, supplyQty: 0 },
      { id: "placement-b", quantityKg: 6, quantityUnit: 0, supplyQty: 0 },
    ]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 7,
      refType: "ROASTING_GB_OUT",
      refId: "roast-1",
      createdById: "user-1",
    });

    expect(tx.lotPlacement.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "placement-a", tenantId: "tenant-1", quantityKg: { gte: 4 } },
      data: { quantityKg: { decrement: 4 } },
    });
expect(tx.lotPlacement.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "placement-b", tenantId: "tenant-1", quantityKg: { gte: 3 } },
      data: { quantityKg: { decrement: 3 } },
    });
  });

  it("uses grouped ledger totals rather than the original lot quantity", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([{ id: "lot-1" }]);
    tx.lot.findMany.mockResolvedValue([{
      id: "lot-1", batchCode: "LOT-1", expiryDate: null,
      quantityKg: 10, quantityUnit: 0, supplyQuantity: 0,
    }]);
    tx.inventoryLedger.groupBy.mockResolvedValue([
      { lotId: "lot-1", entryType: "IN", _sum: { quantityKg: 10, quantityUnit: null, supplyQuantity: null }, _count: { _all: 1 } },
      { lotId: "lot-1", entryType: "OUT", _sum: { quantityKg: 7, quantityUnit: null, supplyQuantity: null }, _count: { _all: 1 } },
    ]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1", productId: "green-bean-1", quantityKg: 5,
      refType: "ROASTING_GB_OUT", refId: "roast-1", createdById: "user-1",
    });

    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ lotId: "lot-1", quantityKg: 3 }),
    });
    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ lotId: null, quantityKg: 2 }),
    });
  });

  it("excludes reversal rows when aggregating a lot's FEFO balance", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([{ id: "lot-1" }]);
    tx.lot.findMany.mockResolvedValue([{
      id: "lot-1", batchCode: "LOT-1", expiryDate: null,
      quantityKg: 10, quantityUnit: 0, supplyQuantity: 0,
    }]);
    tx.inventoryLedger.groupBy.mockResolvedValue([]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1", productId: "green-bean-1", quantityKg: 1,
      refType: "ROASTING_GB_OUT", refId: "roast-1", createdById: "user-1",
    });

    expect(tx.inventoryLedger.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        NOT: [
          { refType: "VOID_REVERSAL" },
          { reversalOfLedgerId: { not: null } },
        ],
      }),
    }));
  });

  it("never targets placements at system locations (e.g. Roasting WIP)", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([{ id: "lot-1" }]);
    tx.lot.findMany.mockResolvedValue([
      {
        id: "lot-1",
        batchCode: "LOT-1",
        expiryDate: null,
        quantityKg: 10,
        quantityUnit: 0,
        supplyQuantity: 0,
        inventoryLedgers: [{ entryType: "IN", quantityKg: 10, quantityUnit: null, supplyQuantity: null }],
      },
    ]);
    tx.lotPlacement.findMany.mockResolvedValue([
      { id: "placement-wip", quantityKg: 10, quantityUnit: 0, supplyQty: 0 },
    ]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 7,
      refType: "GRINDING_RB_OUT",
      refId: "grind-1",
      createdById: "user-1",
    });

    expect(tx.lotPlacement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ location: { isSystem: false } }),
      }),
    );
  });

  it("supply FEFO: allocates supplyQuantity from earliest expiry lot first", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([
      { id: "lot-early" },
      { id: "lot-later" },
    ]);
    tx.lot.findMany.mockResolvedValue([
      {
        id: "lot-early",
        batchCode: "LOT-EARLY",
        expiryDate: new Date("2026-08-01"),
        quantityKg: 0,
        quantityUnit: 0,
        supplyQuantity: 5,
        inventoryLedgers: [{ entryType: "IN", quantityKg: null, quantityUnit: null, supplyQuantity: 5 }],
      },
      {
        id: "lot-later",
        batchCode: "LOT-LATER",
        expiryDate: new Date("2026-12-01"),
        quantityKg: 0,
        quantityUnit: 0,
        supplyQuantity: 10,
        inventoryLedgers: [{ entryType: "IN", quantityKg: null, quantityUnit: null, supplyQuantity: 10 }],
      },
    ]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      supplyItemId: "supply-1",
      supplyQuantity: 8,
      refType: "SUPPLY_ADJUSTMENT_OUT",
      refId: "opname-1",
      createdById: "user-1",
    });

    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        lotId: "lot-early",
        supplyQuantity: 5,
        supplyItemId: "supply-1",
      }),
    });
    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ lotId: "lot-later", supplyQuantity: 3 }),
    });
    expect(tx.lot.update).toHaveBeenCalledWith({
      where: { id: "lot-early" },
      data: { consumedAt: expect.any(Date) },
    });
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it("allocates from the earliest expiry first and closes exhausted lots", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([
      { id: "lot-early" },
      { id: "lot-later" },
    ]);
    tx.lot.findMany.mockResolvedValue([
      {
        id: "lot-early",
        batchCode: "LOT-EARLY",
        expiryDate: new Date("2026-08-01"),
        quantityKg: 5,
        quantityUnit: 0,
        inventoryLedgers: [{ entryType: "IN", quantityKg: 5, quantityUnit: null }],
      },
      {
        id: "lot-later",
        batchCode: "LOT-LATER",
        expiryDate: new Date("2026-12-01"),
        quantityKg: 10,
        quantityUnit: 0,
        inventoryLedgers: [{ entryType: "IN", quantityKg: 10, quantityUnit: null }],
      },
    ]);

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 8,
      refType: "ROASTING_GB_OUT",
      refId: "roast-1",
      createdById: "user-1",
    });

    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ lotId: "lot-early", quantityKg: 5 }),
    });
    expect(tx.inventoryLedger.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ lotId: "lot-later", quantityKg: 3 }),
    });
    expect(tx.lot.update).toHaveBeenCalledWith({
      where: { id: "lot-early" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("uses an untracked fallback for legacy stock without lots", async () => {
    const tx = transaction();

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "finished-good-1",
      quantityUnit: 4,
      refType: "SALE_FG_OUT",
      refId: "invoice-1",
      createdById: "user-1",
    });

    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lotId: null,
        productId: "finished-good-1",
        quantityUnit: 4,
      }),
    });
  });

  it("consumes across more than 20 lots in FIFO order when demand exceeds the oldest 20", async () => {
    const tx = transaction();
    const lots = Array.from({ length: 25 }, (_, i) => ({
      id: `lot-${i + 1}`,
      batchCode: `LOT-${i + 1}`,
      expiryDate: new Date(2026, 7, i + 2),
      quantityKg: 1,
      quantityUnit: 0,
      inventoryLedgers: [{ entryType: "IN", quantityKg: 1, quantityUnit: null }],
    }));
    tx.$queryRaw.mockResolvedValue(lots.map((l) => ({ id: l.id })));
    tx.lot.findMany = vi.fn().mockImplementation((args: any) =>
      Promise.resolve(args?.take !== undefined ? lots.slice(0, args.take) : lots),
    );

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 22,
      refType: "ROASTING_GB_OUT",
      refId: "roast-1",
      createdById: "user-1",
    });

    const createCalls = (tx.inventoryLedger.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(createCalls).toHaveLength(22);
    const consumedLotIds = createCalls.map((c) => c[0].data.lotId);
    expect(consumedLotIds).toEqual(Array.from({ length: 22 }, (_, i) => `lot-${i + 1}`));
    expect(consumedLotIds).not.toContain(null);
    const updatedLotIds = (tx.lot.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].where.id,
    );
    expect(updatedLotIds).toEqual(Array.from({ length: 22 }, (_, i) => `lot-${i + 1}`));
  });

  it("allocates from lots beyond the 20-batch cap without falling back to untracked", async () => {
    const tx = transaction();
    const lots = Array.from({ length: 25 }, (_, i) => ({
      id: `lot-${i}`,
      batchCode: `LOT-${String(i).padStart(2, "0")}`,
      expiryDate: new Date(Date.UTC(2026, 7 + i, 1)),
      quantityKg: 5,
      quantityUnit: 0,
      inventoryLedgers: [{ entryType: "IN", quantityKg: 5, quantityUnit: null }],
    }));
    tx.$queryRaw.mockResolvedValue(lots.map((l) => ({ id: l.id })));
    tx.lot.findMany.mockImplementation(({ take } = {}) => Promise.resolve(take ? lots.slice(0, take) : lots));

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 103,
      refType: "ROASTING_GB_OUT",
      refId: "roast-1",
      createdById: "user-1",
    });

    const createCalls = (tx.inventoryLedger.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].data,
    );
    expect(createCalls).toHaveLength(21);
    expect(createCalls.some((entry) => entry.lotId === null)).toBe(false);
    expect(createCalls[19]).toMatchObject({ lotId: "lot-19", quantityKg: 5 });
    expect(createCalls[20]).toMatchObject({ lotId: "lot-20", quantityKg: 3 });
    expect(tx.lot.update).toHaveBeenCalledTimes(20);
    expect(tx.lot.update).toHaveBeenCalledWith({
      where: { id: "lot-19" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("allocates the full 20-batch cap plus beyond in strict FEFO order", async () => {
    const tx = transaction();
    const lots = Array.from({ length: 25 }, (_, i) => ({
      id: `lot-${i}`,
      batchCode: `LOT-${String(i).padStart(2, "0")}`,
      expiryDate: new Date(Date.UTC(2026, 7 + i, 1)),
      quantityKg: 5,
      quantityUnit: 0,
      inventoryLedgers: [{ entryType: "IN", quantityKg: 5, quantityUnit: null }],
    }));
    tx.$queryRaw.mockResolvedValue(lots.map((l) => ({ id: l.id })));
    tx.lot.findMany.mockImplementation(({ take } = {}) => Promise.resolve(take ? lots.slice(0, take) : lots));

    await appendFefoLedgerOut(tx, {
      tenantId: "tenant-1",
      productId: "green-bean-1",
      quantityKg: 125,
      refType: "ROASTING_GB_OUT",
      refId: "roast-2",
      createdById: "user-1",
    });

    const createCalls = (tx.inventoryLedger.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].data,
    );
    expect(createCalls).toHaveLength(25);
    expect(createCalls.map((entry) => entry.lotId)).toEqual(
      Array.from({ length: 25 }, (_, i) => `lot-${i}`),
    );
    expect(createCalls.some((entry) => entry.lotId === null)).toBe(false);
    expect(tx.lot.update).toHaveBeenCalledTimes(25);
  });
});

describe("appendLedger — Phase 2D.2A cost basis", () => {
  it("unit IN merges WAC into lastHpp and persists incomingPrice on the ledger", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "0",
      stockUnit: 5,
      avgCostPerKg: "0",
      lastHpp: "100000",
    });

    await appendLedger(tx, {
      data: {
        productId: "product-fg-1",
        entryType: "IN",
        refType: "PRODUCTION_FG_IN",
        refId: "batch-1",
        quantityUnit: 10,
        incomingPrice: 120000,
        createdById: "user-1",
      },
    });

    // Acceptance: A 10@100k, SALE 5, B 10@120k → lastHpp = (5·100k + 10·120k)/15
    const updateCall = (tx.product.updateMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0].data.stockUnit).toEqual({ increment: 10 });
    expect(updateCall[0].data.avgCostPerKg).toBeUndefined();
    expect(updateCall[0].data.lastHpp).toBeCloseTo((5 * 100000 + 10 * 120000) / 15, 6);
    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ incomingPrice: 120000, quantityUnit: 10 }),
    });
  });

  it("kg IN keeps lastHpp untouched and persists incomingPrice on the ledger", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "100",
      stockUnit: 0,
      avgCostPerKg: "50000",
      lastHpp: null,
    });

    await appendLedger(tx, {
      data: {
        productId: "product-1",
        entryType: "IN",
        refType: "PURCHASE_GB",
        refId: "purchase-2",
        quantityKg: 50,
        incomingPrice: 60000,
        createdById: "user-1",
      },
    });

    const updateCall = (tx.product.updateMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0].data.avgCostPerKg).toBeCloseTo((100 * 50000 + 50 * 60000) / 150, 6);
    expect(updateCall[0].data.lastHpp).toBeUndefined();
    expect(tx.inventoryLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ incomingPrice: 60000, quantityKg: 50 }),
    });
  });
});

describe("recomputeProductCostInTx — Phase 2D.2A", () => {
  const reversal = (refId: string, reversalOfLedgerId: string | null = null) => ({
    refId,
    refType: "VOID_REVERSAL",
    entryType: "IN",
    quantityKg: 0,
    quantityUnit: 0,
    incomingPrice: null,
    reversalOfLedgerId,
  });

  it("full replay restores exact kg WAC across interleaved OUTs (counterexample fixed)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "20",
      stockUnit: 0,
      avgCostPerKg: "73333.33",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pA", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: 60000, reversalOfLedgerId: null },
      { refId: "pB", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 50, quantityUnit: 0, incomingPrice: 100000, reversalOfLedgerId: null },
      { refId: "g1", refType: "GRINDING_RB_OUT", entryType: "OUT", quantityKg: 80, quantityUnit: 0, incomingPrice: null, reversalOfLedgerId: null },
      reversal("pB", "orig-B"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-1",
      voidedRefId: "pB",
      originalRows: [{ quantityKg: 50, quantityUnit: 0, incomingPrice: 100000 }],
    });

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { avgCostPerKg: 60000 },
    });
  });

  it("unit stream replay: voiding batch B leaves lastHpp = WAC of remaining units", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "0",
      stockUnit: 5,
      avgCostPerKg: "0",
      lastHpp: "113333.33",
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pa", refType: "PRODUCTION_FG_IN", entryType: "IN", quantityKg: 0, quantityUnit: 10, incomingPrice: 100000, reversalOfLedgerId: null },
      { refId: "inv1", refType: "SALE_FG_OUT", entryType: "OUT", quantityKg: 0, quantityUnit: 5, incomingPrice: null, reversalOfLedgerId: null },
      { refId: "pb", refType: "PRODUCTION_FG_IN", entryType: "IN", quantityKg: 0, quantityUnit: 10, incomingPrice: 120000, reversalOfLedgerId: null },
      reversal("pb", "orig-B"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "fg-1",
      voidedRefId: "pb",
      originalRows: [{ quantityKg: 0, quantityUnit: 10, incomingPrice: 120000 }],
    });

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "fg-1" },
      data: { lastHpp: 100000 },
    });
  });

  it("zeros cost when the only IN basis is the voided transaction", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "0",
      stockUnit: 0,
      avgCostPerKg: "80000",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "e1", refType: "EXPERIMENTAL_FG_IN", entryType: "IN", quantityKg: 5, quantityUnit: 0, incomingPrice: 80000, reversalOfLedgerId: null },
      reversal("e1", "orig-E"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-x",
      voidedRefId: "e1",
      originalRows: [{ quantityKg: 5, quantityUnit: 0, incomingPrice: 80000 }],
    });

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-x" },
      data: { avgCostPerKg: 0 },
    });
  });

  it("falls back to candidate snapshot when basis is incomplete (legacy rows)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "150",
      stockUnit: 0,
      avgCostPerKg: "67500",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pA", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: 60000, reversalOfLedgerId: null },
      { refId: "pL", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 50, quantityUnit: 0, incomingPrice: null, reversalOfLedgerId: null },
      { refId: "pB", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 50, quantityUnit: 0, incomingPrice: 100000, reversalOfLedgerId: null },
      reversal("pB", "orig-B"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-1",
      voidedRefId: "pB",
      originalRows: [{ quantityKg: 50, quantityUnit: 0, incomingPrice: 100000 }],
    });

    // stockKg sudah pasca-reversal: sebelum void = 150 + 50.
    const expected = ((150 + 50) * 67500 - 50 * 100000) / 150;
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { avgCostPerKg: expected },
    });
  });

  it("skips replay when the voided rows have no price (legacy void)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "150",
      stockUnit: 0,
      avgCostPerKg: "67500",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pA", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: null, reversalOfLedgerId: null },
      { refId: "pB", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 50, quantityUnit: 0, incomingPrice: null, reversalOfLedgerId: null },
      reversal("pB"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-1",
      voidedRefId: "pB",
      originalRows: [{ quantityKg: 50, quantityUnit: 0, incomingPrice: null }],
    });

    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("excludes legacy voids via refId grouping (no cost leak from voided purchases)", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "0",
      stockUnit: 0,
      avgCostPerKg: "90000",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pA", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: 60000, reversalOfLedgerId: null },
      reversal("pA"),
      { refId: "pB", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: 120000, reversalOfLedgerId: null },
      { refId: "g1", refType: "GRINDING_RB_OUT", entryType: "OUT", quantityKg: 100, quantityUnit: 0, incomingPrice: null, reversalOfLedgerId: null },
      reversal("pB", "orig-B"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-1",
      voidedRefId: "pB",
      originalRows: [{ quantityKg: 100, quantityUnit: 0, incomingPrice: 120000 }],
    });

    // Baik A (legacy void) maupun B (void berjalan) dikeluarkan dari basis;
    // yang tersisa hanya OUT → tidak ada basis IN → cost dinolkan.
    // Tanpa exklusi refId, basis A 60k akan bocor ke hasil replay.
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { avgCostPerKg: 0 },
    });
  });

  it("uses candidate snapshot when replayed quantity mismatches the cache", async () => {
    const tx = transaction();
    tx.product.findUnique = vi.fn().mockResolvedValue({
      stockKg: "120",
      stockUnit: 0,
      avgCostPerKg: "73333.33",
      lastHpp: null,
    });
    tx.inventoryLedger.findMany = vi.fn().mockResolvedValue([
      { refId: "pA", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 100, quantityUnit: 0, incomingPrice: 60000, reversalOfLedgerId: null },
      { refId: "pB", refType: "PURCHASE_GB", entryType: "IN", quantityKg: 50, quantityUnit: 0, incomingPrice: 100000, reversalOfLedgerId: null },
      reversal("pB", "orig-B"),
    ]);

    await recomputeProductCostInTx(tx, {
      tenantId: "tenant-1",
      productId: "product-1",
      voidedRefId: "pB",
      originalRows: [{ quantityKg: 50, quantityUnit: 0, incomingPrice: 100000 }],
    });

    // stockKg sudah pasca-reversal: sebelum void = 120 + 50.
    const expected = ((120 + 50) * 73333.33 - 50 * 100000) / 120;
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { avgCostPerKg: expected },
    });
  });
});
