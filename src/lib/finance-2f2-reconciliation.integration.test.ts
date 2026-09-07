import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveTestDatabaseUrl } from "../../test/setup/test-database-guard";
import { createSupplyPurchase } from "@/lib/supply-purchase";
import { computeCashMovement } from "@/lib/gl-cash-flow";
import { postJournalEntry } from "@/lib/posting";
import {
  voidPurchase,
  voidSupplierPayment,
  voidPayment,
  recordSupplierPayment,
  recordPayment,
  createExpense,
  voidExpense,
  recordOwnerWithdrawal,
  recordCapitalInjection,
  getPnLReport,
} from "@/app/(dashboard)/keuangan/actions";
import {
  createInvoice,
  createCreditNote,
  updateInvoiceShipping,
  voidInvoice,
} from "@/app/(dashboard)/penjualan/actions";
import {
  getBalanceSheetReport,
  getSalesReport,
  getExpenseReport,
  getKeuanganOverview,
} from "@/app/(dashboard)/laporan/actions";
import { getArusKas } from "@/app/(dashboard)/laporan/akuntansi/actions";

const TENANT = "test-tenant-2f2";
const USER = "test-user-2f2";

// gated integration test: only runs against isolated test DB with RUN_INTEGRATION=true
const integrationEnabled = process.env.RUN_INTEGRATION === "true";
const suite = integrationEnabled ? describe : describe.skip;
let prisma: PrismaClient;

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  unstable_cache: (fn: (...args: any[]) => any) => fn,
}));

// vi.mock factories are hoisted above top-level consts, so TENANT/USER cannot
// be referenced here — use literal values (kept in sync with the consts below).
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getCurrentTenantId: vi.fn().mockResolvedValue("test-tenant-2f2"),
    getSystemUserId: vi.fn().mockResolvedValue("test-user-2f2"),
    requireRole: vi.fn(),
    requireFeature: vi.fn(),
    requireTenantPrisma: vi.fn(async () => {
      const { withTenant } = await import("@/lib/prisma");
      return withTenant("test-tenant-2f2", prisma);
    }),
    getTenantTimezone: vi.fn().mockResolvedValue("Asia/Jakarta"),
  };
});

const round = (n: number) => Math.round(n * 100) / 100;

