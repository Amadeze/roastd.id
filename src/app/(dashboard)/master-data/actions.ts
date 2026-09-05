"use server";
import { requireRole, requireTenantPrisma, getCurrentTenantId } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { coffeeSourceCreateDataFromProduct, normalizeCoffeeIdentity, type CoffeeIdentityInput } from "@/lib/coffee-identity";
import {
  customerInputSchema,
  emptyToNull,
  normalizeEmail,
  normalizePhone,
  sameNormalizedPhone,
  supplierInputSchema,
  type CustomerInput,
  type SupplierInput,
} from "@/lib/master-data-input";

// =============================================================================
// TYPES
// =============================================================================

export type SupplierRow = {
  id: string; code: string; name: string; phone: string | null;
  address: string | null; region: string | null; isActive: boolean;
  createdAt: string; purchaseCount: number;
};

export type CustomerRow = {
  id: string; code: string; name: string; phone: string | null;
  email: string | null; address: string | null; isActive: boolean;
  tier: "RETAIL" | "WHOLESALE_SILVER" | "WHOLESALE_GOLD";
  createdAt: string; invoiceCount: number;
};

export type PackagingRow = {
  id: string; code: string; name: string;
  weightGrams: number; costPerUnit: number; isActive: boolean;
  reorderAlertEnabled: boolean;
  leadTimeDays: number;
  safetyStockQuantity: number;
  reorderLookbackDays: number;
};

export type UserRow = {
  id: string; name: string; email: string;
  role: "OWNER" | "MANAGER" | "OPERATOR" | "CASHIER";
  isActive: boolean; createdAt: string;
};

export type ProductRecipeItem = {
  id: string; rbProductId: string; gramsPerUnit: number; ratioPercent: number;
};

export type ProductRecipeSupplyItem = {
  supplyItemId: string;
  quantityPerUnit: number;
};

export type ProductRecipe = {
  id: string; packagingId: string; outputGrams: number; notes: string | null;
  storefrontGrindOptions: Array<"WHOLE_BEAN" | "COARSE" | "MEDIUM_COARSE" | "MEDIUM" | "MEDIUM_FINE" | "FINE" | "ESPRESSO" | "CUSTOM">;
  items: ProductRecipeItem[];
  supplyItems: ProductRecipeSupplyItem[];
};

export type CoffeeSourceRow = {
  id: string;
  code: string;
  name: string;
  country: string | null;
  region: string | null;
  farm: string | null;
  species: string | null;
  varietal: string | null;
  processMethod: string | null;
  fermentationMethod: string | null;
  elevation: string | null;
  cropYear: string | null;
  certifications: string[];
  tastingNotes: string | null;
  isActive: boolean;
};

export type ProductRow = {
  id: string; code: string; name: string;
  type: "GREEN_BEAN" | "ROASTED_BEAN" | "FINISHED_GOODS" | "PACKAGING";
  coffeeSpecies: string | null;
  category: string | null;
  origin: string | null; roastLevel: string | null; description: string | null;
  imageUrl: string | null;
  isActive: boolean; createdAt: string;
  materialOrigin: "INTERNAL_ROAST" | "PURCHASED_ROASTED" | null;
  sourceGreenBeanId: string | null;
  coffeeSource: CoffeeSourceRow | null;
  price: number;
  priceSilver: number;
  priceGold: number;
  latestHppPerKg?: number;
  lastHpp?: number;
  recipe: ProductRecipe | null;
  reorderAlertEnabled: boolean;
  netWeightGrams: number | null;
  leadTimeDays: number;
  safetyStockQuantity: number;
  reorderLookbackDays: number;
};

export type SupplyItemCategory =
  | "PACKAGING"
  | "INGREDIENT"
  | "CONSUMABLE"
  | "MERCHANDISE"
  | "SPARE_PART"
  | "EQUIPMENT"
  | "OTHER";

export type SupplyBaseUnitValue =
  | "KG"
  | "GRAM"
  | "LITER"
  | "METER"
  | "ROLL"
  | "PCS"
  | "BOX"
  | "SET"
  | "OTHER";

export type SupplyItemRow = {
  id: string;
  code: string;
  name: string;
  category: SupplyItemCategory;
  baseUnit: SupplyBaseUnitValue;
  trackLot: boolean;
  shelfLifeDays: number | null;
  consumableInProduction: boolean;
  includeInProductHpp: boolean;
  capacityGrams: number | null;
  tareWeightGrams: number | null;
  costPerUnit: number;
  avgCostPerUnit: number;
  stockQuantity: number;
  isActive: boolean;
  reorderAlertEnabled: boolean;
  leadTimeDays: number;
  safetyStockQuantity: number;
  reorderLookbackDays: number;
};

export type OfferingVariantRow = {
  id: string;
  packageName: string;
  netWeightGrams: number;
  unitPrice: number;
  supplyItemId: string | null;
  isActive: boolean;
};

export type OfferingRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  coffeeSourceId: string;
  lineageProductId: string | null;
  coffeeSource: CoffeeSourceRow | null;
  sourceMode: "PURCHASED_ROASTED" | "INTERNAL_ROAST";
  roastLevel: string | null;
  grindOptions: string[];
  allowCustomGrind: boolean;
  isActive: boolean;
  sortOrder: number;
  variants: OfferingVariantRow[];
};

export type MasterPageData = {
  suppliers:  SupplierRow[];
  customers:  CustomerRow[];
  products:   ProductRow[];
  packagings: PackagingRow[];
  supplyItems: SupplyItemRow[];
  users:      UserRow[];
  coffeeSources: CoffeeSourceRow[];
  offerings:  OfferingRow[];
};

// =============================================================================
// PAGE DATA
// =============================================================================

