import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTestDatabaseUrl } from "../../../../../test/setup/test-database-guard";
import { saveCommerceSettings } from "./actions";
import { withTenant } from "@/lib/prisma";

const integrationEnabled = process.env.RUN_INTEGRATION === "true";
const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "ship-tenant-a";
const TENANT_B = "ship-tenant-b";

const NORMALIZED_ORIGIN = {
  providerId: "574",
  label: "Cipete Selatan, Cilandak, Jakarta Selatan, DKI Jakarta, 12410",
  province: "DKI Jakarta",
  city: "Jakarta Selatan",
  district: "Cilandak",
  subdistrict: "Cipete Selatan",
  postalCode: "12410",
  issuedAt: Date.now(),
};

const authState = vi.hoisted(() => ({ tenantId: "ship-tenant-a" }));

const { mockVerifyToken } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", async () => {
  const { withTenant: withTenantPrisma } = await import("@/lib/prisma");
  return {
    requireRole: vi.fn(async () => ({
      id: `user-${authState.tenantId}`,
      tenantId: authState.tenantId,
      role: "OWNER" as const,
    })),
    requireTenantPrisma: vi.fn(async () =>
      withTenantPrisma(authState.tenantId, (globalThis as any).__shipClient),
    ),
    getCurrentTenantId: vi.fn(async () => authState.tenantId),
    getSystemUserId: vi.fn(async () => `user-${authState.tenantId}`),
  };
});

vi.mock("@/lib/shipping/origin-token", () => ({
  verifyOriginSelectionToken: mockVerifyToken,
}));

function buildFormData(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const v of value) fd.append(key, v);
    } else {
      fd.set(key, value);
    }
  }
  return fd;
}

