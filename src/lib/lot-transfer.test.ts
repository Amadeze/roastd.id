import { describe, expect, it, vi, beforeEach } from "vitest";

const TENANT_ID = "tenant-1";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
  requireTenantPrisma: vi.fn(),
  getCurrentTenantId: vi.fn().mockResolvedValue("tenant-1"),
  getSystemUserId: vi.fn().mockResolvedValue("user-1"),
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { requireTenantPrisma } = await import("@/lib/auth");
const { transferLot } = await import("./lot-transfer");

beforeEach(() => {
  vi.clearAllMocks();
});

function buildMockPrisma(overrides: {
  sourceIsSystem?: boolean;
  destinationIsSystem?: boolean;
  sourcePlacementKg?: number;
} = {}) {
  const sourcePlacement = {
    quantityKg: overrides.sourcePlacementKg ?? 50,
    quantityUnit: 0,
    supplyQty: 0,
  };

  const tx: any = {
    lot: {
      findUnique: vi.fn().mockResolvedValue({
        id: "lot-1",
        tenantId: TENANT_ID,
        quantityKg: 100,
        quantityUnit: 0,
        supplyItemId: null,
        productId: "prod-1",
        product: { type: "GREEN_BEAN" },
        packagingId: null,
      }),
    },
    location: {
      findFirst: vi.fn().mockImplementation((args: { where: { id: string } }) => {
        const isSystem =
          args.where.id === "src-1" ? overrides.sourceIsSystem === true
          : args.where.id === "dst-1" ? overrides.destinationIsSystem === true
          : false;
        return Promise.resolve({ isSystem });
      }),
    },
    lotPlacement: {
      findFirst: vi.fn().mockResolvedValue(sourcePlacement),
      findUnique: vi.fn().mockResolvedValue(sourcePlacement),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    locationTransfer: {
      create: vi.fn().mockResolvedValue({ id: "transfer-1" }),
    },
  };

  const prisma: any = {
    $transaction: vi.fn(async (cb: (t: any) => Promise<any>) => cb(tx)),
  };

  return { prisma, tx };
}

describe("transferLot", () => {
  it("rejects a manual transfer INTO a system location", async () => {
    const { prisma, tx } = buildMockPrisma({ destinationIsSystem: true });
    (requireTenantPrisma as any).mockResolvedValue(prisma);

    const result = await transferLot({
      lotId: "lot-1",
      sourceLocationId: "src-1",
      destinationLocationId: "dst-1",
      quantityKg: 10,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("Lokasi sistem dikelola otomatis");
    expect(tx.lotPlacement.updateMany).not.toHaveBeenCalled();
    expect(tx.lotPlacement.upsert).not.toHaveBeenCalled();
    expect(tx.locationTransfer.create).not.toHaveBeenCalled();
  });

  it("rejects a manual transfer OUT OF a system location", async () => {
    const { prisma, tx } = buildMockPrisma({ sourceIsSystem: true });
    (requireTenantPrisma as any).mockResolvedValue(prisma);

    const result = await transferLot({
      lotId: "lot-1",
      sourceLocationId: "src-1",
      destinationLocationId: "dst-1",
      quantityKg: 10,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("Lokasi sistem dikelola otomatis");
    expect(tx.lotPlacement.updateMany).not.toHaveBeenCalled();
    expect(tx.locationTransfer.create).not.toHaveBeenCalled();
  });

  it("allows a normal location → location transfer", async () => {
    const { prisma, tx } = buildMockPrisma();
    (requireTenantPrisma as any).mockResolvedValue(prisma);

    const result = await transferLot({
      lotId: "lot-1",
      sourceLocationId: "src-1",
      destinationLocationId: "dst-1",
      quantityKg: 10,
    });

    expect(result.success).toBe(true);
    expect((result as any).transferId).toBe("transfer-1");
    expect(tx.lotPlacement.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ quantityKg: { gte: 10 } }),
    }));
    expect(tx.lotPlacement.upsert).toHaveBeenCalled();
    expect(tx.locationTransfer.create).toHaveBeenCalled();
  });

  it("rejects a concurrent transfer that depleted the source placement", async () => {
    const { prisma, tx } = buildMockPrisma();
    tx.lotPlacement.updateMany.mockResolvedValue({ count: 0 });
    tx.lotPlacement.findUnique.mockResolvedValue({ quantityKg: 5, quantityUnit: 0, supplyQty: 0 });
    (requireTenantPrisma as any).mockResolvedValue(prisma);

    const result = await transferLot({
      lotId: "lot-1", sourceLocationId: "src-1", destinationLocationId: "dst-1", quantityKg: 10,
    });

    expect(result).toEqual({ success: false, error: "Stok kg di lokasi sumber tidak mencukupi." });
    expect(tx.lotPlacement.upsert).not.toHaveBeenCalled();
  });

  it("keeps rejecting identical source and destination", async () => {
    const { prisma } = buildMockPrisma();
    (requireTenantPrisma as any).mockResolvedValue(prisma);

    const result = await transferLot({
      lotId: "lot-1",
      sourceLocationId: "src-1",
      destinationLocationId: "src-1",
      quantityKg: 10,
    });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("tidak boleh sama");
  });
});