export async function getMasterData(): Promise<MasterPageData> {
  await requireRole("OWNER", "MANAGER", "OPERATOR");
  const tp = await requireTenantPrisma();
  const [suppliers, customers, products, packagings, supplyItems, users, coffeeSources, offerings] = await Promise.all([
    tp.supplier.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { purchases: true } } },
    }),

    tp.customer.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { invoices: true } } },
    }),

    // ✅ QUERY PRODUCT YANG SUDAH DIPERBAIKI
 tp.product.findMany({
  orderBy: [{ type: "asc" }, { name: "asc" }],
  select: {
    id: true,
    code: true,
    name: true,
    type: true,
    coffeeSpecies: true,
    category: true,
    origin: true,
    roastLevel: true,
    materialOrigin: true,
    sourceGreenBeanId: true,
    description: true,
    imageUrl: true,
    isActive: true,
    createdAt: true,
    coffeeSource: {
      select: {
        id: true,
        code: true,
        name: true,
        country: true,
        region: true,
        farm: true,
        species: true,
        varietal: true,
        processMethod: true,
        fermentationMethod: true,
        elevation: true,
        cropYear: true,
        certifications: true,
        tastingNotes: true,
        isActive: true,
      },
    },
    price: true,
    priceSilver: true,
    priceGold: true,
    netWeightGrams: true,
    lastHpp: true,
    avgCostPerKg: true,
    reorderAlertEnabled: true,
    leadTimeDays: true,
    safetyStockQuantity: true,
    reorderLookbackDays: true,
      recipes: {
        where: { isActive: true },
        select: {
          id: true,
          packagingId: true,
          outputGrams: true,
          storefrontGrindOptions: true,
          notes: true,
          items: {
            select: {
              id: true,
              productId: true,
              gramsPerUnit: true,
              ratioPercent: true,
            }
          },
          supplyItems: {
            select: {
              id: true,
              supplyItemId: true,
              quantityPerUnit: true,
            }
          }
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    // For FINISHED_GOODS HPP fallback
    productionBatches: {
      where: { status: "COMPLETED" },
      orderBy: { producedAt: "desc" },
      take: 1,
      select: { hppPerUnit: true }
    },
  },
}),

    tp.packaging.findMany({
      orderBy: { name: "asc" },
    }),

    tp.inventorySupplyItem.findMany({
      orderBy: { name: "asc" },
    }),

    tp.user.findMany({
      orderBy: { createdAt: "desc" },
      select: { 
        id: true, 
        name: true, 
        email: true, 
        role: true, 
        isActive: true, 
        createdAt: true 
      },
    }),

    tp.coffeeSource.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true, code: true, name: true, country: true, region: true,
        farm: true, species: true, varietal: true, processMethod: true,
        fermentationMethod: true, elevation: true, cropYear: true,
        certifications: true, tastingNotes: true, isActive: true,
      },
    }),

    tp.coffeeOffering.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      include: {
        coffeeSource: {
          select: {
            id: true, code: true, name: true, country: true, region: true,
            farm: true, species: true, varietal: true, processMethod: true,
            fermentationMethod: true, elevation: true, cropYear: true,
            certifications: true, tastingNotes: true, isActive: true,
          },
        },
        variants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    }),
  ]);

  return {
    suppliers: suppliers.map((s) => ({
      id: s.id, code: s.code, name: s.name, phone: s.phone,
      address: s.address, region: s.region, isActive: s.isActive,
      createdAt: s.createdAt.toISOString(), purchaseCount: s._count.purchases,
    })),

    customers: customers.map((c) => ({
      id: c.id, code: c.code, name: c.name, phone: c.phone,
      email: c.email, address: c.address, isActive: c.isActive,
      tier: c.tier as CustomerRow["tier"],
      createdAt: c.createdAt.toISOString(),
      invoiceCount: c._count.invoices,
    })),

    products: products.map((p) => {
      const r = p.recipes[0] ?? null;
      // Use the WAC-maintained avgCostPerKg — already updated by appendLedger on every purchase/roasting IN
      const latestHppPerKg = Number(p.avgCostPerKg ?? 0);

      return {
        id: p.id,
        code: p.code,
        name: p.name,
        type: p.type as ProductRow["type"],
        coffeeSpecies: p.coffeeSpecies,
        category: p.category,
        origin: p.origin,
        roastLevel: p.roastLevel,
        materialOrigin: p.materialOrigin,
        sourceGreenBeanId: p.sourceGreenBeanId,
        coffeeSource: p.coffeeSource
          ? {
              id: p.coffeeSource.id,
              code: p.coffeeSource.code,
              name: p.coffeeSource.name,
              country: p.coffeeSource.country,
              region: p.coffeeSource.region,
              farm: p.coffeeSource.farm,
              species: p.coffeeSource.species,
              varietal: p.coffeeSource.varietal,
              processMethod: p.coffeeSource.processMethod,
              fermentationMethod: p.coffeeSource.fermentationMethod,
              elevation: p.coffeeSource.elevation,
              cropYear: p.coffeeSource.cropYear,
              certifications: p.coffeeSource.certifications,
              tastingNotes: p.coffeeSource.tastingNotes,
              isActive: p.coffeeSource.isActive,
            }
          : null,
        description: p.description,
        imageUrl: p.imageUrl,
        isActive: p.isActive,
        price: p.price ? Number(p.price) : 0,
        priceSilver: p.priceSilver ? Number(p.priceSilver) : 0,
        priceGold: p.priceGold ? Number(p.priceGold) : 0,
        netWeightGrams: p.netWeightGrams ? Number(p.netWeightGrams) : null,
        latestHppPerKg,
        lastHpp: p.lastHpp
          ? Number(p.lastHpp)
          : p.productionBatches[0]
            ? Number(p.productionBatches[0].hppPerUnit)
            : undefined,
        createdAt: p.createdAt.toISOString(),
        recipe: r
          ? {
              id: r.id,
              packagingId: r.packagingId,
              outputGrams: Number(r.outputGrams),
              storefrontGrindOptions: r.storefrontGrindOptions,
              notes: r.notes,
              items: r.items.map((i) => ({
                id: i.id,
                rbProductId: i.productId,
                gramsPerUnit: Number(i.gramsPerUnit),
                ratioPercent: Number(i.ratioPercent),
              })),
              supplyItems: r.supplyItems.map((si) => ({
                id: si.id,
                supplyItemId: si.supplyItemId,
                quantityPerUnit: Number(si.quantityPerUnit),
              })),
            }
          : null,
        reorderAlertEnabled: p.reorderAlertEnabled,
        leadTimeDays: p.leadTimeDays,
        safetyStockQuantity: Number(p.safetyStockQuantity),
        reorderLookbackDays: p.reorderLookbackDays,
      };
    }),

    packagings: packagings.map((pkg) => ({
      id: pkg.id, 
      code: pkg.code, 
      name: pkg.name,
      weightGrams: Number(pkg.weightGrams),
      costPerUnit: Number(pkg.costPerUnit),
      isActive: pkg.isActive,
      reorderAlertEnabled: pkg.reorderAlertEnabled,
      leadTimeDays: pkg.leadTimeDays,
      safetyStockQuantity: pkg.safetyStockQuantity,
      reorderLookbackDays: pkg.reorderLookbackDays,
    })),

    supplyItems: supplyItems.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      category: item.category as SupplyItemRow["category"],
      baseUnit: item.baseUnit as SupplyItemRow["baseUnit"],
      trackLot: item.trackLot,
      shelfLifeDays: item.shelfLifeDays,
      consumableInProduction: item.consumableInProduction,
      includeInProductHpp: item.includeInProductHpp,
      capacityGrams: item.capacityGrams ? Number(item.capacityGrams) : null,
      tareWeightGrams: item.tareWeightGrams ? Number(item.tareWeightGrams) : null,
      costPerUnit: Number(item.costPerUnit),
      avgCostPerUnit: Number(item.avgCostPerUnit ?? 0),
      stockQuantity: Number(item.stockQuantity),
      isActive: item.isActive,
      reorderAlertEnabled: item.reorderAlertEnabled,
      leadTimeDays: item.leadTimeDays,
      safetyStockQuantity: Number(item.safetyStockQuantity),
      reorderLookbackDays: item.reorderLookbackDays,
    })),

    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as UserRow["role"],
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    })),

    coffeeSources: coffeeSources.map((source) => ({
      id: source.id,
      code: source.code,
      name: source.name,
      country: source.country,
      region: source.region,
      farm: source.farm,
      species: source.species,
      varietal: source.varietal,
      processMethod: source.processMethod,
      fermentationMethod: source.fermentationMethod,
      elevation: source.elevation,
      cropYear: source.cropYear,
      certifications: source.certifications,
      tastingNotes: source.tastingNotes,
      isActive: source.isActive,
    })),

    offerings: offerings.map((offering) => ({
      id: offering.id,
      code: offering.code,
      name: offering.name,
      description: offering.description,
      imageUrl: offering.imageUrl,
      coffeeSourceId: offering.coffeeSourceId,
      coffeeSource: offering.coffeeSource
        ? {
            id: offering.coffeeSource.id,
            code: offering.coffeeSource.code,
            name: offering.coffeeSource.name,
            country: offering.coffeeSource.country,
            region: offering.coffeeSource.region,
            farm: offering.coffeeSource.farm,
            species: offering.coffeeSource.species,
            varietal: offering.coffeeSource.varietal,
            processMethod: offering.coffeeSource.processMethod,
            fermentationMethod: offering.coffeeSource.fermentationMethod,
            elevation: offering.coffeeSource.elevation,
            cropYear: offering.coffeeSource.cropYear,
            certifications: offering.coffeeSource.certifications,
            tastingNotes: offering.coffeeSource.tastingNotes,
            isActive: offering.coffeeSource.isActive,
          }
        : null,
      sourceMode: offering.sourceMode,
      lineageProductId: offering.lineageProductId,
      roastLevel: offering.roastLevel,
      grindOptions: offering.grindOptions,
      allowCustomGrind: offering.allowCustomGrind,
      isActive: offering.isActive,
      sortOrder: offering.sortOrder,
      variants: offering.variants.map((variant) => ({
        id: variant.id,
        packageName: variant.packageName,
        netWeightGrams: Number(variant.netWeightGrams),
        unitPrice: Number(variant.unitPrice),
        supplyItemId: variant.supplyItemId,
        isActive: variant.isActive,
      })),
    })),
  };
}