suite("tenant shipping settings (real PostgreSQL)", () => {
  let client: PrismaClient;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 10 });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
    (globalThis as any).__shipClient = client;
    await client.$connect();

    for (const [id, code] of [
      [TENANT_A, "SHIPA"],
      [TENANT_B, "SHIPB"],
    ] as const) {
      await client.tenant.upsert({
        where: { id },
        create: {
          id,
          code,
          name: `Shipping Tenant ${code}`,
          subscriptionTier: "BASIC",
          subscriptionStatus: "ACTIVE",
          isActive: true,
        },
        update: {},
      });
    }
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await client.user.upsert({
        where: { id: `user-${tenantId}` },
        create: {
          id: `user-${tenantId}`,
          email: `owner-${tenantId}@example.com`,
          name: `Owner ${tenantId}`,
          tenantId,
          role: "OWNER",
        },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.tenantId = TENANT_A;
    mockVerifyToken.mockImplementation(async (token: string) => {
      if (token === "valid-token") return NORMALIZED_ORIGIN;
      return null;
    });
    await client.tenant.update({
      where: { id: TENANT_A },
      data: {
        storefrontPickupEnabled: true,
        storefrontDeliveryEnabled: false,
        nationalCourierEnabled: false,
        rajaOngkirOriginId: null,
        rajaOngkirOriginLabel: null,
        rajaOngkirOriginProvince: null,
        rajaOngkirOriginCity: null,
        rajaOngkirOriginDistrict: null,
        rajaOngkirOriginSubdistrict: null,
        rajaOngkirOriginPostalCode: null,
        rajaOngkirOriginStreet: null,
        rajaOngkirCourierCodes: Prisma.JsonNull,
        rajaOngkirTareGrams: 0,
      },
    });
  });

  const NORMALIZED_ORIGIN = {
    providerId: "574",
    label: "Cipete Selatan, Cilandak, Jakarta Selatan, DKI Jakarta, 12410",
    province: "DKI Jakarta",
    city: "Jakarta Selatan",
    district: "Cilandak",
    subdistrict: "Cipete Selatan",
    postalCode: "12410",
    issuedAt: Date.now(),
  };

  function buildFormData(values: Record<string, string | string[]>): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(values)) {
      if (Array.isArray(value)) {
        for (const v of value) fd.append(key, v);
      } else {
        fd.set(key, value);
      }
    }
    return fd;
  }

  it("saves pickup-only tenant without a RajaOngkir origin", async () => {
    mockVerifyToken.mockImplementation(async () => null);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "",
      rajaOngkirTareGrams: "0",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await expect(saveCommerceSettings(fd)).resolves.toEqual({ success: true });

    const tenant = await client.tenant.findUniqueOrThrow({ where: { id: TENANT_A } });
    expect(tenant.storefrontPickupEnabled).toBe(true);
    expect(tenant.nationalCourierEnabled).toBe(false);
    expect(tenant.rajaOngkirOriginId).toBeNull();
  });

  it("rejects national courier enabled without an origin token", async () => {
    mockVerifyToken.mockImplementation(async () => null);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirCourierCodes: ["jne"],
      rajaOngkirTareGrams: "0",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    // Kontrak baru: action mengembalikan hasil (bukan throw) agar form klien
    // bisa menampilkan pesan tanpa crash boundary server action.
    const result = await saveCommerceSettings(fd);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/asal pengiriman/i),
      }),
    );
  });

  it("rejects national courier enabled without any courier selected", async () => {
    mockVerifyToken.mockImplementation(async () => NORMALIZED_ORIGIN);
    const fd = buildFormData({
      pickupEnabled: "",
      deliveryEnabled: "on",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "valid-token",
      rajaOngkirCourierCodes: [],
      rajaOngkirTareGrams: "0",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    const result = await saveCommerceSettings(fd);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/kurir/i),
      }),
    );
  });

  it("persists server-validated provider snapshot via token, ignoring client-submitted label", async () => {
    mockVerifyToken.mockImplementation(async (token: string) =>
      token === "valid-token" ? NORMALIZED_ORIGIN : null,
    );

    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "valid-token",
      rajaOngkirOriginStreet: "Jl. Contoh No. 123",
      rajaOngkirCourierCodes: ["jne", "pos"],
      rajaOngkirTareGrams: "250",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await expect(saveCommerceSettings(fd)).resolves.toEqual({ success: true });

    const tenant = await client.tenant.findUniqueOrThrow({ where: { id: TENANT_A } });
    expect(tenant.nationalCourierEnabled).toBe(true);
    expect(tenant.rajaOngkirOriginId).toBe("574");
    expect(tenant.rajaOngkirOriginLabel).toBe(NORMALIZED_ORIGIN.label);
    expect(tenant.rajaOngkirOriginProvince).toBe(NORMALIZED_ORIGIN.province);
    expect(tenant.rajaOngkirOriginCity).toBe(NORMALIZED_ORIGIN.city);
    expect(tenant.rajaOngkirOriginLabel).not.toBe("FAKE CLIENT-SUBMITTED LABEL");
    expect(tenant.rajaOngkirOriginStreet).toBe("Jl. Contoh No. 123");
    expect(tenant.rajaOngkirTareGrams).toBe(250);
    expect(Array.isArray(tenant.rajaOngkirCourierCodes)).toBe(true);
    expect(tenant.rajaOngkirCourierCodes).toEqual(["jne", "pos"]);
  });

  it("rejects a forged/invalid origin token", async () => {
    mockVerifyToken.mockImplementation(async () => null);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "tampered-token",
      rajaOngkirOriginStreet: "Jl. Contoh No. 123",
      rajaOngkirCourierCodes: ["jne"],
      rajaOngkirTareGrams: "0",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await expect(saveCommerceSettings(fd)).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/tidak valid|kadaluwarsa/i),
      }),
    );
  });

  it("rejects an expired origin token", async () => {
    mockVerifyToken.mockImplementation(async () => null);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "expired-token",
      rajaOngkirOriginStreet: "Jl. Contoh No. 123",
      rajaOngkirCourierCodes: ["jne"],
      rajaOngkirTareGrams: "0",
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await expect(saveCommerceSettings(fd)).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/tidak valid|kadaluwarsa/i),
      }),
    );
  });

  it("filters unsupported courier codes", async () => {
    mockVerifyToken.mockImplementation(async () => NORMALIZED_ORIGIN);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "valid-token",
      rajaOngkirTareGrams: "0",
      rajaOngkirCourierCodes: ["jne", "not-a-real-courier"],
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await saveCommerceSettings(fd);
    const tenant = await client.tenant.findUniqueOrThrow({ where: { id: TENANT_A } });
    expect(tenant.rajaOngkirCourierCodes).toEqual(["jne"]);
  });

  it("prevents cross-tenant modification (tenant B untouched)", async () => {
    mockVerifyToken.mockImplementation(async () => NORMALIZED_ORIGIN);
    const fd = buildFormData({
      pickupEnabled: "on",
      deliveryEnabled: "",
      nationalCourierEnabled: "on",
      rajaOngkirOriginToken: "valid-token",
      rajaOngkirTareGrams: "0",
      rajaOngkirCourierCodes: ["jne"],
      flatShippingRate: "0",
      freeShippingMinimum: "",
      taxRate: "0",
      reservationMinutes: "1440",
    });
    await saveCommerceSettings(fd);

    authState.tenantId = TENANT_B;
    const tenantB = await client.tenant.findUniqueOrThrow({ where: { id: TENANT_B } });
    expect(tenantB.nationalCourierEnabled).toBe(false);
    expect(tenantB.rajaOngkirOriginId).toBeNull();
  });
});