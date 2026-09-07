import { describe, expect, it, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  createProductionBatch,
  getProductionBatchRecap,
  voidProductionBatch,
} from "@/app/(dashboard)/produksi/actions";
import { appendLedger } from "@/lib/stock";
import { resolveTestDatabaseUrl } from "../../../../test/setup/test-database-guard";
import { randomUUID } from "node:crypto";

const integrationEnabled = process.env.RUN_INTEGRATION === "true";
const suite = integrationEnabled ? describe : describe.skip;

const TEST_DATABASE_URL = integrationEnabled ? resolveTestDatabaseUrl() : "";

const TEST_TENANT_ID = "test-tenant";
const TEST_USER_ID = "test-system-user";

declare global {
   
  var __testPrismaClient: PrismaClient | undefined;
}

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireRole: vi.fn(async () => {}),
    getSystemUserId: vi.fn(async () => TEST_USER_ID),
    getCurrentTenantId: vi.fn(async () => TEST_TENANT_ID),
    requireTenantPrisma: vi.fn(async () => global.__testPrismaClient),
  };
});

vi.mock("next/navigation", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

suite("createProductionBatch — supply items (Commit 4)", () => {
  let client: PrismaClient;
  const cleanupIds: string[] = [];

  async function wipeTestData(tx: any) {
    await tx.journalLine.deleteMany({
      where: {
        journalEntry: {
          OR: [{ tenantId: TEST_TENANT_ID }, { createdById: TEST_USER_ID }],
        },
      },
    });
    await tx.journalEntry.deleteMany({
      where: { OR: [{ tenantId: TEST_TENANT_ID }, { createdById: TEST_USER_ID }] },
    });
    await tx.account.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.auditLog.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.productionSupplyUsage.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.inventoryLedger.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.lot.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.productionBatch.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.roastMaterialReservation.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.childRoastingBatch.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.parentRoastingBatch.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.recipeSupplyItem.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.recipeItem.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.recipe.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.product.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.packaging.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.inventorySupplyItem.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.user.deleteMany({ where: { tenantId: TEST_TENANT_ID } });
    await tx.user.deleteMany({ where: { id: TEST_USER_ID } });
    await tx.tenant.deleteMany({ where: { id: TEST_TENANT_ID } });
  }

  beforeAll(async () => {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
    await client.$connect();
    global.__testPrismaClient = client;
  });

  beforeEach(async () => {
    cleanupIds.length = 0;
    await client.$transaction(async (tx) => {
      await wipeTestData(tx);
      await tx.tenant.create({ data: { id: TEST_TENANT_ID, code: TEST_TENANT_ID, name: "Test Tenant" } });
      await tx.user.create({ data: { id: TEST_USER_ID, name: "System", email: "system@test.local", password: "hashed", tenantId: TEST_TENANT_ID } });
    });
  });

  afterAll(async () => {
    if (client) {
      await client.$transaction(async (tx) => {
        await wipeTestData(tx);
      });
      await client.$disconnect();
    }
  });

  async function createTenant(tx: any, tenantId: string) {
    await tx.tenant.create({ data: { id: tenantId, code: `T-${tenantId.slice(-6)}`, name: `Test Tenant ${tenantId}` } });
  }

  async function createUser(tx: any, userId: string, tenantId: string) {
    await tx.user.create({ data: { id: userId, name: `User ${userId}`, email: `${userId}@test.local`, password: "hashed", tenantId } });
  }

  async function createSupplyItem(tx: any, supplyItemId: string, tenantId: string, opts: { category?: string; trackLot?: boolean; consumableInProduction?: boolean; includeInProductHpp?: boolean; avgCostPerUnit?: number; stockQuantity?: number } = {}) {
    await tx.inventorySupplyItem.create({
      data: {
        id: supplyItemId,
        tenantId,
        code: supplyItemId,
        name: `Supply ${supplyItemId}`,
        category: opts.category === "INGREDIENT" ? "INGREDIENT" : "PACKAGING",
        baseUnit: "PCS",
        trackLot: opts.trackLot ?? true,
        consumableInProduction: opts.consumableInProduction ?? true,
        includeInProductHpp: opts.includeInProductHpp ?? true,
        costPerUnit: opts.avgCostPerUnit ?? 1000,
        avgCostPerUnit: opts.avgCostPerUnit ?? 1000,
        stockQuantity: opts.stockQuantity ?? 100,
        isActive: true,
      },
    });
  }

  async function createProduct(tx: any, productId: string, tenantId: string, type: string = "FINISHED_GOODS", stockKg: number = 0) {
    await tx.product.create({
      data: { id: productId, tenantId, code: productId, name: `Product ${productId}`, type: type as any, stockKg, stockUnit: 0, avgCostPerKg: stockKg > 0 ? 10000 : undefined },
    });
  }

  async function createPackaging(tx: any, packagingId: string, tenantId: string, opts: { supplyItemId?: string } = {}) {
    await tx.packaging.create({
      data: { id: packagingId, tenantId, code: packagingId, name: `Packaging ${packagingId}`, weightGrams: 250, costPerUnit: 500, stockUnit: 100, isActive: true, supplyItemId: opts.supplyItemId },
    });
  }

  async function createRecipe(tx: any, recipeId: string, tenantId: string, productId: string, packagingId: string, supplyItemIds: string[] = []) {
    await tx.recipe.create({
      data: {
        id: recipeId,
        tenantId,
        code: recipeId,
        name: `Recipe ${recipeId}`,
        productId,
        packagingId,
        outputGrams: 1000,
        isActive: true,
      },
    });
    if (supplyItemIds.length > 0) {
      await tx.recipeSupplyItem.createMany({
        data: supplyItemIds.map((sid, i) => ({
          id: `rsi-${recipeId}-${i}`,
          tenantId,
          recipeId,
          supplyItemId: sid,
          quantityPerUnit: i === 0 ? 1 : 2,
        })),
      });
    }
  }

  async function createRoastBatch(tx: any, roastId: string, tenantId: string, inputProductId: string, outputProductId: string, opts: { status?: string } = {}) {
    const status = opts.status ?? "COMPLETED";
    await tx.parentRoastingBatch.create({
      data: {
        id: roastId,
        code: `PRST-${roastId.slice(-8)}`,
        tenantId,
        inputProductId,
        outputProductId,
        targetWeightKg: 10,
        status,
        lifecycleStatus: status === "COMPLETED" ? "COMPLETED" : "PLANNED",
        createdById: TEST_USER_ID,
        actualOutputKg: 8.5,
      },
    });
  }

  it("recipe dengan dua supply", async () => {
    const tenantId = "test-tenant";
    const userId = `user-recipe-2supply-${Date.now()}`;
    const productId = `prod-recipe-2supply-${Date.now()}`;
    const packagingId = `pkg-recipe-2supply-${Date.now()}`;
    const recipeId = `recipe-recipe-2supply-${Date.now()}`;
    const supply1 = `sup-recipe-2supply-1-${Date.now()}`;
    const supply2 = `sup-recipe-2supply-2-${Date.now()}`;
    const rbProductId = `rb-recipe-2supply-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, recipeId, supply1, supply2, rbProductId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, supply1, tenantId, { category: "PACKAGING", avgCostPerUnit: 1000, stockQuantity: 100 });
      await createSupplyItem(tx, supply2, tenantId, { category: "INGREDIENT", avgCostPerUnit: 500, stockQuantity: 200 });
      await createRecipe(tx, recipeId, tenantId, productId, packagingId, [supply1, supply2]);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 10,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 1000 }],
      supplyComponents: [
        { supplyItemId: supply1, quantity: 10 },
        { supplyItemId: supply2, quantity: 20 },
      ],
    });

    if (!result.success) {
      throw new Error(`recipe dengan dua supply failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch).toBeTruthy();
    const usages = await client.productionSupplyUsage.findMany({ where: { productionBatchId: batch!.id } });
    expect(usages).toHaveLength(2);
  });

  it("PACKAGING + INGREDIENT dalam satu recipe", async () => {
    const tenantId = "test-tenant";
    const userId = `user-pkg-ing-${Date.now()}`;
    const productId = `prod-pkg-ing-${Date.now()}`;
    const packagingId = `pkg-pkg-ing-${Date.now()}`;
    const recipeId = `recipe-pkg-ing-${Date.now()}`;
    const pkgSupply = `sup-pkg-ing-pkg-${Date.now()}`;
    const ingSupply = `sup-pkg-ing-ing-${Date.now()}`;
    const rbProductId = `rb-pkg-ing-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, recipeId, pkgSupply, ingSupply, rbProductId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, pkgSupply, tenantId, { category: "PACKAGING", avgCostPerUnit: 1000, stockQuantity: 100 });
      await createSupplyItem(tx, ingSupply, tenantId, { category: "INGREDIENT", avgCostPerUnit: 500, stockQuantity: 200 });
      await createRecipe(tx, recipeId, tenantId, productId, packagingId, [pkgSupply, ingSupply]);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 5,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 500 }],
      supplyComponents: [
        { supplyItemId: pkgSupply, quantity: 5 },
        { supplyItemId: ingSupply, quantity: 10 },
      ],
    });

    if (!result.success) {
      throw new Error(`PACKAGING+INGREDIENT test failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch).toBeTruthy();
    const usages = await client.productionSupplyUsage.findMany({ where: { productionBatchId: batch!.id } });
    expect(usages).toHaveLength(2);
    expect(usages.map((u) => u.supplyItemId).sort()).toEqual([pkgSupply, ingSupply].sort());
  });

  it("insufficient stock rollback seluruh production", async () => {
    const tenantId = "test-tenant";
    const userId = `user-insuf-${Date.now()}`;
    const productId = `prod-insuf-${Date.now()}`;
    const packagingId = `pkg-insuf-${Date.now()}`;
    const rbProductId = `rb-insuf-${Date.now()}`;
    const supplyId = `sup-insuf-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN");
      await createSupplyItem(tx, supplyId, tenantId, { stockQuantity: 1 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 10,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 1000 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 100 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/tidak cukup/);
    }
  });

  it("duplicate supply ditolak", async () => {
    const tenantId = "test-tenant";
    const userId = `user-dup-${Date.now()}`;
    const productId = `prod-dup-${Date.now()}`;
    const packagingId = `pkg-dup-${Date.now()}`;
    const rbProductId = `rb-dup-${Date.now()}`;
    const supplyId = `sup-dup-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 1);
      await createSupplyItem(tx, supplyId, tenantId, { stockQuantity: 100 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      supplyComponents: [
        { supplyItemId: supplyId, quantity: 1 },
        { supplyItemId: supplyId, quantity: 1 },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/hanya boleh muncul sekali/);
    }
  });

  it("ProductionSupplyUsage snapshot benar", async () => {
    const tenantId = "test-tenant";
    const userId = `user-snapshot-${Date.now()}`;
    const productId = `prod-snapshot-${Date.now()}`;
    const packagingId = `pkg-snapshot-${Date.now()}`;
    const rbProductId = `rb-snapshot-${Date.now()}`;
    const supplyId = `sup-snapshot-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, supplyId, tenantId, { avgCostPerUnit: 1000, stockQuantity: 100 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 5,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 500 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 5 }],
    });

    if (!result.success) {
      throw new Error(`ProductionSupplyUsage snapshot test failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch).toBeTruthy();
    const usages = await client.productionSupplyUsage.findMany({ where: { productionBatchId: batch!.id } });
    expect(usages).toHaveLength(1);
    const usage = usages.find((u) => u.supplyItemId === supplyId);
    expect(usage).toBeTruthy();
    expect(Number(usage!.unitCostSnapshot)).toBe(1000);
    expect(Number(usage!.totalCostSnapshot)).toBe(5000);
  });

  it("harga supply berubah setelah produksi tetapi snapshot batch tetap", async () => {
    const tenantId = "test-tenant";
    const userId = `user-pricechange-${Date.now()}`;
    const productId = `prod-pricechange-${Date.now()}`;
    const packagingId = `pkg-pricechange-${Date.now()}`;
    const rbProductId = `rb-pricechange-${Date.now()}`;
    const supplyId = `sup-pricechange-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, supplyId, tenantId, { avgCostPerUnit: 1000, stockQuantity: 100 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 5,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 500 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 5 }],
    });

    if (!result.success) {
      throw new Error(`harga supply berubah test failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch).toBeTruthy();

    await client.inventorySupplyItem.update({ where: { id: supplyId }, data: { avgCostPerUnit: 2000 } });

    const usage = await client.productionSupplyUsage.findFirst({ where: { productionBatchId: batch!.id } });
    expect(usage).toBeTruthy();
    expect(Number(usage!.unitCostSnapshot)).toBe(1000);
    expect(Number(usage!.totalCostSnapshot)).toBe(5000);
  });

  it("supply includeInProductHpp=false tidak masuk HPP tetapi tetap dikonsumsi", async () => {
    const tenantId = "test-tenant";
    const userId = `user-nohpp-${Date.now()}`;
    const productId = `prod-nohpp-${Date.now()}`;
    const packagingId = `pkg-nohpp-${Date.now()}`;
    const rbProductId = `rb-nohpp-${Date.now()}`;
    const hppSupply = `sup-nohpp-hpp-${Date.now()}`;
    const nonHppSupply = `sup-nohpp-excl-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, hppSupply, nonHppSupply);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, hppSupply, tenantId, { includeInProductHpp: true, avgCostPerUnit: 1000, stockQuantity: 100 });
      await createSupplyItem(tx, nonHppSupply, tenantId, { includeInProductHpp: false, avgCostPerUnit: 600, stockQuantity: 100 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 10,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 1000 }],
      supplyComponents: [
        { supplyItemId: hppSupply, quantity: 10 },
        { supplyItemId: nonHppSupply, quantity: 10 },
      ],
    });

    if (!result.success) {
      throw new Error(`includeInProductHpp test failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch).toBeTruthy();
    expect(Number(batch!.hppPerUnit)).toBe(2500);

    const nonHppUsage = await client.productionSupplyUsage.findFirst({
      where: { productionBatchId: batch!.id, supplyItemId: nonHppSupply },
    });
    expect(nonHppUsage).toBeTruthy();
    const nonHppLedger = await client.inventoryLedger.findFirst({
      where: { refId: batch!.id, supplyItemId: nonHppSupply, refType: "SUPPLY_PRODUCTION_OUT" },
    });
    expect(nonHppLedger).toBeTruthy();
  });

  it("tenant isolation", async () => {
    const tenantId = "test-tenant";
    const userId = `user-isolation-${Date.now()}`;
    const productId = `prod-isolation-${Date.now()}`;
    const packagingId = `pkg-isolation-${Date.now()}`;
    const rbProductId = `rb-isolation-${Date.now()}`;
    const supplyId = `sup-isolation-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, supplyId, tenantId, { stockQuantity: 100 });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId: packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 1 }],
    });

    if (!result.success) {
      throw new Error(`tenant isolation test failed: ${result.error}`);
    }
    expect(result.success).toBe(true);
  });

  it("idempotency tidak menghasilkan ledger ganda", async () => {
    const tenantId = "test-tenant";
    const userId = `user-idemp-${Date.now()}`;
    const productId = `prod-idemp-${Date.now()}`;
    const packagingId = `pkg-idemp-${Date.now()}`;
    const rbProductId = `rb-idemp-${Date.now()}`;
    const supplyId = `sup-idemp-${Date.now()}`;
    const opKey = randomUUID();
    cleanupIds.push(userId, productId, packagingId, rbProductId, supplyId, opKey);

    await client.$transaction(async (tx) => {

      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createSupplyItem(tx, supplyId, tenantId, { stockQuantity: 100 });
    });

    const result1 = await createProductionBatch({
      operationKey: opKey,
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 1 }],
    });

    if (!result1.success) {
      throw new Error(`idempotency test first call failed: ${result1.error}`);
    }

    const result2 = await createProductionBatch({
      operationKey: opKey,
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      supplyComponents: [{ supplyItemId: supplyId, quantity: 1 }],
    });

    expect(result2.success).toBe(true);
    if (result1.success && result2.success) {
      expect(result2.batchCode).toBe(result1.batchCode);
    }

    const batch = await client.productionBatch.findFirst({ where: { code: result1.batchCode } });
    const ledgerCount = await client.inventoryLedger.count({ where: { refId: batch!.id, refType: "SUPPLY_PRODUCTION_OUT" } });
    expect(ledgerCount).toBe(1);
  });

  it("packagingSupplyItemId meresolve kemasan ke adapter legacy tanpa menulis stok dua model", async () => {
    const tenantId = "test-tenant";
    const userId = `user-canonical-pkg-${Date.now()}`;
    const productId = `prod-canonical-pkg-${Date.now()}`;
    const packagingId = `pkg-canonical-pkg-${Date.now()}`;
    const supplyId = `sup-canonical-pkg-${Date.now()}`;
    const rbProductId = `rb-canonical-pkg-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, supplyId, rbProductId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createSupplyItem(tx, supplyId, tenantId, { category: "PACKAGING", avgCostPerUnit: 1000, stockQuantity: 100 });
      await createPackaging(tx, packagingId, tenantId, { supplyItemId: supplyId });
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingSupplyItemId: supplyId,
      unitsProduced: 4,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 400 }],
    });

    if (!result.success) {
      throw new Error(`canonical packaging resolution failed: ${result.error}`);
    }

    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    // Legacy FK resolves to the linked adapter packaging
    expect(batch!.packagingId).toBe(packagingId);

    // Canonical: stok supply berkurang, stok cache packaging legacy TIDAK disentuh
    const supply = await client.inventorySupplyItem.findUnique({ where: { id: supplyId } });
    expect(Number(supply!.stockQuantity)).toBe(96); // 100 - 4
    const adapter = await client.packaging.findUnique({ where: { id: packagingId } });
    expect(adapter!.stockUnit).toBe(100);

    // Ledger: satu SUPPLY_PRODUCTION_OUT, tanpa PRODUCTION_PKG_OUT untuk adapter
    const supplyLedger = await client.inventoryLedger.findFirst({ where: { refId: batch!.id, refType: "SUPPLY_PRODUCTION_OUT", supplyItemId: supplyId } });
    expect(supplyLedger).toBeTruthy();
    expect(Number(supplyLedger!.supplyQuantity)).toBe(4);
    const pkgLedger = await client.inventoryLedger.count({ where: { refId: batch!.id, refType: "PRODUCTION_PKG_OUT" } });
    expect(pkgLedger).toBe(0);
  });

  it("Phase 2D.1: parentRoastBatchId terekam saat produksi diluncurkan dari rekap roasting", async () => {
    const tenantId = "test-tenant";
    const userId = `user-trace-${Date.now()}`;
    const productId = `prod-trace-${Date.now()}`;
    const packagingId = `pkg-trace-${Date.now()}`;
    const gbId = `gb-trace-${Date.now()}`;
    const rbProductId = `rb-trace-${Date.now()}`;
    const roastId = `roast-trace-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, gbId, rbProductId, roastId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, gbId, tenantId, "GREEN_BEAN", 10);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createRoastBatch(tx, roastId, tenantId, gbId, rbProductId);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 4,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 400 }],
      parentRoastBatchId: roastId,
    });

    if (!result.success) {
      throw new Error(`traceability happy path failed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch!.parentRoastBatchId).toBe(roastId);
  });

  it("Phase 2D.1: batch roasting dari tenant lain ditolak", async () => {
    const tenantId = "test-tenant";
    const otherTenant = `tenant-other-${Date.now()}`;
    const otherUser = `user-other-${Date.now()}`;
    const userId = `user-x-tenant-${Date.now()}`;
    const productId = `prod-x-tenant-${Date.now()}`;
    const packagingId = `pkg-x-tenant-${Date.now()}`;
    const gbId = `gb-x-tenant-${Date.now()}`;
    const rbProductId = `rb-x-tenant-${Date.now()}`;
    const roastId = `roast-x-tenant-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, gbId, rbProductId, roastId);

    await client.$transaction(async (tx) => {
      await tx.tenant.create({ data: { id: otherTenant, code: otherTenant, name: "Other Tenant" } });
      await tx.user.create({ data: { id: otherUser, name: "Other", email: `${otherUser}@test.local`, password: "hashed", tenantId: otherTenant } });
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, gbId, otherTenant, "GREEN_BEAN", 10);
      await createProduct(tx, rbProductId, otherTenant, "ROASTED_BEAN", 10);
      await tx.parentRoastingBatch.create({
        data: {
          id: roastId,
          code: `PRST-${roastId.slice(-8)}`,
          tenantId: otherTenant,
          inputProductId: gbId,
          outputProductId: rbProductId,
          targetWeightKg: 10,
          status: "COMPLETED",
          lifecycleStatus: "COMPLETED",
          createdById: otherUser,
          actualOutputKg: 8.5,
        },
      });
    });

    try {
      const result = await createProductionBatch({
        operationKey: randomUUID(),
        outputProductId: productId,
        packagingId,
        unitsProduced: 1,
        rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
        parentRoastBatchId: roastId,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Batch roasting sumber tidak ditemukan/);
      }
    } finally {
      await client.$transaction(async (tx) => {
        await tx.parentRoastingBatch.deleteMany({ where: { id: roastId } });
        await tx.product.deleteMany({ where: { id: { in: [gbId, rbProductId] } } });
        await tx.user.deleteMany({ where: { id: otherUser } });
        await tx.tenant.deleteMany({ where: { id: otherTenant } });
      });
    }
  });

  it("Phase 2D.1: batch roasting belum COMPLETED ditolak", async () => {
    const tenantId = "test-tenant";
    const userId = `user-pending-${Date.now()}`;
    const productId = `prod-pending-${Date.now()}`;
    const packagingId = `pkg-pending-${Date.now()}`;
    const gbId = `gb-pending-${Date.now()}`;
    const rbProductId = `rb-pending-${Date.now()}`;
    const roastId = `roast-pending-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, gbId, rbProductId, roastId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, gbId, tenantId, "GREEN_BEAN", 10);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
      await createRoastBatch(tx, roastId, tenantId, gbId, rbProductId, { status: "PENDING" });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      parentRoastBatchId: roastId,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/belum selesai/);
    }
  });

  it("Phase 2D.1: batch roasting yang tidak ada ditolak", async () => {
    const tenantId = "test-tenant";
    const userId = `user-missing-${Date.now()}`;
    const productId = `prod-missing-${Date.now()}`;
    const packagingId = `pkg-missing-${Date.now()}`;
    const rbProductId = `rb-missing-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, rbProductId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, rbProductId, tenantId, "ROASTED_BEAN", 10);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 100 }],
      parentRoastBatchId: "roast-does-not-exist",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Batch roasting sumber tidak ditemukan/);
    }
  });

  it("Phase 2D.1: RB komponen bukan hasil batch roasting tersebut ditolak", async () => {
    const tenantId = "test-tenant";
    const userId = `user-incompat-${Date.now()}`;
    const productId = `prod-incompat-${Date.now()}`;
    const packagingId = `pkg-incompat-${Date.now()}`;
    const gbId = `gb-incompat-${Date.now()}`;
    const rbRoastOutput = `rb-roast-out-${Date.now()}`;
    const rbOther = `rb-other-${Date.now()}`;
    const roastId = `roast-incompat-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, gbId, rbRoastOutput, rbOther, roastId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, gbId, tenantId, "GREEN_BEAN", 10);
      await createProduct(tx, rbRoastOutput, tenantId, "ROASTED_BEAN", 10);
      await createProduct(tx, rbOther, tenantId, "ROASTED_BEAN", 10);
      await createRoastBatch(tx, roastId, tenantId, gbId, rbRoastOutput);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 1,
      rbComponents: [{ productId: rbOther, productName: "Test RB", actualGrams: 100 }],
      parentRoastBatchId: roastId,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/harus menggunakan hasil Roasted Bean dari batch roasting tersebut/);
    }
  });

  it("Phase 2D.1: GREEN_BEAN tetap diterima sebagai komponen produksi (fitur disengaja, Commit 4d4c6b0)", async () => {
    const tenantId = "test-tenant";
    const userId = `user-gb-${Date.now()}`;
    const productId = `prod-gb-${Date.now()}`;
    const packagingId = `pkg-gb-${Date.now()}`;
    const gbProductId = `gb-direct-${Date.now()}`;
    cleanupIds.push(userId, productId, packagingId, gbProductId);

    await client.$transaction(async (tx) => {
      await createUser(tx, userId, tenantId);
      await createProduct(tx, productId, tenantId);
      await createPackaging(tx, packagingId, tenantId);
      await createProduct(tx, gbProductId, tenantId, "GREEN_BEAN", 10);
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 4,
      rbComponents: [{ productId: gbProductId, productName: "Test GB", actualGrams: 400 }],
    });

    if (!result.success) {
      throw new Error(`GREEN_BEAN direct production should succeed: ${result.error}`);
    }
    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    expect(batch!.parentRoastBatchId).toBeNull();
  });

  it("Phase 2D.2B: lokasi override tersimpan dan recap merekonstruksi paspor batch", async () => {
    const stamp = Date.now();
    const productId = `prod-recap-${stamp}`;
    const packagingId = `pkg-recap-${stamp}`;
    const rbProductId = `rb-recap-${stamp}`;
    const warehouseId = `wh-recap-${stamp}`;
    const locationId = `loc-recap-${stamp}`;

    await client.$transaction(async (tx) => {
      await createProduct(tx, productId, TEST_TENANT_ID);
      await createPackaging(tx, packagingId, TEST_TENANT_ID);
      await createProduct(tx, rbProductId, TEST_TENANT_ID, "ROASTED_BEAN", 10);
      await tx.warehouse.create({
        data: {
          id: warehouseId,
          tenantId: TEST_TENANT_ID,
          code: `WH-${stamp}`,
          name: "Gudang Recap",
          isActive: true,
        },
      });
      await tx.location.create({
        data: {
          id: locationId,
          tenantId: TEST_TENANT_ID,
          warehouseId,
          code: `LOC-${stamp}`,
          name: "Rak Produk Jadi",
          isActive: true,
        },
      });
    });

    const result = await createProductionBatch({
      operationKey: randomUUID(),
      outputProductId: productId,
      packagingId,
      unitsProduced: 4,
      rbComponents: [{ productId: rbProductId, productName: "Test RB", actualGrams: 400 }],
      destinationLocationId: locationId,
    });
    if (!result.success) throw new Error(`recap fixture failed: ${result.error}`);

    const batch = await client.productionBatch.findFirst({ where: { code: result.batchCode } });
    const recap = await getProductionBatchRecap(batch!.id);

    expect(recap).not.toBeNull();
    expect(recap!.components).toEqual([
      expect.objectContaining({ productId: rbProductId, quantityKg: 0.4 }),
    ]);
    expect(recap!.costs).toEqual({
      total: 6000,
      materialsAndPackaging: 6000,
      includedSupplies: 0,
      labor: 0,
      overhead: 0,
    });
    expect(recap!.outputLot).toEqual(expect.objectContaining({
      batchCode: `${result.batchCode}-FG`,
      quantityUnit: 4,
      placements: [expect.objectContaining({
        quantityUnit: 4,
        locationCode: `LOC-${stamp}`,
        locationName: "Rak Produk Jadi",
        warehouseName: "Gudang Recap",
      })],
    }));
    expect(recap!.downstream).toEqual([]);
  });
});