export async function getCustomerDirectoryData(): Promise<MasterPageData> {
  await requireRole("OWNER", "MANAGER", "CASHIER");
  const tp = await requireTenantPrisma();
  const customers = await tp.customer.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { invoices: true } } },
  });

  return {
    suppliers: [],
    products: [],
    packagings: [],
    supplyItems: [],
    users: [],
    coffeeSources: [],
    offerings: [],
    customers: customers.map((customer) => ({
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      isActive: customer.isActive,
      tier: customer.tier as CustomerRow["tier"],
      createdAt: customer.createdAt.toISOString(),
      invoiceCount: customer._count.invoices,
    })),
  };
}

// ... (bagian bawah file tetap sama, tidak ada perubahan)

// =============================================================================
// SHARED
// =============================================================================

export type ActionResult<T = never> =
  | { success: true; code: string; data?: T }
  | { success: false; error: string };

export type CreatedCustomer = Pick<CustomerRow, "id" | "code" | "name" | "phone" | "tier">;
export type CreatedSupplier = Pick<SupplierRow, "id" | "code" | "name">;

type TenantPrisma = Awaited<ReturnType<typeof requireTenantPrisma>>;

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function nextSequence(codes: string[], prefix: string): number {
  return codes.reduce((highest, code) => {
    const match = code.match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
}

async function nextSupplierCode(tp: TenantPrisma): Promise<string> {
  const rows = await tp.supplier.findMany({
    where: { code: { startsWith: "SUP-" } },
    select: { code: true },
  });
  return `SUP-${String(nextSequence(rows.map((row) => row.code), "SUP")).padStart(3, "0")}`;
}

async function nextCustomerCode(tp: TenantPrisma): Promise<string> {
  const rows = await tp.customer.findMany({
    where: { code: { startsWith: "CST-" } },
    select: { code: true },
  });
  return `CST-${String(nextSequence(rows.map((row) => row.code), "CST")).padStart(3, "0")}`;
}

async function nextPackagingCode(tp: TenantPrisma): Promise<string> {
  const rows = await tp.packaging.findMany({
    where: { code: { startsWith: "PKG-" } },
    select: { code: true },
  });
  return `PKG-${String(nextSequence(rows.map((row) => row.code), "PKG")).padStart(3, "0")}`;
}

async function findSupplierDuplicate(
  tp: TenantPrisma,
  input: { name: string; phone: string | null; region: string | null },
  excludeId?: string,
) {
  const rows = await tp.supplier.findMany({
    where: excludeId ? { id: { not: excludeId } } : undefined,
    select: { id: true, code: true, name: true, phone: true, region: true, isActive: true },
  });
  const normalizedName = input.name.toLocaleLowerCase("id-ID");
  const normalizedRegion = input.region?.toLocaleLowerCase("id-ID") ?? null;

  return rows.find((row) => {
    if (input.phone && sameNormalizedPhone(input.phone, row.phone)) return true;
    if (input.phone) return false;
    return row.name.toLocaleLowerCase("id-ID") === normalizedName
      && (row.region?.toLocaleLowerCase("id-ID") ?? null) === normalizedRegion;
  });
}

async function findCustomerDuplicate(
  tp: TenantPrisma,
  input: { name: string; phone: string | null; email: string | null },
  excludeId?: string,
) {
  const rows = await tp.customer.findMany({
    where: excludeId ? { id: { not: excludeId } } : undefined,
    select: { id: true, code: true, name: true, phone: true, email: true, isActive: true },
  });
  const normalizedName = input.name.toLocaleLowerCase("id-ID");

  return rows.find((row) => {
    if (input.email && normalizeEmail(row.email) === input.email) return true;
    if (input.phone && sameNormalizedPhone(input.phone, row.phone)) return true;
    if (input.email || input.phone) return false;
    return row.name.toLocaleLowerCase("id-ID") === normalizedName;
  });
}

// =============================================================================
// SUPPLIER — CREATE
// =============================================================================

export type CreateSupplierInput = Omit<SupplierInput, "isActive">;

export async function createSupplier(input: CreateSupplierInput): Promise<ActionResult<CreatedSupplier>> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const parsed = supplierInputSchema.safeParse({ ...input, isActive: true });
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data supplier tidak valid." };

    const data = {
      name: parsed.data.name,
      phone: normalizePhone(parsed.data.phone),
      address: emptyToNull(parsed.data.address),
      region: emptyToNull(parsed.data.region),
    };
    const tp = await requireTenantPrisma();
    const duplicate = await findSupplierDuplicate(tp, data);
    if (duplicate) {
      return {
        success: false,
        error: `${duplicate.code} · ${duplicate.name} sudah terdaftar${duplicate.isActive ? "" : " (nonaktif)"}.`,
      };
    }

    let supplier: Awaited<ReturnType<typeof tp.supplier.create>> | null = null;
    for (let attempt = 0; attempt < 4 && !supplier; attempt += 1) {
      const code = await nextSupplierCode(tp);
      try {
        supplier = await tp.supplier.create({ data: { tenantId, code, ...data } });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }
    if (!supplier) throw new Error("Supplier code allocation failed");

    revalidatePath("/master-data"); revalidatePath("/inventory");
    return {
      success: true,
      code: supplier.code,
      data: { id: supplier.id, code: supplier.code, name: supplier.name },
    };
  } catch (err) {
    console.error("[createSupplier]", err);
    return { success: false, error: "Gagal menyimpan supplier. Coba lagi." };
  }
}

// SUPPLIER — UPDATE

export type UpdateSupplierInput = SupplierInput & { id: string };

export async function updateSupplier(input: UpdateSupplierInput): Promise<ActionResult<CreatedSupplier>> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const parsed = supplierInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data supplier tidak valid." };
    const tp = await requireTenantPrisma();
    const existing = await tp.supplier.findUnique({ where: { id: input.id }, select: { code: true } });
    if (!existing) return { success: false, error: "Supplier tidak ditemukan." };
    const data = {
      name: parsed.data.name,
      phone: normalizePhone(parsed.data.phone),
      address: emptyToNull(parsed.data.address),
      region: emptyToNull(parsed.data.region),
      isActive: parsed.data.isActive,
    };
    const duplicate = await findSupplierDuplicate(tp, data, input.id);
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    const supplier = await tp.supplier.update({
      where: { id: input.id },
      data,
    });
    revalidatePath("/master-data"); revalidatePath("/inventory");
    return {
      success: true,
      code: existing.code,
      data: { id: supplier.id, code: supplier.code, name: supplier.name },
    };
  } catch (err) {
    console.error("[updateSupplier]", err);
    return { success: false, error: "Gagal memperbarui supplier. Coba lagi." };
  }
}

// =============================================================================
// CUSTOMER — CREATE
// =============================================================================

export type CreateCustomerInput = Omit<CustomerInput, "isActive">;

