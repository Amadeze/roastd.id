import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { postPurchase } from "./posting";
import {
  allocateShippingCost,
  generatePOCode,
  createDraftPO,
  updateDraftPO,
  sendPO,
  receivePO,
  cancelPO,
  getPOList,
  getPODetail,
  getPOSummary,
} from "./po-lite";

vi.mock("./posting", () => ({ postPurchase: vi.fn().mockResolvedValue("JE-TEST") }));

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

// =============================================================================
// MOCK PRISMA
// =============================================================================

function createMockPrisma() {
  const mock: any = {
    purchaseOrder: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
    },
    purchaseOrderItem: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    purchase: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    supplierPayment: {
      create: vi.fn(),
    },
    inventoryLedger: {
      create: vi.fn(),
    },
    lot: {
      create: vi.fn().mockResolvedValue({ id: "lot-1", batchCode: "PUR-LOT" }),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue({ stockKg: 0, stockUnit: 0, avgCostPerKg: 0 }),
      updateMany: vi.fn(),
    },
    packaging: {
      updateMany: vi.fn(),
    },
    inventorySupplyItem: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    supplier: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };

  // Make $transaction execute the callback with the same mock instance
  mock.$transaction.mockImplementation(async (fn: any) => fn(mock));

  return mock;
}

describe("allocateShippingCost", () => {
  it("allocates shipping proportionally and preserves the exact total", () => {
    const allocations = allocateShippingCost([300_000, 700_000], 100_001);

    expect(allocations).toEqual([30_000.3, 70_000.7]);
    expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(100_001);
  });

  it("splits shipping evenly when all item prices are zero", () => {
    expect(allocateShippingCost([0, 0], 10_000)).toEqual([5_000, 5_000]);
  });

  it("never creates a negative remainder for very small shipping values", () => {
    const allocations = allocateShippingCost([1, 1, 1, 1], 0.02);

    expect(allocations).toEqual([0, 0, 0, 0.02]);
    expect(allocations.every((value) => value >= 0)).toBe(true);
  });
});

// =============================================================================
// PURE FUNCTION TESTS
// =============================================================================

describe("generatePOCode", () => {
  it("generates correct code format", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.count.mockResolvedValue(0);

    const code = await generatePOCode(prisma);

    expect(code).toMatch(/^PO-\d{6}-001$/);
  });

  it("increments count for existing codes", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.count.mockResolvedValue(5);

    const code = await generatePOCode(prisma);

    expect(code).toMatch(/^PO-\d{6}-006$/);
  });
});

// =============================================================================
// CREATE PO TESTS
// =============================================================================