// Fixture berbasis now() harus di-query pada periode berjalan; bulan yang
// di-hardcode membuat tes vacuous begitu bulan berganti (tes ini belum
// pernah berjalan di CI karena butuh DB nyata).
function currentPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const endInclusive = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    start,
    endExclusive,
    startStr: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`,
    endStr: `${endInclusive.getFullYear()}-${pad(endInclusive.getMonth() + 1)}-${pad(endInclusive.getDate())}`,
  };
}

// Tanggal lokal (WIB) — toISOString() memakai UTC, jadi bandingkan komponen lokal.
function localDateStr(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function accountBalance(code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId: TENANT, code } },
    select: { debit: true, credit: true },
  });
  // Model A: jurnal asli + VOID_REVERSAL (tanpa filter voidAt) — net nol
  // berarti transaksi benar-benar batal, bukan hanya "ditandai".
  return round(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
}

async function journalCount(refType: string, reference: string): Promise<number> {
  return prisma.journalEntry.count({ where: { tenantId: TENANT, refType: refType as any, reference } });
}

async function findJournal(refType: string, reference: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId: TENANT, refType: refType as any, reference },
    orderBy: { createdAt: "asc" },
  });
}

async function cleanup() {
  await prisma.journalLine.deleteMany({ where: { journalEntry: { tenantId: TENANT } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: TENANT } });
  await prisma.account.deleteMany({ where: { tenantId: TENANT } });
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT } });
  await prisma.inventoryLedger.deleteMany({ where: { tenantId: TENANT } });
  await prisma.lotPlacement.deleteMany({ where: { tenantId: TENANT } });
  await prisma.lot.deleteMany({ where: { tenantId: TENANT } });
  await prisma.stockReservation.deleteMany({ where: { tenantId: TENANT } });
  await prisma.fulfillmentTask.deleteMany({ where: { tenantId: TENANT } });
  await prisma.creditNoteItem.deleteMany({ where: { tenantId: TENANT } });
  await prisma.creditNote.deleteMany({ where: { tenantId: TENANT } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId: TENANT } } });
  await prisma.payment.deleteMany({ where: { tenantId: TENANT } });
  await prisma.invoice.deleteMany({ where: { tenantId: TENANT } });
  await prisma.supplierPayment.deleteMany({ where: { tenantId: TENANT } });
  await prisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await prisma.purchase.deleteMany({ where: { tenantId: TENANT } });
  await prisma.inventorySupplyItem.deleteMany({ where: { tenantId: TENANT } });
  await prisma.supplier.deleteMany({ where: { tenantId: TENANT } });
  await prisma.product.deleteMany({ where: { tenantId: TENANT } });
  await prisma.capitalTransaction.deleteMany({ where: { tenantId: TENANT } });
  await prisma.customer.deleteMany({ where: { tenantId: TENANT } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

suite("Phase 2F.2 — Financial Statements & Reconciliation", () => {
  let customerId = "";
  let supplierId = "";
  let supplyItemId = "";
  let fgProduct = "";
  let fgProduct2 = "";

  beforeAll(async () => {
    const pool = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 3 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanup();

    await prisma.tenant.upsert({
      where: { id: TENANT },
      create: { id: TENANT, code: "T2F2", name: "2F2 Tenant", subdomain: "t2f2" },
      update: {},
    });
    await prisma.user.upsert({
      where: { id: USER },
      create: { id: USER, email: "t2f2@example.com", name: "2F2 User", tenantId: TENANT, role: "OWNER" },
      update: {},
    });
    const customer = await prisma.customer.create({ data: { tenantId: TENANT, code: "CUST-2F2", name: "Buyer" } });
    customerId = customer.id;

    const fg = await prisma.product.create({
      data: { tenantId: TENANT, code: "PROD-FG1", name: "FG1", type: "FINISHED_GOODS", price: 700_000, stockUnit: 100, lastHpp: 30_000, isActive: true },
    });
    fgProduct = fg.id;
    const fg2 = await prisma.product.create({
      data: { tenantId: TENANT, code: "PROD-FG2", name: "FG2", type: "FINISHED_GOODS", price: 300_000, stockUnit: 100, lastHpp: 10_000, isActive: true },
    });
    fgProduct2 = fg2.id;

    const supplier = await prisma.supplier.create({ data: { tenantId: TENANT, code: "SUP-2F2", name: "Supplier" } });
    supplierId = supplier.id;
    const supplyItem = await prisma.inventorySupplyItem.create({
      data: { tenantId: TENANT, code: "SI-2F2", name: "Beans", category: "PACKAGING", baseUnit: "KG", costPerUnit: 1000, isActive: true },
    });
    supplyItemId = supplyItem.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------ helpers
  async function walkInSale(items: Array<{ productId: string; quantity: number }>): Promise<string> {
    const res = await createInvoice({
      operationKey: randomUUID(),
      customerId,
      items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, discount: 0 })),
      invoiceDiscount: 0,
      tax: 0,
      taxType: "NONE",
      status: "PAID",
      paymentMethod: "CASH",
      salesChannel: "WALK_IN",
    });
    if (!res.success) throw new Error(res.error);
    return res.invoiceId;
  }

  async function b2bDeliveredSale(items: Array<{ productId: string; quantity: number }>): Promise<string> {
    const res = await createInvoice({
      operationKey: randomUUID(),
      customerId,
      items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, discount: 0 })),
      invoiceDiscount: 0,
      tax: 0,
      taxType: "NONE",
      status: "ISSUED",
      paymentMethod: "CREDIT",
      salesChannel: "B2B_DIRECT",
    });
    if (!res.success) throw new Error(res.error);
    const ship = await updateInvoiceShipping(res.invoiceId, { fulfillmentStatus: "DELIVERED" });
    if (!ship.success) throw new Error(ship.error);
    return res.invoiceId;
  }

  async function createPurchase(paidAmount: number): Promise<string> {
    const res = await createSupplyPurchase(prisma, TENANT, USER, {
      operationKey: randomUUID(),
      supplierId,
      supplyItemId,
      supplyQuantity: 100,
      totalCost: 10_000_000,
      shippingCost: 0,
      paidAmount,
      paymentMethod: "CASH",
      receivedAt: "2026-08-14",
    });
    expect(res.success).toBe(true);
    const p = await prisma.purchase.findFirst({ where: { tenantId: TENANT }, orderBy: { createdAt: "desc" } });
    return p!.id;
  }

  // ----------------------------------------------- 1–3: P&L vs GL (revenue)
  it("1. delivered sale → P&L top lines exactly equal GL", async () => {
    await walkInSale([{ productId: fgProduct, quantity: 2 }]); // 2 x 700k, hpp 30k

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    expect(report.revenue).toBe(1_400_000);
    expect(report.cogs).toBe(60_000);
    expect(report.grossProfit).toBe(1_340_000);
    expect(report.opex).toBe(0);
    expect(report.netProfit).toBe(1_340_000);
    expect(report.reconciliationDifference).toBe(0);

    expect(await accountBalance("4-1000")).toBe(-1_400_000);
    expect(await accountBalance("5-1000")).toBe(60_000);
    expect(await accountBalance("1-1000")).toBe(1_400_000);

    const sales = await getSalesReport(period.startStr, period.endStr);
    expect(sales.totalRevenue).toBe(1_400_000);
    expect(sales.invoiceCount).toBe(1);
  });

  it("2. partial return → P&L proportionally reversed (BUG-1)", async () => {
    const id = await walkInSale([{ productId: fgProduct, quantity: 2 }]);
    const cn = await createCreditNote({
      invoiceId: id,
      reason: "retur satu unit",
      items: [{ productId: fgProduct, quantity: 1, unitDiscount: 0 }],
      operationKey: randomUUID(),
    });
    expect(cn.success).toBe(true);

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    expect(report.revenue).toBe(700_000);
    expect(report.cogs).toBe(30_000);
    expect(report.netProfit).toBe(670_000);
    expect(report.reconciliationDifference).toBe(0);
    expect(await accountBalance("4-1000")).toBe(-700_000);
    expect(await accountBalance("5-1000")).toBe(30_000);
    expect(await accountBalance("2-1400")).toBe(-700_000);
    expect(await accountBalance("1-1000")).toBe(1_400_000);
  });

  it("3. void delivered invoice → GL net zero, P&L zero, report zero (BUG-2)", async () => {
    const id = await walkInSale([{ productId: fgProduct, quantity: 1 }]);
    // Nota walk-in lunas: void pembayaran dulu, baru void nota.
    const payment = await prisma.payment.findFirst({ where: { tenantId: TENANT, voidAt: null } });
    const vp = await voidPayment(payment!.id, "salah order");
    expect(vp.success).toBe(true);
    const v = await voidInvoice(id, "salah order");
    expect(v.success).toBe(true);

    expect(await accountBalance("4-1000")).toBe(0);
    expect(await accountBalance("5-1000")).toBe(0);
    expect(await accountBalance("1-1000")).toBe(0);

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    expect(report.revenue).toBe(0);
    expect(report.cogs).toBe(0);
    expect(report.reconciliationDifference).toBe(0);

    const sales = await getSalesReport(period.startStr, period.endStr);
    expect(sales.totalRevenue).toBe(0);
    expect(sales.invoiceCount).toBe(0);
  });

  // ------------------------------------------------------------ 4: expenses
  it("4. expense + void → GL net zero, report zero", async () => {
    // Void harus terjadi pada periode yang sama dengan tanggal ekonomi
    // beban — konvensi laporan: void lintas periode dibukukan pada periode
    // void (lihat komentar deliveredInvoices/voidedInvoices di getPnLReport).
    const period = currentPeriod();
    const expenseDate = `${period.year}-${String(period.month).padStart(2, "0")}-15`;
    const created = await createExpense({ operationKey: randomUUID(), date: expenseDate, category: "OPERASIONAL", amount: 500_000, description: "Listrik" });
    if (!created.success) throw new Error(created.error);
    const v = await voidExpense(created.id, "salah nominal");
    expect(v.success).toBe(true);

    expect(Math.abs(await accountBalance("5-2030"))).toBeLessThan(0.01);
    expect(Math.abs(await accountBalance("1-1000"))).toBeLessThan(0.01);

    const report = await getPnLReport(period.month, period.year);
    expect(report.opex).toBe(0);

    const expenseReport = await getExpenseReport(period.startStr, period.endStr);
    expect(expenseReport.totalExpenses).toBe(0);
    expect(expenseReport.outstandingPayable).toBe(0);
  });

  // ------------------------------------------------ 5–6: AR vs GL (BUG-6)
  it("5. partial payment → operational AR = GL 1-1100", async () => {
    const id = await b2bDeliveredSale([
      { productId: fgProduct, quantity: 1 },
      { productId: fgProduct2, quantity: 1 },
    ]); // 1.000.000
    const pay = await recordPayment({ invoiceId: id, amount: 400_000, method: "CASH", paidAt: "2026-08-15" });
    expect(pay.success).toBe(true);

    expect(await accountBalance("1-1100")).toBe(600_000);
    expect(await accountBalance("1-1000")).toBe(400_000);
    expect(await accountBalance("4-1000")).toBe(-1_000_000);

    const inv = await prisma.invoice.findUnique({ where: { id } });
    const arOp = Math.max(0, Number(inv!.grandTotal) - Number(inv!.paidAmount) - Number(inv!.returnedAmount));
    expect(arOp).toBe(600_000);
  });

  it("6. partial-paid full return → AR 0, refund payable 400k, cash unchanged (BUG-6)", async () => {
    const id = await b2bDeliveredSale([
      { productId: fgProduct, quantity: 1 },
      { productId: fgProduct2, quantity: 1 },
    ]); // 1.000.000
    const pay = await recordPayment({ invoiceId: id, amount: 400_000, method: "CASH", paidAt: "2026-08-15" });
    expect(pay.success).toBe(true);

    const r1 = await createCreditNote({ invoiceId: id, reason: "retur fg2", items: [{ productId: fgProduct2, quantity: 1, unitDiscount: 0 }], operationKey: randomUUID() });
    const r2 = await createCreditNote({ invoiceId: id, reason: "retur fg", items: [{ productId: fgProduct, quantity: 1, unitDiscount: 0 }], operationKey: randomUUID() });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    expect(await accountBalance("1-1100")).toBe(0);
    expect(await accountBalance("2-1400")).toBe(-400_000);
    expect(await accountBalance("1-1000")).toBe(400_000);
    expect(await accountBalance("4-1000")).toBe(0);
  });

  // ------------------------------------------------- 7–10: AP vs GL (BUG-7)
  it("7. purchase with 40% embedded payment → AP = GL 2-1000; cash moves inside PURCHASE journal", async () => {
    await createPurchase(4_000_000);

    expect(await accountBalance("1-1230")).toBe(10_000_000);
    expect(await accountBalance("2-1000")).toBe(-6_000_000);
    // Pembayaran awal embedded memotong kas di jurnal PURCHASE (2F.1A).
    expect(await accountBalance("1-1000")).toBe(-4_000_000);
  });

  it("8. later SupplierPayment reduces AP (embedded paidAmount is cumulative)", async () => {
    const id = await createPurchase(4_000_000);
    const pay = await recordSupplierPayment({ purchaseId: id, amount: 2_000_000, method: "CASH", paidAt: "2026-08-15", operationKey: randomUUID() });
    expect(pay.success).toBe(true);

    expect(await accountBalance("2-1000")).toBe(-4_000_000);
    expect(await accountBalance("1-1000")).toBe(-6_000_000);

    const expenseReport = await getExpenseReport("2026-08-01", "2026-08-31");
    expect(expenseReport.outstandingPayable).toBe(4_000_000);
  });

  it("9. SupplierPayment void restores AP", async () => {
    const id = await createPurchase(4_000_000);
    const pay = await recordSupplierPayment({ purchaseId: id, amount: 2_000_000, method: "CASH", paidAt: "2026-08-15", operationKey: randomUUID() });
    expect(pay.success).toBe(true);
    const payment = await prisma.supplierPayment.findFirst({ where: { tenantId: TENANT, voidAt: null, operationKey: { not: null } } });
    const v = await voidSupplierPayment(payment!.id, "salah input");
    expect(v.success).toBe(true);

    expect(await accountBalance("2-1000")).toBe(-6_000_000);
    // Kas kembali ke saldo pembayaran awal embedded (−4m), bukan nol.
    expect(await accountBalance("1-1000")).toBe(-4_000_000);
  });

  it("10. purchase void → GL net zero, ledger reversal exists (Model A)", async () => {
    const id = await createPurchase(4_000_000);
    const v = await voidPurchase(id, "salah terima");
    expect(v.success).toBe(true);

    expect(Math.abs(await accountBalance("1-1230"))).toBeLessThan(0.01);
    expect(Math.abs(await accountBalance("2-1000"))).toBeLessThan(0.01);
    expect(Math.abs(await accountBalance("1-1000"))).toBeLessThan(0.01);

    const ledgerReversals = await prisma.inventoryLedger.findMany({
      where: { tenantId: TENANT, refType: "VOID_REVERSAL" },
    });
    expect(ledgerReversals.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------- 11–12: capital
  it("11. capital injection → cash + equity move together", async () => {
    const res = await recordCapitalInjection({ type: "INJECTION", amount: 5_000_000, transactionDate: "2026-08-15", operationKey: randomUUID() });
    expect(res.success).toBe(true);

    expect(await accountBalance("1-1000")).toBe(5_000_000);
    expect(await accountBalance("3-1000")).toBe(-5_000_000);
  });

  it("12. owner withdrawal → cash −, equity −", async () => {
    await prisma.capitalTransaction.create({
      data: { tenantId: TENANT, type: "INITIAL", amount: 10_000_000, transactionDate: new Date("2026-08-01T00:00:00"), createdById: USER },
    });
    const res = await recordOwnerWithdrawal({ type: "WITHDRAWAL", amount: 3_000_000, transactionDate: "2026-08-15", operationKey: randomUUID() });
    expect(res.success).toBe(true);

    expect(await accountBalance("1-1000")).toBe(-3_000_000);
    expect(await accountBalance("3-1010")).toBe(3_000_000);
  });

  // ------------------------------------------- 13: recognition timing (BUG-10)
  it("13. ISSUED-undelivered → no revenue & no cash; DELIVERED-credit → revenue, no cash", async () => {
    const undelivered = await createInvoice({
      operationKey: randomUUID(),
      customerId,
      items: [{ productId: fgProduct, quantity: 1, discount: 0 }],
      invoiceDiscount: 0,
      tax: 0,
      taxType: "NONE",
      status: "ISSUED",
      paymentMethod: "CREDIT",
      salesChannel: "B2B_DIRECT",
    });
    expect(undelivered.success).toBe(true);
    if (!undelivered.success) return;

    const delivered = await b2bDeliveredSale([{ productId: fgProduct, quantity: 1 }]);

    expect(await journalCount("INVOICE", undelivered.invoiceId)).toBe(0);
    expect(await journalCount("INVOICE", delivered)).toBe(1);
    expect(await accountBalance("4-1000")).toBe(-700_000);
    expect(await accountBalance("1-1100")).toBe(700_000);
    expect(Math.abs(await accountBalance("1-1000"))).toBeLessThan(0.01);

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    expect(report.revenue).toBe(700_000);
    expect(report.reconciliationDifference).toBe(0);
  });

  // ------------------------------------------- 14–15: cash flow (BUG-3/4)
  it("14. SupplierPayment is a real cash outflow; getArusKas classifies it to supplier", async () => {
    const id = await createPurchase(0);
    const pay = await recordSupplierPayment({ purchaseId: id, amount: 2_000_000, method: "CASH", paidAt: "2026-08-15", operationKey: randomUUID() });
    expect(pay.success).toBe(true);

    const movement = await computeCashMovement({
      tp: prisma,
      tenantId: TENANT,
      start: new Date("2026-08-01T00:00:00"),
      end: new Date("2026-09-01T00:00:00"),
    });
    expect(movement.inflow).toBe(0);
    expect(movement.outflow).toBe(2_000_000);
    expect(movement.net).toBe(-2_000_000);

    const rows = await getArusKas();
    const supplierRow = rows.find((r) => r.label === "Pembayaran ke Pemasok");
    expect(supplierRow).toBeDefined();
    expect(supplierRow!.amount).toBe(-2_000_000);
    const operatingNet = rows.find((r) => r.label === "Kas Bersih dari Operasi");
    expect(operatingNet!.amount).toBe(-2_000_000);
  });

  it("15. credit note without refund → zero cash movement (refund payable only)", async () => {
    const id = await walkInSale([{ productId: fgProduct, quantity: 2 }]);
    const cn = await createCreditNote({ invoiceId: id, reason: "retur satu unit", items: [{ productId: fgProduct, quantity: 1, unitDiscount: 0 }], operationKey: randomUUID() });
    expect(cn.success).toBe(true);

    const period = currentPeriod();
    const movement = await computeCashMovement({
      tp: prisma,
      tenantId: TENANT,
      start: period.start,
      end: period.endExclusive,
    });
    expect(movement.net).toBe(1_400_000);

    const rows = await getArusKas();
    const salesRow = rows.find((r) => r.label === "Penerimaan dari Penjualan");
    expect(salesRow!.amount).toBe(1_400_000);
    // Refund payable bukan arus kas.
    expect(rows.every((r) => r.label !== "Pembayaran Beban Operasional" || r.amount === 0)).toBe(true);
  });

  // --------------------------------------------------- 16: balance sheet (BUG-5)
  it("16. balance sheet equation holds; custom equity account included (BUG-5)", async () => {
    const inj = await recordCapitalInjection({ type: "INJECTION", amount: 5_000_000, transactionDate: "2026-08-15", operationKey: randomUUID() });
    expect(inj.success).toBe(true);
    await walkInSale([{ productId: fgProduct, quantity: 1 }]); // +700k cash, cogs 30k
    await createPurchase(4_000_000); // +10m inventory, −6m AP, −4m cash

    // Akun ekuitas kustom (mis. modal setoran tambahan).
    await prisma.account.create({
      data: { tenantId: TENANT, code: "3-2000", name: "Modal Kustom", type: "EQUITY" },
    });
    await postJournalEntry({
      date: new Date("2026-08-15T00:00:00"),
      description: "Setoran modal kustom",
      reference: `equity-test-${randomUUID()}`,
      refType: "ADJUSTMENT",
      lines: [
        { accountCode: "1-1000", debit: 2_000_000, credit: 0 },
        { accountCode: "3-2000", debit: 0, credit: 2_000_000 },
      ],
    }, { tenantId: TENANT, userId: USER });

    const bs = await getBalanceSheetReport();
    // aset: kas 5m + 0.7m + 2m − 4m = 3.7m; inventori 10m − 30k = 9.97m
    expect(bs.assets.totalAssets).toBe(13_670_000);
    expect(bs.liabilities.totalLiabilities).toBe(6_000_000);
    expect(bs.equity.totalEquity).toBe(7_670_000);
    expect(bs.equity.otherEquity).toBe(2_000_000);
    expect(bs.assets.totalAssets).toBe(bs.liabilities.totalLiabilities + bs.equity.totalEquity);
  });

  // ------------------------------------------------ 17: op AR/AP = GL
  it("17. operational AR & AP (embedded-aware) equal GL balances", async () => {
    const invId = await b2bDeliveredSale([
      { productId: fgProduct, quantity: 1 },
      { productId: fgProduct2, quantity: 1 },
    ]);
    await recordPayment({ invoiceId: invId, amount: 400_000, method: "CASH", paidAt: "2026-08-15" });
    const purchaseId = await createPurchase(0);
    await recordSupplierPayment({ purchaseId, amount: 2_000_000, method: "CASH", paidAt: "2026-08-15", operationKey: randomUUID() });

    expect(await accountBalance("1-1100")).toBe(600_000);
    expect(await accountBalance("2-1000")).toBe(-8_000_000);

    const invoices = await prisma.invoice.findMany({
      where: { tenantId: TENANT, status: { in: ["ISSUED", "PARTIAL"] }, voidAt: null },
      select: { grandTotal: true, paidAmount: true, returnedAmount: true },
    });
    const arOp = round(invoices.reduce((s, i) => s + Math.max(0, Number(i.grandTotal) - Number(i.paidAmount) - Number(i.returnedAmount)), 0));
    expect(arOp).toBe(600_000);

    const purchases = await prisma.purchase.findMany({
      where: { tenantId: TENANT, status: { in: ["COMPLETED", "VOID"] }, OR: [{ voidAt: null }, { voidAt: { gt: new Date() } }] },
      select: { totalCost: true, paidAmount: true },
    });
    const apOp = round(purchases.reduce((s, p) => s + Math.max(0, Number(p.totalCost) - Number(p.paidAmount)), 0));
    expect(apOp).toBe(8_000_000);
  });

  // ------------------------------------------------ 18: adjustments (BUG-9)
  it("18. adjustment valuation uses ledger incomingPrice, not current product cache", async () => {
    await prisma.inventoryLedger.create({
      data: {
        tenantId: TENANT,
        productId: fgProduct,
        entryType: "OUT",
        refType: "ADJUSTMENT_OUT",
        refId: "adjust-test-1",
        quantityUnit: 2,
        incomingPrice: 50_000,
        createdById: USER,
      },
    });
    // Cache produk berubah SETELAH periode — tidak boleh memengaruhi P&L.
    await prisma.product.update({ where: { id: fgProduct }, data: { lastHpp: 999_999, avgCostPerKg: 999_999 } });

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    const row = report.cogsBreakdown.find((r) => r.category === "KERUGIAN_MATERIAL");
    expect(row).toBeDefined();
    expect(row!.amount).toBe(100_000); // 2 x 50.000 dari incomingPrice
  });

  // ------------------------------------------- 19–23: GL dates (BUG-11)
  it("19. backdated expense → journal date = expense.date, not server today", async () => {
    const created = await createExpense({ operationKey: randomUUID(), date: "2026-08-10", category: "OPERASIONAL", amount: 100_000, description: "Listrik" });
    if (!created.success) throw new Error(created.error);

    const expense = await prisma.expense.findUnique({ where: { id: created.id } });
    const journal = await findJournal("EXPENSE", created.id);
    expect(journal).toBeTruthy();
    expect(journal!.date.toISOString()).toBe(expense!.date.toISOString());
    expect(localDateStr(journal!.date)).toBe("2026-08-10");
  });

  it("20. backdated SupplierPayment → journal date = paidAt", async () => {
    const id = await createPurchase(0);
    const pay = await recordSupplierPayment({ purchaseId: id, amount: 2_000_000, method: "CASH", paidAt: "2026-08-12", operationKey: randomUUID() });
    expect(pay.success).toBe(true);

    const payment = await prisma.supplierPayment.findFirst({ where: { tenantId: TENANT, voidAt: null } });
    const journal = await findJournal("SUPPLIER_PAYMENT", payment!.id);
    expect(journal).toBeTruthy();
    expect(journal!.date.toISOString()).toBe(payment!.paidAt.toISOString());
    expect(localDateStr(journal!.date)).toBe("2026-08-12");
  });

  it("21. B2B issued before delivery → revenue journal appears at delivery (deliveredAt)", async () => {
    const res = await createInvoice({
      operationKey: randomUUID(),
      customerId,
      items: [{ productId: fgProduct, quantity: 1, discount: 0 }],
      invoiceDiscount: 0,
      tax: 0,
      taxType: "NONE",
      status: "ISSUED",
      paymentMethod: "CREDIT",
      salesChannel: "B2B_DIRECT",
    });
    expect(res.success).toBe(true);
    if (!res.success) return;

    // Belum diserahkan: belum ada jurnal pendapatan.
    expect(await journalCount("INVOICE", res.invoiceId)).toBe(0);

    const ship = await updateInvoiceShipping(res.invoiceId, { fulfillmentStatus: "DELIVERED" });
    expect(ship.success).toBe(true);

    const journal = await findJournal("INVOICE", res.invoiceId);
    expect(journal).toBeTruthy();
    expect(journal!.refType).toBe("INVOICE");
    const inv = await prisma.invoice.findUnique({ where: { id: res.invoiceId } });
    // Tanggal jurnal = momen penyerahan (deliveredAt); toleransi milidetik
    // karena getCurrentDate() dipanggil dua kali pada jalur yang sama.
    expect(Math.abs(journal!.date.getTime() - inv!.deliveredAt!.getTime())).toBeLessThan(5_000);

    const period = currentPeriod();
    const report = await getPnLReport(period.month, period.year);
    expect(report.revenue).toBe(700_000);
    expect(report.reconciliationDifference).toBe(0);
  });

  it("22. customer payment → journal date = paidAt", async () => {
    const id = await b2bDeliveredSale([{ productId: fgProduct, quantity: 1 }]);
    const pay = await recordPayment({ invoiceId: id, amount: 200_000, method: "CASH", paidAt: "2026-08-13" });
    expect(pay.success).toBe(true);

    const payment = await prisma.payment.findFirst({ where: { tenantId: TENANT, voidAt: null } });
    const journal = await findJournal("PAYMENT", payment!.id);
    expect(journal).toBeTruthy();
    expect(journal!.date.toISOString()).toBe(payment!.paidAt.toISOString());
    expect(localDateStr(journal!.date)).toBe("2026-08-13");
  });

  it("23. purchase → journal date = receivedAt", async () => {
    await createPurchase(0);

    const purchase = await prisma.purchase.findFirst({ where: { tenantId: TENANT } });
    const journal = await findJournal("PURCHASE", purchase!.id);
    expect(journal).toBeTruthy();
    expect(journal!.date.toISOString()).toBe(purchase!.receivedAt.toISOString());
    expect(localDateStr(journal!.date)).toBe("2026-08-14");
  });
});