export async function createCustomer(input: CreateCustomerInput): Promise<ActionResult<CreatedCustomer>> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR", "CASHIER");
    const tenantId = await getCurrentTenantId();
    const parsed = customerInputSchema.safeParse({ ...input, isActive: true });
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data pelanggan tidak valid." };
    const data = {
      name: parsed.data.name,
      phone: normalizePhone(parsed.data.phone),
      email: normalizeEmail(parsed.data.email),
      address: emptyToNull(parsed.data.address),
      tier: parsed.data.tier,
    };
    const tp = await requireTenantPrisma();
    const duplicate = await findCustomerDuplicate(tp, data);
    if (duplicate) {
      return {
        success: false,
        error: `${duplicate.code} · ${duplicate.name} sudah terdaftar${duplicate.isActive ? "" : " (nonaktif)"}.`,
      };
    }

    let customer: Awaited<ReturnType<typeof tp.customer.create>> | null = null;
    for (let attempt = 0; attempt < 4 && !customer; attempt += 1) {
      const code = await nextCustomerCode(tp);
      try {
        customer = await tp.customer.create({ data: { tenantId, code, ...data } });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }
    if (!customer) throw new Error("Customer code allocation failed");

    revalidatePath("/master-data"); revalidatePath("/penjualan");
    return {
      success: true,
      code: customer.code,
      data: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.phone,
        tier: customer.tier,
      },
    };
  } catch (err) {
    console.error("[createCustomer]", err);
    return { success: false, error: "Gagal menyimpan pelanggan. Coba lagi." };
  }
}

// CUSTOMER — UPDATE

export type UpdateCustomerInput = CustomerInput & { id: string };

export async function updateCustomer(input: UpdateCustomerInput): Promise<ActionResult<CreatedCustomer>> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR", "CASHIER");
    const parsed = customerInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data pelanggan tidak valid." };
    const tp = await requireTenantPrisma();
    const existing = await tp.customer.findUnique({ where: { id: input.id }, select: { code: true } });
    if (!existing) return { success: false, error: "Pelanggan tidak ditemukan." };
    const data = {
      name: parsed.data.name,
      phone: normalizePhone(parsed.data.phone),
      email: normalizeEmail(parsed.data.email),
      address: emptyToNull(parsed.data.address),
      tier: parsed.data.tier,
      isActive: parsed.data.isActive,
    };
    const duplicate = await findCustomerDuplicate(tp, data, input.id);
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    const customer = await tp.customer.update({
      where: { id: input.id },
      data,
    });
    revalidatePath("/master-data"); revalidatePath("/penjualan");
    return {
      success: true,
      code: existing.code,
      data: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.phone,
        tier: customer.tier,
      },
    };
  } catch (err) {
    console.error("[updateCustomer]", err);
    return { success: false, error: "Gagal memperbarui pelanggan. Coba lagi." };
  }
}

// =============================================================================
// USER
// =============================================================================

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: UserRow["role"];
};

export type UpdateUserInput = {
  id: string;
  name: string;
  email: string;
  role: UserRow["role"];
  isActive: boolean;
  password?: string;
};

const USER_ROLES: UserRow["role"][] = ["OWNER", "MANAGER", "OPERATOR", "CASHIER"];

function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password minimal 8 karakter.";
  if (!/[A-Z]/.test(password)) return "Password harus mengandung huruf kapital.";
  if (!/[0-9]/.test(password)) return "Password harus mengandung angka.";
  return null;
}

export async function createUser(input: CreateUserInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER");
    const tenantId = await getCurrentTenantId();
    const name = input.name?.trim();
    const email = input.email?.toLowerCase().trim();
    const password = input.password?.trim();

    if (!name) return { success: false, error: "Nama pengguna wajib diisi." };
    if (!email) return { success: false, error: "Email wajib diisi." };
    if (!password) return { success: false, error: "Password wajib diisi." };
    const pwdErr = validatePassword(password);
    if (pwdErr) return { success: false, error: pwdErr };
    if (!USER_ROLES.includes(input.role)) return { success: false, error: "Role pengguna tidak valid." };

    const tp = await requireTenantPrisma();
    const existing = await tp.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return { success: false, error: "Email sudah digunakan pengguna lain." };

    const hashedPassword = await bcrypt.hash(password, 10);
    await tp.user.create({
      data: {
        tenantId,
        name,
        email,
        password: hashedPassword,
        role: input.role,
        // Diundang oleh OWNER terverifikasi di dalam sesi: jalur terpercaya.
        emailVerifiedAt: new Date(),
      },
    });

    revalidatePath("/master-data");
    return { success: true, code: email };
  } catch (err) {
    console.error("[createUser]", err);
    return { success: false, error: "Gagal menyimpan pengguna. Coba lagi." };
  }
}

export async function updateUser(input: UpdateUserInput): Promise<ActionResult> {
  try {
    const actor = await requireRole("OWNER");
    const name = input.name?.trim();
    const email = input.email?.toLowerCase().trim();
    const password = input.password?.trim();

    if (!name) return { success: false, error: "Nama pengguna wajib diisi." };
    if (!email) return { success: false, error: "Email wajib diisi." };
    if (!USER_ROLES.includes(input.role)) return { success: false, error: "Role pengguna tidak valid." };

    const tp = await requireTenantPrisma();
    const existing = await tp.user.findUnique({
      where: { id: input.id },
      select: { id: true, role: true, isActive: true },
    });
    if (!existing) return { success: false, error: "Pengguna tidak ditemukan." };

    if (
      actor.id === input.id &&
      (!input.isActive || input.role !== "OWNER")
    ) {
      return {
        success: false,
        error: "Owner tidak dapat menonaktifkan atau menurunkan role akun sendiri.",
      };
    }

    if (
      existing.role === "OWNER" &&
      (input.role !== "OWNER" || !input.isActive)
    ) {
      const otherActiveOwners = await tp.user.count({
        where: {
          id: { not: input.id },
          role: "OWNER",
          isActive: true,
        },
      });
      if (otherActiveOwners === 0) {
        return {
          success: false,
          error: "Tenant harus memiliki minimal satu Owner aktif.",
        };
      }
    }

    if (password) {
      const pwdErr = validatePassword(password);
      if (pwdErr) return { success: false, error: pwdErr };
    }

    const duplicate = await tp.user.findFirst({
      where: { email, NOT: { id: input.id } },
      select: { id: true },
    });
    if (duplicate) return { success: false, error: "Email sudah digunakan pengguna lain." };

    const data: {
      name: string;
      email: string;
      role: UserRow["role"];
      isActive: boolean;
      password?: string;
    } = {
      name,
      email,
      role: input.role,
      isActive: input.isActive,
    };

    if (password) {
      data.password = await bcrypt.hash(password, 10);
    }

    await tp.user.update({
      where: { id: input.id },
      data,
    });

    revalidatePath("/master-data");
    return { success: true, code: email };
  } catch (err) {
    console.error("[updateUser]", err);
    return { success: false, error: "Gagal memperbarui pengguna. Coba lagi." };
  }
}

// =============================================================================
// PRODUCT TYPES
// =============================================================================

export type RecipeItemInput = {
  rbProductId:  string;
  gramsPerUnit: number;
};

export type RecipeInput = {
  packagingId:  string;
  outputGrams:  number;
  notes?:       string;
  items:        RecipeItemInput[];
  supplyItems?: Array<{ supplyItemId: string; quantityPerUnit: number }>;
  storefrontGrindOptions?: ProductRecipe["storefrontGrindOptions"];
};

export type CreateProductInput = {
  name: string;
  type: "GREEN_BEAN" | "ROASTED_BEAN" | "FINISHED_GOODS" | "PACKAGING";
  coffeeSpecies?: string; // "ARABICA", "ROBUSTA", "LIBERICA", "EXCELSA", "HIBRIDA", "LAINNYA"
  category?:    string; // e.g. "Espresso Base", "Specialty"
  origin?:      string;
  roastLevel?:  "LIGHT" | "MEDIUM" | "MEDIUM_DARK" | "DARK" | null;
  materialOrigin?: "INTERNAL_ROAST" | "PURCHASED_ROASTED"; // hanya relevan untuk ROASTED_BEAN
  description?: string;
  imageUrl?:    string;
  price?:       number; // Harga jual retail
  priceSilver?: number; // Harga jual Wholesale Silver
  priceGold?:   number; // Harga jual Wholesale Gold
  netWeightGrams?: number; // Berat bersih pengiriman (fallback jika tidak ada resep)
  recipe?:      RecipeInput;
  coffeeIdentity?: CoffeeIdentityInput; // hanya untuk GREEN_BEAN — disinkronkan ke CoffeeSource
  reorderAlertEnabled?: boolean;
  leadTimeDays?: number;
  safetyStockQuantity?: number;
  reorderLookbackDays?: number;
};