describe("createDraftPO", () => {
  it("creates PO with valid input", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true });
    prisma.purchaseOrder.count.mockResolvedValue(0);
    prisma.purchaseOrder.create.mockResolvedValue({ id: "po-1", code: "PO-202607-001" });
    prisma.purchaseOrderItem.createMany.mockResolvedValue({ count: 1 });

    const result = await createDraftPO(
      prisma,
      {
        supplierId: "sup-1",
        items: [
          { productId: "gb-1", quantity: 10, unitPrice: 50000 },
        ],
      },
      "user-1",
    );

    expect(result.code).toMatch(/^PO-\d{6}-001$/);
    expect(prisma.purchaseOrder.create).toHaveBeenCalled();
    expect(prisma.purchaseOrderItem.createMany).toHaveBeenCalled();
  });

  it("adds estimated shipping to the PO total", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true, tenantId: "tenant-1" });
    prisma.purchaseOrder.count.mockResolvedValue(0);
    prisma.purchaseOrder.create.mockResolvedValue({ id: "po-1", code: "PO-202607-001" });

    await createDraftPO(
      prisma,
      {
        supplierId: "sup-1",
        estimatedShippingCost: 50_000,
        items: [{ productId: "gb-1", quantity: 10, unitPrice: 50_000 }],
      },
      "user-1",
    );

    expect(prisma.purchaseOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedShippingCost: 50_000,
        totalEstimate: 550_000,
      }),
    });
  });

  it("throws error for inactive supplier", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: false });

    await expect(
      createDraftPO(
        prisma,
        { supplierId: "sup-1", items: [{ productId: "gb-1", quantity: 10, unitPrice: 50000 }] },
        "user-1",
      ),
    ).rejects.toThrow("Supplier tidak ditemukan atau tidak aktif.");
  });

  it("throws error for empty items", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true });

    await expect(
      createDraftPO(prisma, { supplierId: "sup-1", items: [] }, "user-1"),
    ).rejects.toThrow("PO harus memiliki minimal 1 item.");
  });

  it("throws error for zero quantity", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true });

    await expect(
      createDraftPO(
        prisma,
        { supplierId: "sup-1", items: [{ productId: "gb-1", quantity: 0, unitPrice: 50000 }] },
        "user-1",
      ),
    ).rejects.toThrow("Quantity harus lebih dari 0.");
  });

  it("regenerates the code and succeeds when the first create hits a unique collision", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true, tenantId: "tenant-1" });
    prisma.purchaseOrder.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    prisma.purchaseOrder.create
      .mockRejectedValueOnce(duplicateError())
      .mockResolvedValueOnce({ id: "po-2", code: "PO-202607-002" });
    prisma.purchaseOrderItem.createMany.mockResolvedValue({ count: 1 });

    const result = await createDraftPO(
      prisma,
      { supplierId: "sup-1", items: [{ productId: "gb-1", quantity: 10, unitPrice: 50000 }] },
      "user-1",
    );

    expect(result.code).toMatch(/^PO-\d{6}-002$/);
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(2);
    expect(prisma.purchaseOrder.create.mock.calls[0][0].data.code).toMatch(/^PO-\d{6}-001$/);
    expect(prisma.purchaseOrder.create.mock.calls[1][0].data.code).toMatch(/^PO-\d{6}-002$/);
  });

  it("rethrows after the retry limit when the collision persists", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true, tenantId: "tenant-1" });
    prisma.purchaseOrder.count.mockResolvedValue(0);
    prisma.purchaseOrder.create.mockRejectedValue(duplicateError());

    await expect(
      createDraftPO(
        prisma,
        { supplierId: "sup-1", items: [{ productId: "gb-1", quantity: 10, unitPrice: 50000 }] },
        "user-1",
      ),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-unique errors", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", isActive: true, tenantId: "tenant-1" });
    prisma.purchaseOrder.count.mockResolvedValue(0);
    prisma.purchaseOrder.create.mockRejectedValue(new Error("disk full"));

    await expect(
      createDraftPO(
        prisma,
        { supplierId: "sup-1", items: [{ productId: "gb-1", quantity: 10, unitPrice: 50000 }] },
        "user-1",
      ),
    ).rejects.toThrow("disk full");

    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// UPDATE PO TESTS
// =============================================================================

describe("updateDraftPO", () => {
  it("updates Draft PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "DRAFT" });
    prisma.purchaseOrderItem.deleteMany.mockResolvedValue({ count: 1 });
    prisma.purchaseOrderItem.createMany.mockResolvedValue({ count: 1 });
    prisma.purchaseOrder.update.mockResolvedValue({});

    await updateDraftPO(prisma, {
      id: "po-1",
      items: [{ productId: "gb-1", quantity: 20, unitPrice: 55000 }],
    });

    expect(prisma.purchaseOrder.update).toHaveBeenCalled();
  });

  it("throws error for non-Draft PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "SENT" });

    await expect(
      updateDraftPO(prisma, { id: "po-1", items: [] }),
    ).rejects.toThrow("Hanya PO berstatus Draft yang dapat diedit.");
  });
});

// =============================================================================
// SEND PO TESTS
// =============================================================================

describe("sendPO", () => {
  it("sends Draft PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "DRAFT" });
    prisma.purchaseOrder.update.mockResolvedValue({});

    await sendPO(prisma, "po-1");

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: "po-1" },
      data: { status: "SENT", sentAt: expect.any(Date) },
    });
  });

  it("throws error for non-Draft PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "SENT" });

    await expect(sendPO(prisma, "po-1")).rejects.toThrow(
      "Hanya PO berstatus Draft yang dapat dikirim.",
    );
  });
});

// =============================================================================
// CANCEL PO TESTS
// =============================================================================

describe("cancelPO", () => {
  it("cancels Draft PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "DRAFT" });
    prisma.purchaseOrder.update.mockResolvedValue({});

    await cancelPO(prisma, "po-1");

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: "po-1" },
      data: { status: "CANCELLED" },
    });
  });

  it("cancels Sent PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "SENT" });
    prisma.purchaseOrder.update.mockResolvedValue({});

    await cancelPO(prisma, "po-1");

    expect(prisma.purchaseOrder.update).toHaveBeenCalled();
  });

  it("throws error for Received PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "RECEIVED" });

    await expect(cancelPO(prisma, "po-1")).rejects.toThrow(
      "PO yang sudah diterima atau dibatalkan tidak dapat dibatalkan.",
    );
  });

  it("throws error for Partial PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({ id: "po-1", status: "PARTIAL" });

    await expect(cancelPO(prisma, "po-1")).rejects.toThrow(
      "PO yang sudah sebagian diterima tidak dapat dibatalkan.",
    );
  });
});

