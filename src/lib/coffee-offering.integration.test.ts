import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTestDatabaseUrl } from "../../test/setup/test-database-guard";
import { createOffering } from "@/app/(dashboard)/master-data/actions";
import { withTenant } from "./prisma";
import {
  allocateProducedStockToDemand,
  fulfillInvoiceAtHandover,
  releaseInvoiceReservations,
  reserveInvoiceStock,
} from "./storefront-commerce";
import { loadStorefrontCatalog, resolveOfferingLineage } from "./storefront-catalog";

// Gated integration test: only runs against an isolated test DB with RUN_INTEGRATION=true.
const integrationEnabled = process.env.RUN_INTEGRATION === "true";
const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "offering-tenant-a";
const TENANT_B = "offering-tenant-b";

const authState = vi.hoisted(() => ({ tenantId: "offering-tenant-a" }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", async () => {
  const { withTenant: withTenantPrisma } = await import("./prisma");
  return {
    requireRole: vi.fn(async () => ({
      id: `user-${authState.tenantId}`,
      tenantId: authState.tenantId,
      role: "OWNER" as const,
    })),
    requireTenantPrisma: vi.fn(async () =>
      withTenantPrisma(authState.tenantId, (globalThis as any).__cfpClient),
    ),
    getCurrentTenantId: vi.fn(async () => authState.tenantId),
    getSystemUserId: vi.fn(async () => `user-${authState.tenantId}`),
  };
});