export type UpdateProductInput = Omit<CreateProductInput, "type"> & {
  id:       string;
  isActive: boolean;
  recipe?:  RecipeInput;
};

const TYPE_PREFIX: Record<CreateProductInput["type"], string> = {
  GREEN_BEAN:     "GB",
  ROASTED_BEAN:   "RB",
  FINISHED_GOODS: "FG",
  PACKAGING:      "PK",
};

// =============================================================================
// PRODUCT — CREATE
// =============================================================================

export async function createProduct(input: CreateProductInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    if (!input.name?.trim()) return { success: false, error: "Nama produk wajib diisi." };

    if (input.type === "FINISHED_GOODS" && input.recipe && input.recipe.items.length > 0) {
      const productIds = input.recipe.items.map((i) => i.rbProductId);
      if (new Set(productIds).size !== productIds.length) {
        return { success: false, error: "Bahan baku dalam resep tidak boleh ganda." };
      }
    }

    const prefix = TYPE_PREFIX[input.type];
    const tp = await requireTenantPrisma();

    let attempts = 0;
    let code = "";
    const MAX_ATTEMPTS = 5;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const count = await tp.product.count({ where: { type: input.type } });
      code = `${prefix}-${String(count + attempts).padStart(3, "0")}`;

      try {
        await tp.$transaction(async (tx) => {
          // Identitas akar untuk Green Bean: buat CoffeeSource dulu dengan kode
          // yang sama dengan produk GB (deterministik, 1:1), lalu hubungkan.
          let coffeeSourceId: string | null = null;
          if (input.type === "GREEN_BEAN") {
            const identity = normalizeCoffeeIdentity({
              ...(input.coffeeIdentity ?? {}),
              name: input.name,
              species: input.coffeeSpecies ?? input.coffeeIdentity?.species,
              region: input.origin ?? input.coffeeIdentity?.region,
            });
            const base = coffeeSourceCreateDataFromProduct({
              code, name: input.name,
              coffeeSpecies: identity.species,
              origin: identity.region,
            });
            const source = await tx.coffeeSource.create({
              data: {
                tenantId,
                code: base.code,
                name: identity.name,
                country: identity.country,
                region: identity.region,
                farm: identity.farm,
                species: identity.species,
                varietal: identity.varietal,
                processMethod: identity.processMethod,
                fermentationMethod: identity.fermentationMethod,
                elevation: identity.elevation,
                cropYear: identity.cropYear,
                certifications: identity.certifications,
                tastingNotes: identity.tastingNotes,
                isActive: true,
              },
              select: { id: true },
            });
            coffeeSourceId = source.id;
          }

          const product = await tx.product.create({
            data: {
              tenantId,
              code, name: input.name.trim(), type: input.type,
              coffeeSpecies: input.coffeeSpecies?.trim() || null,
              category:    input.category?.trim()    || null,
              origin:      input.origin?.trim()      || null,
              roastLevel:  input.type === "ROASTED_BEAN" || input.type === "FINISHED_GOODS" ? (input.roastLevel ?? null) : null,
              materialOrigin: input.type === "ROASTED_BEAN" ? (input.materialOrigin ?? "INTERNAL_ROAST") : null,
              coffeeSourceId,
              description: input.description?.trim() || null,
              imageUrl:    input.imageUrl?.trim() || null,
              price:       input.type === "FINISHED_GOODS" ? (input.price ?? 0) : null,
              priceSilver: input.type === "FINISHED_GOODS" ? (input.priceSilver ?? 0) : null,
              priceGold:   input.type === "FINISHED_GOODS" ? (input.priceGold ?? 0) : null,
              netWeightGrams: input.type === "FINISHED_GOODS" ? (input.recipe?.outputGrams || input.netWeightGrams || null) : null,
              reorderAlertEnabled:  input.reorderAlertEnabled ?? false,
              leadTimeDays:         input.leadTimeDays ?? 7,
              safetyStockQuantity:  input.safetyStockQuantity ?? 0,
              reorderLookbackDays:  input.reorderLookbackDays ?? 30,
            },
          });

            if (input.type === "FINISHED_GOODS" && input.recipe && input.recipe.items.length > 0) {
              const r = input.recipe;
              const rCount  = await tx.recipe.count();
              const rCode   = `RCP-${String(rCount + attempts).padStart(3, "0")}`;
              const outputG = r.outputGrams;

              const recipe = await tx.recipe.create({
                data: {
                  tenantId,
                  code:        rCode,
                  name:        input.name.trim(),
                  productId:   product.id,
                  packagingId: r.packagingId,
                  outputGrams: outputG,
                  storefrontGrindOptions: r.storefrontGrindOptions ?? ["WHOLE_BEAN"],
                  notes:       r.notes?.trim() || null,
                },
              });
              if (r.items.length > 0) {
                await tx.recipeItem.createMany({
                  data: r.items.map((item) => ({
                    tenantId,
                    recipeId:     recipe.id,
                    productId:    item.rbProductId,
                    gramsPerUnit: item.gramsPerUnit,
                    ratioPercent: outputG > 0 ? (item.gramsPerUnit / outputG) * 100 : 0,
                  })),
                });
              }
              if (r.supplyItems && r.supplyItems.length > 0) {
                await tx.recipeSupplyItem.createMany({
                  data: r.supplyItems.map((item) => ({
                    tenantId,
                    recipeId:     recipe.id,
                    supplyItemId: item.supplyItemId,
                    quantityPerUnit: item.quantityPerUnit,
                  })),
                });
              }
            }
        });
        break;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002" &&
          attempts < MAX_ATTEMPTS
        ) {
          continue;
        }
        throw err;
      }
    }

    revalidatePath("/master-data"); revalidatePath("/inventory");
    revalidatePath("/roasting");    revalidatePath("/produksi");
    return { success: true, code };
  } catch (err) {
    console.error("[createProduct]", err);
    return { success: false, error: "Gagal menyimpan produk. Coba lagi." };
  }
}

// =============================================================================
// PRODUCT — UPDATE
// =============================================================================