// =============================================================================
// RECEIVE PO TESTS
// =============================================================================

describe("receivePO", () => {
  it("receives PO items", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-1",
      code: "PO-202607-001",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-1", productId: "gb-1", packagingId: null, quantity: 10, unitPrice: 50000, product: { type: "GREEN_BEAN", materialOrigin: null, coffeeSourceId: null, isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);
    prisma.purchase.create.mockResolvedValue({ id: "pur-1", code: "PUR-202607-001" });
    prisma.inventoryLedger.create.mockResolvedValue({});
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.purchaseOrder.update.mockResolvedValue({});

    const result = await receivePO(
      prisma,
      "po-1",
      {
        receivedAt: "2026-07-18",
        shippingCost: 50_000,
        items: [{ poItemId: "item-1", receivedQuantity: 10 }],
      },
      "user-1",
    );

    expect(result.purchaseCodes).toHaveLength(1);
    expect(prisma.purchase.create).toHaveBeenCalled();
    expect(prisma.lot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseId: "pur-1",
        batchCode: result.purchaseCodes[0],
      }),
    });
    expect(prisma.product.findUnique).toHaveBeenCalled();
    expect(prisma.product.updateMany).toHaveBeenCalled();
    expect(prisma.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shippingCost: 50_000,
        totalCost: 550_000,
        dueDate: new Date("2026-08-01"),
      }),
    });
    expect(postPurchase).toHaveBeenCalledWith(
      "pur-1",
      "GREEN_BEAN",
      550_000,
      0,
      "PT Kopi",
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      undefined,
    );
  });

  it("records a transfer receipt as paid and creates a supplier payment", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-1",
      code: "PO-202607-001",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-1", productId: "gb-1", packagingId: null, quantity: 10, unitPrice: 50000, product: { type: "GREEN_BEAN", materialOrigin: null, coffeeSourceId: null, isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);
    prisma.purchase.create.mockResolvedValue({ id: "pur-1", code: "PUR-202607-001" });
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.purchaseOrder.update.mockResolvedValue({});

    await receivePO(
      prisma,
      "po-1",
      {
        receivedAt: "2026-07-18",
        paymentMethod: "TRANSFER",
        items: [{ poItemId: "item-1", receivedQuantity: 10 }],
      },
      "user-1",
    );

    expect(prisma.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentStatus: "PAID",
        paidAmount: 500_000,
        dueDate: null,
      }),
    });
    expect(prisma.supplierPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseId: "pur-1",
        amount: 500_000,
        method: "TRANSFER",
      }),
    });
    expect(postPurchase).toHaveBeenLastCalledWith(
      "pur-1",
      "GREEN_BEAN",
      500_000,
      500_000,
      "PT Kopi",
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      undefined,
    );
  });

  it("retries the whole transaction when the purchase code collides", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-1",
      code: "PO-202607-001",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-1", productId: "gb-1", packagingId: null, quantity: 10, unitPrice: 50000, product: { type: "GREEN_BEAN", materialOrigin: null, coffeeSourceId: null, isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);
    prisma.purchase.create
      .mockRejectedValueOnce(duplicateError())
      .mockResolvedValueOnce({ id: "pur-1", code: "PUR-202607-001" });
    prisma.inventoryLedger.create.mockResolvedValue({});
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.purchaseOrder.update.mockResolvedValue({});

    const result = await receivePO(
      prisma,
      "po-1",
      {
        receivedAt: "2026-07-18",
        shippingCost: 50_000,
        items: [{ poItemId: "item-1", receivedQuantity: 10 }],
      },
      "user-1",
    );

    expect(prisma.purchase.create).toHaveBeenCalledTimes(2);
    expect(result.purchaseCodes).toEqual(["PUR-202607-001"]);
    expect(prisma.lot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ batchCode: "PUR-202607-001" }),
    });
  });

  it("records a roasted bean receipt with type ROASTED_BEAN and PURCHASE_RB ledger", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-2",
      code: "PO-202607-002",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-rb", productId: "rb-1", packagingId: null, quantity: 5, unitPrice: 120000, product: { type: "ROASTED_BEAN", materialOrigin: "PURCHASED_ROASTED", coffeeSourceId: "src-1", isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);
    prisma.purchase.create.mockResolvedValue({ id: "pur-rb", code: "PUR-202607-002" });
    prisma.purchase.findMany.mockResolvedValue([]);
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.purchaseOrder.update.mockResolvedValue({});

    const result = await receivePO(
      prisma,
      "po-2",
      {
        receivedAt: "2026-07-18",
        paymentMethod: "TRANSFER",
        items: [{ poItemId: "item-rb", receivedQuantity: 5 }],
      },
      "user-1",
    );

    expect(prisma.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ROASTED_BEAN",
        productId: "rb-1",
        weightKg: 5,
      }),
    });
    expect(prisma.inventoryLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: "rb-1",
          entryType: "IN",
          refType: "PURCHASE_RB",
          quantityKg: 5,
        }),
      }),
    );
    expect(postPurchase).toHaveBeenLastCalledWith(
      "pur-rb",
      "ROASTED_BEAN",
      600_000,
      600_000,
      "PT Kopi",
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      undefined,
    );
  });

  it("rejects receiving into an internal-roast RB product", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-4",
      code: "PO-202607-004",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-rb-int", productId: "rb-int-1", packagingId: null, quantity: 5, unitPrice: 120000, product: { type: "ROASTED_BEAN", materialOrigin: "INTERNAL_ROAST", coffeeSourceId: "src-1", isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);

    await expect(
      receivePO(
        prisma,
        "po-4",
        {
          receivedAt: "2026-07-18",
          items: [{ poItemId: "item-rb-int", receivedQuantity: 5 }],
        },
        "user-1",
      ),
    ).rejects.toThrow(/harus beli jadi \(PURCHASED_ROASTED\)/);
  });

  it("rejects receiving into an unidentified RB product without a coffee source", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-5",
      code: "PO-202607-005",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-rb-null", productId: "rb-null-1", packagingId: null, quantity: 5, unitPrice: 120000, product: { type: "ROASTED_BEAN", materialOrigin: "PURCHASED_ROASTED", coffeeSourceId: null, isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);

    await expect(
      receivePO(
        prisma,
        "po-5",
        {
          receivedAt: "2026-07-18",
          items: [{ poItemId: "item-rb-null", receivedQuantity: 5 }],
        },
        "user-1",
      ),
    ).rejects.toThrow(/harus beli jadi \(PURCHASED_ROASTED\)/);
  });

  it("rejects receiving a PO item whose product type is unsupported", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-3",
      code: "PO-202607-003",
      tenantId: "tenant-1",
      status: "SENT",
      supplierId: "sup-1",
      inventorySupplyItem: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      supplier: { name: "PT Kopi" },
      items: [
        { id: "item-fg", productId: "fg-1", packagingId: null, quantity: 3, unitPrice: 50000, product: { type: "FINISHED_GOODS", materialOrigin: null, coffeeSourceId: null, isActive: true } },
      ],
    });
    prisma.purchase.count.mockResolvedValue(0);

    await expect(
      receivePO(
        prisma,
        "po-3",
        {
          receivedAt: "2026-07-18",
          items: [{ poItemId: "item-fg", receivedQuantity: 3 }],
        },
        "user-1",
      ),
    ).rejects.toThrow(/Tipe produk pada item PO .* tidak didukung pembelian/);
  });

  it("throws error for non-Sent/Partial PO", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findUnique.mockResolvedValue({
      id: "po-1",
      status: "DRAFT",
      supplierId: "sup-1",
      items: [],
    });

    await expect(
      receivePO(
        prisma,
        "po-1",
        { receivedAt: "2026-07-18", items: [] },
        "user-1",
      ),
    ).rejects.toThrow("Hanya PO berstatus Sent atau Partial yang dapat diterima.");
  });
});