suite("coffee offerings — real PostgreSQL (TEST_DATABASE_URL)", () => {
  let client: PrismaClient;
  let pool: Pool;
  let rbProductA = "";
  let fgProductA = "";
  let csA = "";
  let csB = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 10 });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
    (globalThis as any).__cfpClient = client;
    await client.$connect();

    for (const [id, code] of [
      [TENANT_A, "OFFA"],
      [TENANT_B, "OFFB"],
    ] as const) {
      await client.tenant.upsert({
        where: { id },
        create: { id, code, name: `Offering Tenant ${code}`, subscriptionTier: "BASIC", subscriptionStatus: "ACTIVE", isActive: true },
        update: {},
      });
    }
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await client.user.upsert({
        where: { id: `user-${tenantId}` },
        create: { id: `user-${tenantId}`, email: `owner-${tenantId}@example.com`, name: `Owner ${tenantId}`, tenantId, role: "OWNER" },
        update: {},
      });
    }

    const sourceA = await client.coffeeSource.create({
      data: { tenantId: TENANT_A, code: "CS-OFFA-001", name: "Gayo Purwasari", isActive: true },
    });
    csA = sourceA.id;
    csB = (await client.coffeeSource.create({
      data: { tenantId: TENANT_B, code: "CS-OFFB-001", name: "Toraja Sesean", isActive: true },
    })).id;

    const rbA = await client.product.create({
      data: {
        tenantId: TENANT_A,
        code: "RB-OFFA-001",
        name: "Gayo Purwasari Roasted",
        type: "ROASTED_BEAN",
        materialOrigin: "PURCHASED_ROASTED",
        coffeeSourceId: sourceA.id,
        roastLevel: "MEDIUM",
        isActive: true,
        stockUnit: 10,
        stockKg: 10,
        avgCostPerKg: 120_000,
      },
    });
    rbProductA = rbA.id;

    const fgA = await client.product.create({
      data: {
        tenantId: TENANT_A,
        code: "FG-OFFA-001",
        name: "Gayo Blend 250g",
        type: "FINISHED_GOODS",
        isActive: true,
        stockUnit: 5,
        price: 80_000,
      },
    });
    fgProductA = fgA.id;

    const offeringA = await client.coffeeOffering.create({
      data: {
        tenantId: TENANT_A,
        code: "OF-OFFA-001",
        name: "Gayo Purwasari Medium",
        sourceMode: "PURCHASED_ROASTED",
        coffeeSourceId: sourceA.id,
        roastLevel: "MEDIUM",
        grindOptions: ["WHOLE_BEAN", "ESPRESSO", "CUSTOM"],
        allowCustomGrind: true,
        isActive: true,
        sortOrder: 0,
      },
    });
    await client.offeringVariant.createMany({
      data: [
        { tenantId: TENANT_A, offeringId: offeringA.id, packageName: "Bungkus 250g", netWeightGrams: 250, unitPrice: 65_000, sortOrder: 0 },
        { tenantId: TENANT_A, offeringId: offeringA.id, packageName: "Cairan 1kg", netWeightGrams: 1000, unitPrice: 240_000, sortOrder: 1 },
      ],
    });
  });

  beforeEach(async () => {
    await client.inventoryLedger.deleteMany({ where: { tenantId: TENANT_A } });
    await client.journalLine.deleteMany({ where: { journalEntry: { tenantId: TENANT_A } } });
    await client.journalEntry.deleteMany({ where: { tenantId: TENANT_A } });
    await client.stockReservation.deleteMany({ where: { tenantId: TENANT_A } });
    await client.fulfillmentTask.deleteMany({ where: { tenantId: TENANT_A } });
    await client.invoiceItem.deleteMany({ where: { tenantId: TENANT_A } });
    await client.invoice.deleteMany({ where: { tenantId: TENANT_A } });
    await client.customer.deleteMany({ where: { tenantId: TENANT_A } });
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 10, stockUnit: 10 } });
    await client.product.update({ where: { id: fgProductA }, data: { stockUnit: 5 } });
  });

  afterAll(async () => {
    if (!client) return;
    await client.inventoryLedger.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.journalLine.deleteMany({ where: { journalEntry: { tenantId: { in: [TENANT_A, TENANT_B] } } } });
    await client.journalEntry.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.account.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.stockReservation.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.fulfillmentTask.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.invoiceItem.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.invoice.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.customer.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.offeringVariant.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.coffeeOffering.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.product.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.coffeeSource.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.user.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await client.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await client.$disconnect();
  });

  async function makeInvoice(
    tenantId: string,
    code: string,
    items: Array<Record<string, unknown>>,
    options: { status?: string; fulfillmentStatus?: string; paidAmount?: number } = {},
  ) {
    const customer = await client.customer.create({
      data: { tenantId, code: `CST-${code}`, name: "Budi Storefront", isActive: true },
    });
    return client.invoice.create({
      data: {
        tenantId,
        code,
        customerId: customer.id,
        subtotal: 130_000,
        discount: 0,
        tax: 13_000,
        shippingCost: 0,
        grandTotal: 143_000,
        paidAmount: options.paidAmount ?? 143_000,
        status: (options.status ?? "ISSUED") as any,
        fulfillmentStatus: (options.fulfillmentStatus ?? "AWAITING_PAYMENT") as any,
        createdById: `user-${tenantId}`,
        reservationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        items: { create: items as any },
      },
    });
  }

  it("rejects cross-tenant writes referencing another tenant's coffee source", async () => {
    const tpA = withTenant(TENANT_A, client);
    await expect(
      tpA.coffeeOffering.create({
        data: {
          tenantId: TENANT_A,
          code: "OF-OFFA-X",
          name: "Toraja (salah tenant)",
          sourceMode: "PURCHASED_ROASTED",
          coffeeSourceId: csB,
          grindOptions: ["WHOLE_BEAN"],
        },
      }),
    ).rejects.toThrow(/Cross-tenant/);
  });

  it("creates an offering from an explicitly selected valid roasted material", async () => {
    authState.tenantId = TENANT_A;
    const result = await createOffering({
      name: `Offering Material ${randomUUID().slice(0, 6)}`,
      description: null,
      imageUrl: null,
      roastLevel: "MEDIUM",
      sourceMode: "PURCHASED_ROASTED",
      coffeeSourceId: csA,
      lineageProductId: rbProductA,
      grindOptions: ["WHOLE_BEAN", "ESPRESSO"],
      allowCustomGrind: false,
      isActive: true,
      sortOrder: 0,
      variants: [{ packageName: "Pouch 250 g", netWeightGrams: 250, unitPrice: 65_000, supplyItemId: null, isActive: true }],
    });
    expect(result.success).toBe(true);
    const created = await client.coffeeOffering.findFirstOrThrow({
      where: { tenantId: TENANT_A, code: result.success ? result.code : "never" },
    });
    expect(created.lineageProductId).toBe(rbProductA);
    expect(created.coffeeSourceId).toBe(csA);
    expect(created.sourceMode).toBe("PURCHASED_ROASTED");
  });

  it("rejects an offering whose declared identity does not match the selected material", async () => {
    authState.tenantId = TENANT_A;
    const result = await createOffering({
      name: `Offering False ${randomUUID().slice(0, 6)}`,
      description: null,
      imageUrl: null,
      roastLevel: "DARK",
      sourceMode: "INTERNAL_ROAST",
      coffeeSourceId: csA,
      lineageProductId: rbProductA,
      grindOptions: ["WHOLE_BEAN"],
      allowCustomGrind: false,
      isActive: true,
      sortOrder: 0,
      variants: [{ packageName: "Pouch 1 kg", netWeightGrams: 1000, unitPrice: 200_000, supplyItemId: null, isActive: true }],
    });
    expect(result).toMatchObject({ success: false });
    if (!result.success) expect(result.error).toMatch(/tidak cocok/i);
  });

  it("rejects an explicit lineage binding that changes source, origin mode, or roast", async () => {
    const otherSource = await client.coffeeSource.create({
      data: { tenantId: TENANT_A, code: `CS-MISMATCH-${randomUUID().slice(0, 6)}`, name: "Mismatch Source" },
    });
    const wrongProduct = await client.product.create({
      data: {
        tenantId: TENANT_A,
        code: `RB-MISMATCH-${randomUUID().slice(0, 6)}`,
        name: "Wrong lineage",
        type: "ROASTED_BEAN",
        coffeeSourceId: otherSource.id,
        materialOrigin: "INTERNAL_ROAST",
        roastLevel: "DARK",
        isActive: true,
      },
    });

    await expect(resolveOfferingLineage(client, {
      id: "offering-explicit-mismatch",
      tenantId: TENANT_A,
      coffeeSourceId: csA,
      sourceMode: "PURCHASED_ROASTED",
      roastLevel: "MEDIUM",
      lineageProductId: wrongProduct.id,
    })).rejects.toThrow(/tidak cocok/i);
  });

  it("requires proven green-bean lineage for INTERNAL_ROAST offerings", async () => {
    const source = await client.coffeeSource.create({
      data: { tenantId: TENANT_A, code: `CS-UNPROVEN-${randomUUID().slice(0, 6)}`, name: "Unproven Internal" },
    });
    await client.product.create({
      data: {
        tenantId: TENANT_A,
        code: `RB-UNPROVEN-${randomUUID().slice(0, 6)}`,
        name: "Unproven internal RB",
        type: "ROASTED_BEAN",
        coffeeSourceId: source.id,
        materialOrigin: "INTERNAL_ROAST",
        roastLevel: "MEDIUM",
        isActive: true,
      },
    });

    await expect(resolveOfferingLineage(client, {
      id: "offering-unproven",
      tenantId: TENANT_A,
      coffeeSourceId: source.id,
      sourceMode: "INTERNAL_ROAST",
      roastLevel: "MEDIUM",
      lineageProductId: null,
    })).rejects.toThrow(/lineage|green bean|roasting/i);
  });

  it("selects internal and purchased roasted material without crossing source modes", async () => {
    const source = await client.coffeeSource.create({
      data: { tenantId: TENANT_A, code: `CS-MODES-${randomUUID().slice(0, 6)}`, name: "Dual Mode" },
    });
    const gb = await client.product.create({
      data: { tenantId: TENANT_A, code: `GB-MODES-${randomUUID().slice(0, 6)}`, name: "Dual Mode GB", type: "GREEN_BEAN", coffeeSourceId: source.id },
    });
    const [internal, purchased] = await Promise.all([
      client.product.create({
        data: { tenantId: TENANT_A, code: `RB-INT-${randomUUID().slice(0, 6)}`, name: "Internal RB", type: "ROASTED_BEAN", coffeeSourceId: source.id, sourceGreenBeanId: gb.id, materialOrigin: "INTERNAL_ROAST", roastLevel: "MEDIUM" },
      }),
      client.product.create({
        data: { tenantId: TENANT_A, code: `RB-BUY-${randomUUID().slice(0, 6)}`, name: "Purchased RB", type: "ROASTED_BEAN", coffeeSourceId: source.id, materialOrigin: "PURCHASED_ROASTED", roastLevel: "MEDIUM" },
      }),
    ]);
    const base = { id: "offering-modes", tenantId: TENANT_A, coffeeSourceId: source.id, roastLevel: "MEDIUM", lineageProductId: null };

    expect((await resolveOfferingLineage(client, { ...base, sourceMode: "INTERNAL_ROAST" })).productId).toBe(internal.id);
    expect((await resolveOfferingLineage(client, { ...base, sourceMode: "PURCHASED_ROASTED" })).productId).toBe(purchased.id);
  });

  it("rejects ambiguous automatic lineage instead of choosing by name or creation order", async () => {
    const source = await client.coffeeSource.create({
      data: { tenantId: TENANT_A, code: `CS-AMB-${randomUUID().slice(0, 6)}`, name: "Ambiguous Source" },
    });
    await client.product.createMany({
      data: ["A", "B"].map((suffix) => ({
        tenantId: TENANT_A,
        code: `RB-AMB-${suffix}-${randomUUID().slice(0, 5)}`,
        name: `Ambiguous ${suffix}`,
        type: "ROASTED_BEAN" as const,
        coffeeSourceId: source.id,
        materialOrigin: "PURCHASED_ROASTED" as const,
        roastLevel: "LIGHT",
      })),
    });

    await expect(resolveOfferingLineage(client, {
      id: "offering-ambiguous",
      tenantId: TENANT_A,
      coffeeSourceId: source.id,
      sourceMode: "PURCHASED_ROASTED",
      roastLevel: "LIGHT",
      lineageProductId: null,
    })).rejects.toThrow(/lebih dari satu|eksplisit/i);
  });

  it("reserves offering stock in kg while preserving the package count", async () => {
    const invoice = await makeInvoice(TENANT_A, "OFFA-INV-001", [
      { tenantId: TENANT_A, productId: rbProductA, quantity: 2, unitPrice: 65_000, subtotal: 130_000, hpp: 30_000, grindSize: "ESPRESSO", offeringId: null },
    ]);
    const tpA = withTenant(TENANT_A, client);
    const result = await tpA.$transaction((tx) =>
      reserveInvoiceStock(tx, {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        items: [{ productId: rbProductA, quantity: 2, quantityKg: 1.5 }],
      }),
    );

    expect(result.hasShortage).toBe(false);
    const reservations = await client.stockReservation.findMany({
      where: { tenantId: TENANT_A, invoiceId: invoice.id },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(2);
    expect(Number(reservations[0].quantityKg)).toBe(1.5);
  });

  it("caps a package larger than 1 kg by stockKg and records the whole incomplete order", async () => {
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 2, stockUnit: 99 } });
    const invoice = await makeInvoice(TENANT_A, "OFFA-INV-002", [
      { tenantId: TENANT_A, productId: rbProductA, quantity: 2, unitPrice: 65_000, subtotal: 130_000, hpp: 30_000, grindSize: "WHOLE_BEAN", netWeightGrams: 1500 },
    ]);
    const tpA = withTenant(TENANT_A, client);
    const result = await tpA.$transaction((tx) =>
      reserveInvoiceStock(tx, {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        items: [{ productId: rbProductA, quantity: 2, quantityKg: 3 }],
      }),
    );

    expect(result.hasShortage).toBe(true);
    const reservations = await client.stockReservation.findMany({
      where: { tenantId: TENANT_A, invoiceId: invoice.id },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(2);
    expect(Number(reservations[0].quantityKg)).toBe(2);
    const tasks = await client.fulfillmentTask.findMany({
      where: { tenantId: TENANT_A, invoiceId: invoice.id },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].requestedQuantity).toBe(2);
    expect(tasks[0].reservedQuantity).toBe(0);
    expect(tasks[0].shortageQuantity).toBe(2);
  });

  it("serializes two concurrent kg reservations without overselling", async () => {
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 1.5, stockUnit: 100 } });
    const invoices = await Promise.all([
      makeInvoice(TENANT_A, `OFFA-CON-A-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 1, unitPrice: 1, subtotal: 1, hpp: 0, netWeightGrams: 1000 }]),
      makeInvoice(TENANT_A, `OFFA-CON-B-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 1, unitPrice: 1, subtotal: 1, hpp: 0, netWeightGrams: 1000 }]),
    ]);
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.all(invoices.map((invoice) =>
      client.$transaction((tx) => reserveInvoiceStock(tx, {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        expiresAt,
        items: [{ productId: rbProductA, quantity: 1, quantityKg: 1 }],
      })),
    ));

    const reservations = await client.stockReservation.findMany({
      where: { tenantId: TENANT_A, invoiceId: { in: invoices.map((invoice) => invoice.id) } },
    });
    expect(reservations.reduce((sum, row) => sum + Number(row.quantityKg), 0)).toBe(1.5);
    expect(results.filter((result) => result.hasShortage)).toHaveLength(1);
  });

  it("releases a kg reservation so the same stock can be reserved again", async () => {
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 1 } });
    const first = await makeInvoice(TENANT_A, `OFFA-REL-A-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 1, unitPrice: 1, subtotal: 1, hpp: 0, netWeightGrams: 1000 }], { paidAmount: 0 });
    await client.$transaction((tx) => reserveInvoiceStock(tx, {
      tenantId: TENANT_A, invoiceId: first.id, expiresAt: new Date(Date.now() + 60_000),
      items: [{ productId: rbProductA, quantity: 1, quantityKg: 1 }],
    }));
    await client.$transaction((tx) => releaseInvoiceReservations(tx, first.id));

    const second = await makeInvoice(TENANT_A, `OFFA-REL-B-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 1, unitPrice: 1, subtotal: 1, hpp: 0, netWeightGrams: 1000 }], { paidAmount: 0 });
    const result = await client.$transaction((tx) => reserveInvoiceStock(tx, {
      tenantId: TENANT_A, invoiceId: second.id, expiresAt: new Date(Date.now() + 60_000),
      items: [{ productId: rbProductA, quantity: 1, quantityKg: 1 }],
    }));
    expect(result.hasShortage).toBe(false);
    expect(Number((await client.stockReservation.findFirstOrThrow({ where: { invoiceId: second.id } })).quantityKg)).toBe(1);
  });

  it("rolls reservation and shortage task back when the checkout transaction fails", async () => {
    const invoice = await makeInvoice(TENANT_A, `OFFA-RB-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 2, unitPrice: 1, subtotal: 2, hpp: 0, netWeightGrams: 1000 }]);
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 1 } });
    await expect(client.$transaction(async (tx) => {
      await reserveInvoiceStock(tx, {
        tenantId: TENANT_A, invoiceId: invoice.id, expiresAt: new Date(Date.now() + 60_000),
        items: [{ productId: rbProductA, quantity: 2, quantityKg: 2 }],
      });
      throw new Error("forced rollback");
    })).rejects.toThrow("forced rollback");
    expect(await client.stockReservation.count({ where: { invoiceId: invoice.id } })).toBe(0);
    expect(await client.fulfillmentTask.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it("reports canonical offering availability from stockKg minus active kg reservations", async () => {
    await client.product.update({ where: { id: rbProductA }, data: { stockKg: 2, stockUnit: 999 } });
    const invoice = await makeInvoice(TENANT_A, `OFFA-CAT-${randomUUID().slice(0, 5)}`, [{ tenantId: TENANT_A, productId: rbProductA, quantity: 2, unitPrice: 1, subtotal: 2, hpp: 0, netWeightGrams: 250 }]);
    await client.stockReservation.create({
      data: { tenantId: TENANT_A, invoiceId: invoice.id, productId: rbProductA, quantity: 2, quantityKg: 0.5, expiresAt: new Date(Date.now() + 60_000) },
    });

    const catalog = await loadStorefrontCatalog(client, TENANT_A);
    const offering = catalog.offerings.find((row) => row.code === "OF-OFFA-001");
    expect(offering?.lineageProductId).toBe(rbProductA);
    expect(offering?.availableKg).toBe(1.5);
    expect(offering?.unavailableReason).toBeNull();
    expect(catalog.products.some((product) => product.id === fgProductA)).toBe(true);
  });

  it("hands over an invoice with kg and unit reservations, posting ledger + journal", async () => {
    const invoice = await makeInvoice(TENANT_A, "OFFA-INV-003", [
      {
        tenantId: TENANT_A,
        productId: rbProductA,
        quantity: 2,
        unitPrice: 65_000,
        subtotal: 130_000,
        hpp: 30_000,
        grindSize: "ESPRESSO",
        netWeightGrams: 250,
        offeringId: null,
        offeringName: "Gayo Purwasari Medium",
        packageName: "Bungkus 250g",
        roastLevel: "MEDIUM",
      },
      {
        tenantId: TENANT_A,
        productId: fgProductA,
        quantity: 1,
        unitPrice: 80_000,
        subtotal: 80_000,
        hpp: 20_000,
        grindSize: null,
      },
    ]);
    const tpA = withTenant(TENANT_A, client);
    await client.stockReservation.createMany({
      data: [
        { tenantId: TENANT_A, invoiceId: invoice.id, productId: rbProductA, quantity: 2, quantityKg: 0.5, expiresAt: new Date(Date.now() + 1000) },
        { tenantId: TENANT_A, invoiceId: invoice.id, productId: fgProductA, quantity: 1, quantityKg: null, expiresAt: new Date(Date.now() + 1000) },
      ],
    });

    const result = await tpA.$transaction((tx) =>
      fulfillInvoiceAtHandover(tx, {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        createdById: `user-${TENANT_A}`,
      }),
    );

    expect(result.alreadyFulfilled).toBe(false);
    expect(result.fulfilledReservations).toBe(2);

    const after = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.fulfillmentStatus).toBe("DELIVERED");
    expect(after.deliveredAt).not.toBeNull();

    const active = await client.stockReservation.count({
      where: { tenantId: TENANT_A, invoiceId: invoice.id, status: "ACTIVE" },
    });
    expect(active).toBe(0);

    // Kg-mode reservation consumed the roasted bean in kg; unit-mode used units.
    const ledger = await client.inventoryLedger.findMany({
      where: { tenantId: TENANT_A, refType: "SALE_FG_OUT", refId: invoice.id },
    });
    expect(ledger).toHaveLength(2);
    const kgEntry = ledger.find((entry) => entry.productId === rbProductA);
    const unitEntry = ledger.find((entry) => entry.productId === fgProductA);
    expect(Number(kgEntry!.quantityKg)).toBe(0.5);
    expect(kgEntry!.quantityUnit).toBe(0);
    expect(unitEntry!.quantityUnit).toBe(1);
    expect(Number(unitEntry!.quantityKg)).toBe(0);

    const journal = await client.journalEntry.findFirst({
      where: { tenantId: TENANT_A, refType: "INVOICE", reference: invoice.id },
    });
    expect(journal).not.toBeNull();
  });

  it("refuses handover when the kg reservation is below the order weight", async () => {
    const invoice = await makeInvoice(TENANT_A, "OFFA-INV-004", [
      {
        tenantId: TENANT_A,
        productId: rbProductA,
        quantity: 2,
        unitPrice: 65_000,
        subtotal: 130_000,
        hpp: 30_000,
        grindSize: "WHOLE_BEAN",
        netWeightGrams: 250,
        offeringId: null,
        offeringName: "Gayo Purwasari Medium",
        packageName: "Bungkus 250g",
        roastLevel: "MEDIUM",
      },
    ]);
    await client.stockReservation.create({
      data: {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        productId: rbProductA,
        quantity: 2,
        quantityKg: 0.25,
        expiresAt: new Date(Date.now() + 1000),
      },
    });
    const tpA = withTenant(TENANT_A, client);

    await expect(
      tpA.$transaction((tx) =>
        fulfillInvoiceAtHandover(tx, {
          tenantId: TENANT_A,
          invoiceId: invoice.id,
          createdById: `user-${TENANT_A}`,
        }),
      ),
    ).rejects.toThrow("Stok pesanan belum seluruhnya dialokasikan.");

    const after = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.fulfillmentStatus).toBe("AWAITING_PAYMENT");
    const journal = await client.journalEntry.findFirst({
      where: { tenantId: TENANT_A, refType: "INVOICE", reference: invoice.id },
    });
    expect(journal).toBeNull();
  });

  it("allocates produced stock to shortages and records kg reservations on KG products", async () => {
    const skuA = await client.product.create({
      data: {
        tenantId: TENANT_A,
        code: `RB-OFFA-ALLOC-${randomUUID().slice(0, 6)}`,
        name: "Gayo Alokasi",
        type: "ROASTED_BEAN",
        materialOrigin: "PURCHASED_ROASTED",
        isActive: true,
        stockUnit: 99,
        stockKg: 0.5,
      },
    });
    const invoice = await makeInvoice(TENANT_A, `OFFA-ALLOC-${randomUUID().slice(0, 6)}`, [
      { tenantId: TENANT_A, productId: skuA.id, quantity: 5, unitPrice: 65_000, subtotal: 325_000, hpp: 30_000, netWeightGrams: 250 },
    ], { status: "PAID" });
    await client.stockReservation.create({
      data: {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        productId: skuA.id,
        quantity: 5,
        quantityKg: 0.5,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await client.fulfillmentTask.create({
      data: {
        tenantId: TENANT_A,
        invoiceId: invoice.id,
        productId: skuA.id,
        requestedQuantity: 5,
        reservedQuantity: 0,
        shortageQuantity: 5,
        status: "OPEN",
      },
    });
    // Production adds exactly the missing 0.75 kg.
    await client.product.update({ where: { id: skuA.id }, data: { stockKg: 1.25 } });

    const tpA = withTenant(TENANT_A, client);
    const result = await tpA.$transaction((tx) =>
      allocateProducedStockToDemand(tx, {
        tenantId: TENANT_A,
        productId: skuA.id,
        createdById: `user-${TENANT_A}`,
      }),
    );

    expect(result).toEqual({ allocatedUnits: 5, completedTasks: 1 });
    const reservation = await client.stockReservation.findFirstOrThrow({
      where: { tenantId: TENANT_A, invoiceId: invoice.id, productId: skuA.id },
    });
    expect(reservation.quantity).toBe(5);
    expect(Number(reservation.quantityKg)).toBe(1.25);
    const task = await client.fulfillmentTask.findFirstOrThrow({
      where: { tenantId: TENANT_A, invoiceId: invoice.id },
    });
    expect(task.status).toBe("COMPLETED");
  });
});