export async function updateProduct(input: UpdateProductInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    if (!input.name?.trim()) return { success: false, error: "Nama produk wajib diisi." };

    const tp = await requireTenantPrisma();
    const existing = await tp.product.findUnique({
      where: { id: input.id },
      select: { code: true, type: true, recipes: { where: { isActive: true }, select: { id: true }, take: 1 } },
    });
    if (!existing) return { success: false, error: "Produk tidak ditemukan." };

    if (existing.type === "FINISHED_GOODS" && input.recipe) {
      const productIds = input.recipe.items.map((i) => i.rbProductId);
      if (new Set(productIds).size !== productIds.length) {
        return { success: false, error: "Bahan baku dalam resep tidak boleh ganda." };
      }
    }

    await tp.$transaction(async (tx) => {
      // Sinkronkan identitas kopi (CoffeeSource) untuk Green Bean:
      //   • sudah punya sumber → update field identity + species/region produk.
      //   • belum punya (legacy) → buat deterministik dengan kode = kode produk.
      if (existing.type === "GREEN_BEAN") {
        const product = await tx.product.findUnique({
          where: { id: input.id },
          select: {
            coffeeSourceId: true,
            name: true,
            coffeeSpecies: true,
            origin: true,
            type: true,
          },
        });
        if (product) {
          const identity = normalizeCoffeeIdentity({
            ...(input.coffeeIdentity ?? {}),
            name: input.name ?? product.name,
            species: input.coffeeSpecies ?? input.coffeeIdentity?.species ?? product.coffeeSpecies,
            region: input.origin ?? input.coffeeIdentity?.region ?? product.origin,
          });
          const sourceData = {
            tenantId,
            code: existing.code,
            name: identity.name,
            country: identity.country,
            region: identity.region,
            farm: identity.farm,
            species: identity.species,
            varietal: identity.varietal,
            processMethod: identity.processMethod,
            fermentationMethod: identity.fermentationMethod,
            elevation: identity.elevation,
            cropYear: identity.cropYear,
            certifications: identity.certifications,
            tastingNotes: identity.tastingNotes,
            isActive: true,
          };
          if (product.coffeeSourceId) {
            await tx.coffeeSource.update({
              where: { id: product.coffeeSourceId },
              data: sourceData,
            });
          } else {
            const source = await tx.coffeeSource.create({
              data: sourceData,
              select: { id: true },
            });
            await tx.product.update({
              where: { id: input.id },
              data: { coffeeSourceId: source.id },
            });
          }
        }
      }

      // ✅ DITAMBAHKAN: Data price dikirim untuk update
      await tx.product.update({
        where: { id: input.id },
        data: {
          name:        input.name!.trim(),
          coffeeSpecies: input.coffeeSpecies?.trim() || undefined,
          category:    input.category?.trim()    || null,
          origin:      input.origin?.trim()      || null,
          roastLevel:  existing.type === "ROASTED_BEAN" || existing.type === "FINISHED_GOODS" ? (input.roastLevel ?? null) : null,
          materialOrigin: existing.type === "ROASTED_BEAN" ? (input.materialOrigin ?? undefined) : null,
          description: input.description?.trim() || null,
          imageUrl:    input.imageUrl?.trim() || null,
          isActive:    input.isActive,
          price:       existing.type === "FINISHED_GOODS" && input.price !== undefined ? input.price : undefined,
          priceSilver: existing.type === "FINISHED_GOODS" && input.priceSilver !== undefined ? input.priceSilver : undefined,
          priceGold:   existing.type === "FINISHED_GOODS" && input.priceGold !== undefined ? input.priceGold : undefined,
          netWeightGrams: existing.type === "FINISHED_GOODS" ? (input.recipe?.outputGrams || input.netWeightGrams || undefined) : undefined,
          reorderAlertEnabled:  input.reorderAlertEnabled ?? false,
          leadTimeDays:         input.leadTimeDays ?? 7,
          safetyStockQuantity:  input.safetyStockQuantity ?? 0,
          reorderLookbackDays:  input.reorderLookbackDays ?? 30,
        },
      });

        if (existing.type === "FINISHED_GOODS" && input.recipe) {
          const r       = input.recipe;
          const outputG = r.outputGrams;
          const existingRecipe = existing.recipes[0];

          if (existingRecipe) {
            // Update existing recipe: delete old items, insert new ones
            await tx.recipeItem.deleteMany({ where: { recipeId: existingRecipe.id } });
            await tx.recipeSupplyItem.deleteMany({ where: { recipeId: existingRecipe.id } });

            if (r.items.length === 0 && (!r.supplyItems || r.supplyItems.length === 0)) {
              // If items is empty, we effectively delete the recipe since it's now inactive or empty
              await tx.recipe.delete({ where: { id: existingRecipe.id } });
            } else {
              await tx.recipe.update({
                where: { id: existingRecipe.id },
                data: {
                  packagingId: r.packagingId,
                  outputGrams: outputG,
                  storefrontGrindOptions: r.storefrontGrindOptions ?? ["WHOLE_BEAN"],
                  notes:       r.notes?.trim() || null,
                },
              });
              if (r.items.length > 0) {
                await tx.recipeItem.createMany({
                  data: r.items.map((item) => ({
                    tenantId,
                    recipeId:     existingRecipe.id,
                    productId:    item.rbProductId,
                    gramsPerUnit: item.gramsPerUnit,
                    ratioPercent: outputG > 0 ? (item.gramsPerUnit / outputG) * 100 : 0,
                  })),
                });
              }
              if (r.supplyItems && r.supplyItems.length > 0) {
                await tx.recipeSupplyItem.createMany({
                  data: r.supplyItems.map((item) => ({
                    tenantId,
                    recipeId:     existingRecipe.id,
                    supplyItemId: item.supplyItemId,
                    quantityPerUnit: item.quantityPerUnit,
                  })),
                });
              }
            }
          } else {
            // Create brand-new recipe for this product
            if (r.items.length > 0 || (r.supplyItems && r.supplyItems.length > 0)) {
              const rCount = await tx.recipe.count();
              const rCode  = `RCP-${String(rCount + 1).padStart(3, "0")}`;
              const recipe = await tx.recipe.create({
                data: {
                  tenantId,
                  code:        rCode,
                  name:        input.name!.trim(),
                  productId:   input.id,
                  packagingId: r.packagingId,
                  outputGrams: outputG,
                  storefrontGrindOptions: r.storefrontGrindOptions ?? ["WHOLE_BEAN"],
                  notes:       r.notes?.trim() || null,
                },
              });
              if (r.items.length > 0) {
                await tx.recipeItem.createMany({
                  data: r.items.map((item) => ({
                    tenantId,
                    recipeId:     recipe.id,
                    productId:    item.rbProductId,
                    gramsPerUnit: item.gramsPerUnit,
                    ratioPercent: outputG > 0 ? (item.gramsPerUnit / outputG) * 100 : 0,
                  })),
                });
              }
              if (r.supplyItems && r.supplyItems.length > 0) {
                await tx.recipeSupplyItem.createMany({
                  data: r.supplyItems.map((item) => ({
                    tenantId,
                    recipeId:     recipe.id,
                    supplyItemId: item.supplyItemId,
                    quantityPerUnit: item.quantityPerUnit,
                  })),
                });
              }
            }
          }
        }
    });

    revalidatePath("/master-data"); revalidatePath("/inventory");
    revalidatePath("/roasting");    revalidatePath("/produksi");
    return { success: true, code: existing.code };
  } catch (err) {
    console.error("[updateProduct]", err);
    return { success: false, error: "Gagal memperbarui produk. Coba lagi." };
  }
}

// =============================================================================
// PACKAGING — CREATE & UPDATE
// =============================================================================

const packagingSchema = z.object({
  name: z.string().trim().min(2, "Nama kemasan minimal 2 karakter").max(120),
  weightGrams: z.number().finite().min(0, "Berat tidak boleh negatif").max(100_000),
  costPerUnit: z.number().finite().min(0, "Harga tidak boleh negatif").max(1_000_000_000),
  isActive: z.boolean(),
});
type CreatePackagingInput = z.infer<typeof packagingSchema>;
type UpdatePackagingInput = CreatePackagingInput & { id: string };

