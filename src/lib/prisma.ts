import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Stores the active tenant-scoped client so assertion queries inside
// $transaction use the same connection and can see uncommitted writes.
const assertionClientStore = new AsyncLocalStorage<PrismaClient | Prisma.TransactionClient>();

function getAssertionClient() {
  return assertionClientStore.getStore() ?? prisma;
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL || "";
  const configuredPoolMax = Number.parseInt(process.env.DATABASE_POOL_MAX || "", 10);
  // A serverless deployment can create many application instances. Keep each
  // instance's local pool deliberately small and let the transaction pooler
  // multiplex them onto the finite Postgres connection budget.
  const defaultPoolMax = process.env.VERCEL ? 5 : 10;
  const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
    ? configuredPoolMax
    : defaultPoolMax;
  const pool = new Pool({
    connectionString,
    // Keep this configurable: serverless instances each own a pool, while the
    // dashboard intentionally runs several independent queries in parallel.
    max: poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  prisma_v3: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma_v3 ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma_v3 = prisma;

const tenantScopedModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "tenantId"))
    .map((model) => model.name),
);

type OwnedRelation = {
  foreignKey: string;
  relation: string;
  delegate: string;
};

const ownedRelations: Record<string, OwnedRelation[]> = {
  Product: [
    { foreignKey: "sourceGreenBeanId", relation: "sourceGreenBean", delegate: "product" },
    { foreignKey: "coffeeSourceId", relation: "coffeeSource", delegate: "coffeeSource" },
  ],
  Recipe: [
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
  ],
  RecipeItem: [
    { foreignKey: "recipeId", relation: "recipe", delegate: "recipe" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
  ],
  Purchase: [
    { foreignKey: "supplierId", relation: "supplier", delegate: "supplier" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
    { foreignKey: "purchaseOrderId", relation: "purchaseOrder", delegate: "purchaseOrder" },
  ],
  ParentRoastingBatch: [
    { foreignKey: "inputProductId", relation: "inputProduct", delegate: "product" },
    { foreignKey: "outputProductId", relation: "outputProduct", delegate: "product" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
    { foreignKey: "machineId", relation: "machine", delegate: "machine" },
  ],
  ProductionBatch: [
    { foreignKey: "recipeId", relation: "recipe", delegate: "recipe" },
    { foreignKey: "outputProductId", relation: "outputProduct", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  Invoice: [
    { foreignKey: "customerId", relation: "customer", delegate: "customer" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  InvoiceItem: [
    { foreignKey: "invoiceId", relation: "invoice", delegate: "invoice" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "contractPriceId", relation: "contractPrice", delegate: "contractPrice" },
    { foreignKey: "offeringId", relation: "offering", delegate: "coffeeOffering" },
  ],
  Payment: [
    { foreignKey: "invoiceId", relation: "invoice", delegate: "invoice" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  PaymentSubmission: [
    { foreignKey: "invoiceId", relation: "invoice", delegate: "invoice" },
    { foreignKey: "paymentMethodId", relation: "paymentMethod", delegate: "tenantPaymentMethod" },
    { foreignKey: "paymentId", relation: "payment", delegate: "payment" },
    { foreignKey: "reviewedById", relation: "reviewedBy", delegate: "user" },
    { foreignKey: "suspectedDuplicateOfId", relation: "suspectedDuplicateOf", delegate: "paymentSubmission" },
  ],
  PaymentNotificationDelivery: [
    { foreignKey: "paymentSubmissionId", relation: "submission", delegate: "paymentSubmission" },
  ],
  SupplierPayment: [
    { foreignKey: "purchaseId", relation: "purchase", delegate: "purchase" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  InventoryLedger: [
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
    { foreignKey: "lotId", relation: "lot", delegate: "lot" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  CreditNote: [
    { foreignKey: "invoiceId", relation: "invoice", delegate: "invoice" },
  ],
  CreditNoteItem: [
    { foreignKey: "creditNoteId", relation: "creditNote", delegate: "creditNote" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
  ],
  SampleUsage: [
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  SampleUsageComponent: [
    { foreignKey: "sampleUsageId", relation: "sampleUsage", delegate: "sampleUsage" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
  ],
  Expense: [
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  Contract: [
    { foreignKey: "customerId", relation: "customer", delegate: "customer" },
  ],
  ContractPrice: [
    { foreignKey: "contractId", relation: "contract", delegate: "contract" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
  ],
  Lot: [
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
    { foreignKey: "supplierId", relation: "supplier", delegate: "supplier" },
    { foreignKey: "purchaseId", relation: "purchase", delegate: "purchase" },
  ],
  CuppingSession: [
    { foreignKey: "batchId", relation: "batch", delegate: "parentRoastingBatch" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
  ],
  JournalEntry: [
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  CapitalTransaction: [
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  AuditLog: [
    { foreignKey: "userId", relation: "user", delegate: "user" },
  ],
  ReminderDelivery: [
    { foreignKey: "invoiceId", relation: "invoice", delegate: "invoice" },
  ],
  PurchaseOrder: [
    { foreignKey: "supplierId", relation: "supplier", delegate: "supplier" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
  PurchaseOrderItem: [
    { foreignKey: "purchaseOrderId", relation: "purchaseOrder", delegate: "purchaseOrder" },
    { foreignKey: "productId", relation: "product", delegate: "product" },
    { foreignKey: "packagingId", relation: "packaging", delegate: "packaging" },
  ],
  ChildRoastingBatch: [
    { foreignKey: "parentId", relation: "parent", delegate: "parentRoastingBatch" },
  ],
  Location: [
    { foreignKey: "warehouseId", relation: "warehouse", delegate: "warehouse" },
  ],
  LocationTransfer: [
    { foreignKey: "lotId", relation: "lot", delegate: "lot" },
    { foreignKey: "sourceLocationId", relation: "sourceLocation", delegate: "location" },
    { foreignKey: "destinationLocationId", relation: "destinationLocation", delegate: "location" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
  ],
   LotPlacement: [
    { foreignKey: "lotId", relation: "lot", delegate: "lot" },
    { foreignKey: "locationId", relation: "location", delegate: "location" },
  ],
  LocationOpname: [
    { foreignKey: "lotId", relation: "lot", delegate: "lot" },
    { foreignKey: "locationId", relation: "location", delegate: "location" },
    { foreignKey: "createdById", relation: "createdBy", delegate: "user" },
    { foreignKey: "confirmedById", relation: "confirmedBy", delegate: "user" },
  ],
  CoffeeOffering: [
    { foreignKey: "coffeeSourceId", relation: "coffeeSource", delegate: "coffeeSource" },
    { foreignKey: "lineageProductId", relation: "lineageProduct", delegate: "product" },
  ],
  OfferingVariant: [
    { foreignKey: "offeringId", relation: "offering", delegate: "coffeeOffering" },
    { foreignKey: "supplyItemId", relation: "supplyItem", delegate: "inventorySupplyItem" },
  ],
  Warehouse: [],
};

const nestedOwnedRelations: Record<
  string,
  Array<{ path: string; relation: OwnedRelation }>
> = {
  Invoice: [
    {
      path: "items.create",
      relation: { foreignKey: "productId", relation: "product", delegate: "product" },
    },
  ],
  Recipe: [
    {
      path: "items.create",
      relation: { foreignKey: "productId", relation: "product", delegate: "product" },
    },
  ],
};

function getRelatedParentId(data: Record<string, any>, relation: string, foreignKey: string) {
  return data[foreignKey] ?? data[relation]?.connect?.id;
}

function getPath(value: Record<string, any>, path: string) {
  return path.split(".").reduce<any>((current, key) => current?.[key], value);
}

async function assertOwnedRelationsBelongToTenant(
  model: string,
  data: Record<string, any> | Record<string, any>[],
  tenantId: string,
) {
  const client = getAssertionClient();
  const rows = Array.isArray(data) ? data : [data];
  const relations = ownedRelations[model] ?? [];

  for (const relation of relations) {
    const ids = [
      ...new Set(
        rows
          .map((row) =>
            getRelatedParentId(row, relation.relation, relation.foreignKey),
          )
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (ids.length === 0) continue;

    const matching = await (client as any)[relation.delegate].count({
      where: { id: { in: ids }, tenantId },
    });
    if (matching !== ids.length) {
      throw new Error(`Cross-tenant ${model}.${relation.foreignKey} write rejected.`);
    }
  }

  for (const nested of nestedOwnedRelations[model] ?? []) {
    const nestedRows = rows.flatMap((row) => {
      const value = getPath(row, nested.path);
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    });
    if (nestedRows.length === 0) continue;

    const ids = [
      ...new Set(
        nestedRows
          .map((row) =>
            getRelatedParentId(
              row,
              nested.relation.relation,
              nested.relation.foreignKey,
            ),
          )
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (ids.length === 0) continue;

    const matching = await (client as any)[nested.relation.delegate].count({
      where: { id: { in: ids }, tenantId },
    });
    if (matching !== ids.length) {
      throw new Error(`Cross-tenant nested ${model} write rejected.`);
    }
  }
}

function buildTenantClient(tenantId: string, base: PrismaClient) {
  const client = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const mArgs = (args || {}) as any;

          // Default take 1000 untuk mencegah OOM pada query findMany
          if (operation === "findMany" && mArgs.take === undefined) {
            mArgs.take = 1000;
          }

          const isDirectTenantModel = tenantScopedModels.has(model);

          if (!isDirectTenantModel) {
            return query(mArgs);
          }

          const filteredOperations = [
            "findMany",
            "findFirst",
            "findFirstOrThrow",
            "findUnique",
            "findUniqueOrThrow",
            "count",
            "aggregate",
            "groupBy",
            "updateMany",
            "deleteMany",
            "update",
            "delete",
            "upsert",
          ];

          if (filteredOperations.includes(operation)) {
            mArgs.where = { ...mArgs.where, tenantId };
          }

          if (operation === "create") {
            mArgs.data = { ...mArgs.data, tenantId };
          } else if (operation === "createMany") {
            if (Array.isArray(mArgs.data)) {
              mArgs.data = mArgs.data.map((d: any) => ({ ...d, tenantId }));
            } else {
              mArgs.data = { ...mArgs.data, tenantId };
            }
          } else if (operation === "update") {
            mArgs.data = { ...mArgs.data, tenantId };
          } else if (operation === "upsert") {
            mArgs.create = { ...mArgs.create, tenantId };
            mArgs.update = { ...mArgs.update, tenantId };
          }

          // Jalankan operasi dalam konteks assertion store sehingga query
          // kepemilikan tenant memakai klien/pool yang sama dengan operasinya.
          // Jika sudah ada transaction client aktif (dari $transaction),
          // pertahankan itu — jangan menimpa dengan base — supaya assertion
          // bisa melihat write yang belum di-commit.
          const assertionClient = assertionClientStore.getStore() ?? base;
          return assertionClientStore.run(assertionClient, async () => {
            if (operation === "create" || operation === "createMany") {
              await assertOwnedRelationsBelongToTenant(model, mArgs.data, tenantId);
            } else if (operation === "update") {
              await assertOwnedRelationsBelongToTenant(model, mArgs.data, tenantId);
            } else if (operation === "upsert") {
              await assertOwnedRelationsBelongToTenant(model, mArgs.create, tenantId);
              await assertOwnedRelationsBelongToTenant(model, mArgs.update, tenantId);
            }

            return query(mArgs);
          });
        },
      },
    },
  });

  // Wrap $transaction to set the AsyncLocalStorage context so that
  // assertion queries inside the transaction use the same connection
  // and can see uncommitted writes (e.g. a product created in the same tx).
  const origTx = (client as any).$transaction.bind(client);
  (client as any).$transaction = async function (
    fnOrOps: any,
    options?: any,
  ) {
    if (typeof fnOrOps === "function") {
      return assertionClientStore.run(client as any, async () => {
        return origTx(async (tx: any) => {
          return assertionClientStore.run(tx, () => fnOrOps(tx));
        }, options);
      });
    }
    return origTx(fnOrOps, options);
  };

  return client;
}

// Page-data helpers memanggil withTenant berkali-kali per request; klien
// extended bersifat stateless per tenant sehingga aman di-memoize. Tanpa ini
// satu render /inventory membuat ~6 instance extension.
const withTenantCache = new WeakMap<PrismaClient, Map<string, ReturnType<typeof buildTenantClient>>>();
const WITH_TENANT_CACHE_MAX = 32;

export function withTenant(tenantId: string, base: PrismaClient = prisma) {
  let byTenant = withTenantCache.get(base);
  if (!byTenant) {
    byTenant = new Map();
    withTenantCache.set(base, byTenant);
  }
  const cached = byTenant.get(tenantId);
  if (cached) return cached;

  const client = buildTenantClient(tenantId, base);
  if (byTenant.size >= WITH_TENANT_CACHE_MAX) {
    byTenant.delete(byTenant.keys().next().value as string);
  }
  byTenant.set(tenantId, client);
  return client;
}