// =============================================================================
// GET PO LIST TESTS
// =============================================================================

describe("getPOList", () => {
  it("returns PO list with counts", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.findMany.mockResolvedValue([
      {
        id: "po-1",
        code: "PO-202607-001",
        status: "DRAFT",
        inventorySupplyItem: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        supplier: { name: "PT Kopi" },
        expectedDate: null,
        totalEstimate: 500000,
        sentAt: null,
        receivedAt: null,
        createdAt: new Date(),
        items: [{ id: "item-1" }, { id: "item-2" }],
      },
    ]);
    prisma.purchaseOrder.count.mockResolvedValue(1);

    const result = await getPOList(prisma);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].itemCount).toBe(2);
    expect(result.total).toBe(1);
  });
});

// =============================================================================
// GET PO SUMMARY TESTS
// =============================================================================

describe("getPOSummary", () => {
  it("returns status counts", async () => {
    const prisma = createMockPrisma();
    prisma.purchaseOrder.groupBy.mockResolvedValue([
      { status: "DRAFT", _count: 2 },
      { status: "SENT", _count: 1 },
      { status: "RECEIVED", _count: 5 },
    ]);

    const result = await getPOSummary(prisma);

    expect(result.draft).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(5);
    expect(result.total).toBe(8);
  });
});