export async function createPackaging(input: CreatePackagingInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const parsed = packagingSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data kemasan tidak valid." };
    const tp = await requireTenantPrisma();
    const duplicate = await tp.packaging.findFirst({
      where: { name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { code: true, name: true },
    });
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    let packaging: Awaited<ReturnType<typeof tp.packaging.create>> | null = null;
    for (let attempt = 0; attempt < 4 && !packaging; attempt += 1) {
      const code = await nextPackagingCode(tp);
      try {
        packaging = await tp.packaging.create({ data: { tenantId, code, ...parsed.data } });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }
    if (!packaging) throw new Error("Packaging code allocation failed");

    revalidatePath("/master-data");
    revalidatePath("/inventory");
    return { success: true, code: packaging.code };
  } catch (err) {
    console.error("[createPackaging]", err);
    return { success: false, error: "Gagal menyimpan kemasan." };
  }
}

export async function updatePackaging(input: UpdatePackagingInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const { id, ...data } = input;
    const parsed = packagingSchema.safeParse(data);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data kemasan tidak valid." };
    const tp = await requireTenantPrisma();
    const existing = await tp.packaging.findUnique({ where: { id }, select: { code: true } });
    if (!existing) return { success: false, error: "Kemasan tidak ditemukan." };
    const duplicate = await tp.packaging.findFirst({
      where: { id: { not: id }, name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { code: true, name: true },
    });
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    await tp.packaging.update({
      where: { id },
      data: {
        name: parsed.data.name,
        weightGrams: parsed.data.weightGrams,
        costPerUnit: parsed.data.costPerUnit,
        isActive: parsed.data.isActive,
      }
    });

    revalidatePath("/master-data");
    revalidatePath("/inventory");
    return { success: true, code: existing.code };
  } catch (err) {
    console.error("[updatePackaging]", err);
    return { success: false, error: "Gagal memperbarui kemasan." };
  }
}

// =============================================================================
// SUPPLY ITEM — CREATE & UPDATE
// Persediaan non-kopi (kemasan, bahan baku, consumable, merchandise, spare
// part, equipment). Stok dihitung dari InventoryLedger, bukan di kolom ini.
// =============================================================================

const supplyItemSchema = z.object({
  name: z.string().trim().min(2, "Nama minimal 2 karakter").max(120),
  category: z.enum([
    "PACKAGING",
    "INGREDIENT",
    "CONSUMABLE",
    "MERCHANDISE",
    "SPARE_PART",
    "EQUIPMENT",
    "OTHER",
  ]),
  baseUnit: z.enum([
    "KG",
    "GRAM",
    "LITER",
    "METER",
    "ROLL",
    "PCS",
    "BOX",
    "SET",
    "OTHER",
  ]),
  trackLot: z.boolean(),
  shelfLifeDays: z.number().int().min(1, "Umur simpan minimal 1 hari").max(36_500).nullable(),
  consumableInProduction: z.boolean(),
  includeInProductHpp: z.boolean(),
  capacityGrams: z.number().finite().min(0, "Kapasitas tidak boleh negatif").max(1_000_000).nullable(),
  tareWeightGrams: z.number().finite().min(0, "Berat tidak boleh negatif").max(1_000_000).nullable(),
  costPerUnit: z.number().finite().min(0, "Harga tidak boleh negatif").max(1_000_000_000),
  isActive: z.boolean(),
  reorderAlertEnabled: z.boolean(),
  leadTimeDays: z.number().int().min(1, "Lead time minimal 1 hari").max(365),
  safetyStockQuantity: z.number().finite().min(0, "Safety stock tidak boleh negatif").max(1_000_000),
  reorderLookbackDays: z.number().int().min(7, "Periode analisis minimal 7 hari").max(365),
});
type CreateSupplyItemInput = z.infer<typeof supplyItemSchema>;
type UpdateSupplyItemInput = CreateSupplyItemInput & { id: string };

async function nextSupplyItemCode(tp: TenantPrisma): Promise<string> {
  const rows = await tp.inventorySupplyItem.findMany({
    where: { code: { startsWith: "SUP-" } },
    select: { code: true },
  });
  return `SUP-${String(nextSequence(rows.map((row) => row.code), "SUP")).padStart(3, "0")}`;
}

// Legacy Packaging is a compatibility adapter: recipe/product/production lama
// masih memakai packagingId. Ketika supply item PACKAGING dibuat/diperbarui,
// linked Packaging row ikut dibuat/diperbarui dalam transaksi yang sama.
// Stok TIDAK pernah ditulis di kedua model — hanya via InventoryLedger.
function packagingWeightFrom(supply: { tareWeightGrams: number | null; capacityGrams: number | null }): number {
  return supply.tareWeightGrams ?? supply.capacityGrams ?? 0;
}

export async function createSupplyItem(input: CreateSupplyItemInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const parsed = supplyItemSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data persediaan tidak valid." };
    const tp = await requireTenantPrisma();
    const duplicate = await tp.inventorySupplyItem.findFirst({
      where: { name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { code: true, name: true },
    });
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    let supplyItem: Awaited<ReturnType<typeof tp.inventorySupplyItem.create>> | null = null;
    for (let attempt = 0; attempt < 4 && !supplyItem; attempt += 1) {
      const code = await nextSupplyItemCode(tp);
      const packagingCode = parsed.data.category === "PACKAGING" ? await nextPackagingCode(tp) : null;
      try {
        supplyItem = await tp.$transaction(async (tx) => {
          const created = await tx.inventorySupplyItem.create({ data: { tenantId, code, ...parsed.data } });
          if (parsed.data.category === "PACKAGING" && packagingCode) {
            await tx.packaging.create({
              data: {
                tenantId,
                code: packagingCode,
                name: parsed.data.name,
                weightGrams: packagingWeightFrom(parsed.data),
                costPerUnit: parsed.data.costPerUnit,
                isActive: parsed.data.isActive,
                supplyItemId: created.id,
              },
            });
          }
          return created;
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }
    if (!supplyItem) throw new Error("Supply item code allocation failed");

    revalidatePath("/master-data");
    revalidatePath("/katalog");
    revalidatePath("/inventory");
    return { success: true, code: supplyItem.code };
  } catch (err) {
    console.error("[createSupplyItem]", err);
    return { success: false, error: "Gagal menyimpan persediaan non-kopi." };
  }
}

export async function updateSupplyItem(input: UpdateSupplyItemInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const { id, ...data } = input;
    const parsed = supplyItemSchema.safeParse(data);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data persediaan tidak valid." };
    const tp = await requireTenantPrisma();
    const existing = await tp.inventorySupplyItem.findUnique({
      where: { id },
      select: { code: true, tenantId: true, packaging: { select: { id: true } } },
    });
    if (!existing) return { success: false, error: "Persediaan tidak ditemukan." };
    const duplicate = await tp.inventorySupplyItem.findFirst({
      where: { id: { not: id }, name: { equals: parsed.data.name, mode: "insensitive" } },
      select: { code: true, name: true },
    });
    if (duplicate) return { success: false, error: `${duplicate.code} · ${duplicate.name} sudah terdaftar.` };

    const linkPackaging = parsed.data.category === "PACKAGING";
    if (linkPackaging && !existing.packaging) {
      // Item berubah menjadi PACKAGING: buat adapter Packaging (code retry aman
      // karena create gagal akan me-rollback seluruh transaksi).
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const packagingCode = await nextPackagingCode(tp);
        try {
          await tp.$transaction(async (tx) => {
            await tx.inventorySupplyItem.update({ where: { id }, data: parsed.data });
            await tx.packaging.create({
              data: {
                tenantId: existing.tenantId,
                code: packagingCode,
                name: parsed.data.name,
                weightGrams: packagingWeightFrom(parsed.data),
                costPerUnit: parsed.data.costPerUnit,
                isActive: parsed.data.isActive,
                supplyItemId: id,
              },
            });
          });
          break;
        } catch (error) {
          if (!isUniqueConstraintError(error) || attempt === 3) throw error;
        }
      }
    } else {
      await tp.$transaction(async (tx) => {
        await tx.inventorySupplyItem.update({ where: { id }, data: parsed.data });
        if (linkPackaging && existing.packaging) {
          await tx.packaging.update({
            where: { id: existing.packaging.id },
            data: {
              name: parsed.data.name,
              weightGrams: packagingWeightFrom(parsed.data),
              costPerUnit: parsed.data.costPerUnit,
              isActive: parsed.data.isActive,
            },
          });
        }
      });
    }

    revalidatePath("/master-data");
    revalidatePath("/katalog");
    revalidatePath("/inventory");
    return { success: true, code: existing.code };
  } catch (err) {
    console.error("[updateSupplyItem]", err);
    return { success: false, error: "Gagal memperbarui persediaan non-kopi." };
  }
}

// =============================================================================
// COFFEE OFFERING — CREATE & UPDATE
// Penawaran kopi: varian kemasan yang dijual di storefront. Identitas akar
// adalah CoffeeSource; stok ditahan dalam kg pada produk roasted bean terkait
// saat checkout. Tidak menyentuh ledger/stok/akuntansi di sini.
// =============================================================================

const OFFERING_GRIND_OPTIONS = [
  "WHOLE_BEAN",
  "COARSE",
  "MEDIUM_COARSE",
  "MEDIUM",
  "MEDIUM_FINE",
  "FINE",
  "ESPRESSO",
  "CUSTOM",
] as const;

const offeringSchema = z.object({
  name: z.string().trim().min(2, "Nama penawaran minimal 2 karakter").max(120),
  description: z.string().trim().max(500).nullable().optional(),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  roastLevel: z.enum(["LIGHT", "MEDIUM", "MEDIUM_DARK", "DARK"]).nullable().optional(),
  sourceMode: z.enum(["PURCHASED_ROASTED", "INTERNAL_ROAST"]),
  coffeeSourceId: z.string().min(1, "Pilih sumber kopi"),
  lineageProductId: z.string().min(1, "Pilih material kopi siap jual"),
  grindOptions: z.array(z.enum(OFFERING_GRIND_OPTIONS)).min(1).default(["WHOLE_BEAN"]),
  allowCustomGrind: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  variants: z.array(z.object({
    packageName: z.string().trim().min(1, "Nama kemasan wajib diisi").max(80),
    netWeightGrams: z.number().finite().min(1, "Berat bersih minimal 1 gram").max(1_000_000),
    unitPrice: z.number().finite().min(0, "Harga tidak boleh negatif").max(1_000_000_000),
    supplyItemId: z.string().nullable().optional(),
    isActive: z.boolean().default(true),
  })).min(1, "Minimal satu varian kemasan").max(20),
});

export type OfferingInput = z.infer<typeof offeringSchema>;

type OfferingMaterial = {
  id: string;
  type: string;
  isActive: boolean;
  coffeeSourceId: string | null;
  materialOrigin: string | null;
  roastLevel: string | null;
  sourceGreenBean: {
    tenantId: string;
    type: string;
    coffeeSourceId: string | null;
  } | null;
};

function validateOfferingMaterial(
  material: OfferingMaterial | null,
  input: OfferingInput,
  tenantId: string,
) {
  if (!material || material.type !== "ROASTED_BEAN" || !material.isActive || !material.coffeeSourceId) {
    return "Material kopi siap jual tidak valid atau sedang nonaktif.";
  }
  const expectedMode = material.materialOrigin === "INTERNAL_ROAST"
    ? "INTERNAL_ROAST"
    : material.materialOrigin === "PURCHASED_ROASTED"
      ? "PURCHASED_ROASTED"
      : null;
  if (
    !expectedMode
    || input.sourceMode !== expectedMode
    || input.coffeeSourceId !== material.coffeeSourceId
    || (input.roastLevel ?? null) !== (material.roastLevel ?? null)
  ) {
    return "Identitas, asal bahan, atau roast tidak cocok dengan material yang dipilih.";
  }
  if (
    expectedMode === "INTERNAL_ROAST"
    && (
      !material.sourceGreenBean
      || material.sourceGreenBean.tenantId !== tenantId
      || material.sourceGreenBean.type !== "GREEN_BEAN"
      || material.sourceGreenBean.coffeeSourceId !== material.coffeeSourceId
    )
  ) {
    return "Material sangrai internal belum memiliki lineage green bean yang terbukti.";
  }
  return null;
}

export async function createOffering(input: OfferingInput): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const parsed = offeringSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data penawaran tidak valid." };

    const tp = await requireTenantPrisma();
    const material = await tp.product.findUnique({
      where: { id: parsed.data.lineageProductId },
      select: {
        id: true,
        type: true,
        isActive: true,
        coffeeSourceId: true,
        materialOrigin: true,
        roastLevel: true,
        sourceGreenBean: { select: { tenantId: true, type: true, coffeeSourceId: true } },
      },
    });
    const materialError = validateOfferingMaterial(material, parsed.data, tenantId);
    if (materialError) return { success: false, error: materialError };
    let offering: Awaited<ReturnType<typeof tp.coffeeOffering.create>> | null = null;
    for (let attempt = 0; attempt < 4 && !offering; attempt += 1) {
      const rows = await tp.coffeeOffering.findMany({
        where: { code: { startsWith: "OFR-" } },
        select: { code: true },
      });
      const code = `OFR-${String(nextSequence(rows.map((row) => row.code), "OFR")).padStart(3, "0")}`;
      try {
        offering = await tp.coffeeOffering.create({
          data: {
            tenantId,
            code,
            name: parsed.data.name,
            description: emptyToNull(parsed.data.description),
            imageUrl: emptyToNull(parsed.data.imageUrl),
            roastLevel: parsed.data.roastLevel ?? null,
            sourceMode: parsed.data.sourceMode,
            coffeeSourceId: parsed.data.coffeeSourceId,
            lineageProductId: parsed.data.lineageProductId,
            grindOptions: parsed.data.grindOptions,
            allowCustomGrind: parsed.data.allowCustomGrind,
            isActive: parsed.data.isActive,
            sortOrder: parsed.data.sortOrder,
            variants: {
              create: parsed.data.variants.map((variant) => ({
                tenantId,
                packageName: variant.packageName,
                netWeightGrams: variant.netWeightGrams,
                unitPrice: variant.unitPrice,
                supplyItemId: variant.supplyItemId || null,
                isActive: variant.isActive,
              })),
            },
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }
    if (!offering) throw new Error("Offering code allocation failed");

    revalidatePath("/master-data");
    revalidatePath("/katalog");
    return { success: true, code: offering.code };
  } catch (err) {
    console.error("[createOffering]", err);
    return { success: false, error: "Gagal menyimpan penawaran. Coba lagi." };
  }
}

export async function updateOffering(input: OfferingInput & { id: string }): Promise<ActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "OPERATOR");
    const tenantId = await getCurrentTenantId();
    const parsed = offeringSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Data penawaran tidak valid." };

    const tp = await requireTenantPrisma();
    const material = await tp.product.findUnique({
      where: { id: parsed.data.lineageProductId },
      select: {
        id: true,
        type: true,
        isActive: true,
        coffeeSourceId: true,
        materialOrigin: true,
        roastLevel: true,
        sourceGreenBean: { select: { tenantId: true, type: true, coffeeSourceId: true } },
      },
    });
    const materialError = validateOfferingMaterial(material, parsed.data, tenantId);
    if (materialError) return { success: false, error: materialError };
    const existing = await tp.coffeeOffering.findUnique({
      where: { id: input.id },
      select: { code: true },
    });
    if (!existing) return { success: false, error: "Penawaran tidak ditemukan." };

    await tp.$transaction(async (tx) => {
      await tx.coffeeOffering.update({
        where: { id: input.id },
        data: {
          name: parsed.data.name,
          description: emptyToNull(parsed.data.description),
          imageUrl: emptyToNull(parsed.data.imageUrl),
          roastLevel: parsed.data.roastLevel ?? null,
          sourceMode: parsed.data.sourceMode,
          coffeeSourceId: parsed.data.coffeeSourceId,
          lineageProductId: parsed.data.lineageProductId,
          grindOptions: parsed.data.grindOptions,
          allowCustomGrind: parsed.data.allowCustomGrind,
          isActive: parsed.data.isActive,
          sortOrder: parsed.data.sortOrder,
        },
      });

      // Replace strategy: hapus varian lama, tulis ulang dari form.
      await tx.offeringVariant.deleteMany({ where: { offeringId: input.id } });
      if (parsed.data.variants.length > 0) {
        await tx.offeringVariant.createMany({
          data: parsed.data.variants.map((variant) => ({
            tenantId,
            offeringId: input.id,
            packageName: variant.packageName,
            netWeightGrams: variant.netWeightGrams,
            unitPrice: variant.unitPrice,
            supplyItemId: variant.supplyItemId || null,
            isActive: variant.isActive,
          })),
        });
      }
    });

    revalidatePath("/master-data");
    revalidatePath("/katalog");
    return { success: true, code: existing.code };
  } catch (err) {
    console.error("[updateOffering]", err);
    return { success: false, error: "Gagal memperbarui penawaran. Coba lagi." };
  }
}
