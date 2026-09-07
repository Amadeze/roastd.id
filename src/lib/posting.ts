import { requireTenantPrisma, getCurrentTenantId, getSystemUserId } from "@/lib/auth";
import { getCurrentDate } from "@/lib/date-utils";
import { ensureDefaultChartOfAccounts } from "@/lib/coa-templates";
import {
  getSupplyInventoryAccount,
  getSupplyIssueExpenseAccount,
} from "@/lib/supply-accounts";
import { Prisma, ProductType, type InventorySupplyCategory, type JournalRefType } from "@prisma/client";
import { randomBytes } from "node:crypto";

type PostingLine = {
  accountCode: string;
  debit: number;
  credit: number;
};

type PostingInput = {
  date: Date;
  description: string;
  reference: string;
  refType: JournalRefType;
  lines: PostingLine[];
};

export type PostingOptions = {
  tx?: unknown;
  tenantId?: string;
  userId?: string;
  /** Tanggal efektif transaksi (mis. deliveredAt, paidAt, receivedAt).
   *  Default: tanggal server saat ini. */
  date?: Date;
};

type PostingTransaction = Pick<Prisma.TransactionClient, "account" | "journalEntry">;

function generateJournalCode(): string {
  const now = getCurrentDate();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `JE-${year}-${month}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

async function getAccountIdByCode(
  tx: PostingTransaction,
  tenantId: string,
  code: string,
): Promise<string> {
  const account = await tx.account.findUnique({
    where: { tenantId_code: { tenantId, code } },
    select: { id: true },
  });
  if (!account) throw new Error(`Akun dengan kode "${code}" tidak ditemukan`);
  return account.id;
}

export async function postJournalEntry(
  input: PostingInput,
  options: PostingOptions = {},
): Promise<string> {
  const tenantId = options.tenantId ?? await getCurrentTenantId();
  const userId = options.userId ?? await getSystemUserId();

  const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Jurnal tidak balance: debit ${totalDebit} ≠ credit ${totalCredit}`);
  }

  const createEntry = async (tx: PostingTransaction): Promise<string> => {
    const existing = await tx.journalEntry.findFirst({
      where: { tenantId, refType: input.refType, reference: input.reference },
      select: { code: true },
    });
    if (existing) return existing.code;

    await ensureDefaultChartOfAccounts(tx, tenantId);
    const code = generateJournalCode();
    const accountIds = await Promise.all(
      input.lines.map((l) => getAccountIdByCode(tx, tenantId, l.accountCode)),
    );

    await tx.journalEntry.create({
      data: {
        code,
        date: input.date,
        description: input.description,
        reference: input.reference,
        refType: input.refType,
        tenantId,
        createdById: userId,
        lines: {
          create: input.lines.map((l, i) => ({
            sideId: i,
            debit: l.debit,
            credit: l.credit,
            accountId: accountIds[i],
          })),
        },
      },
    });

    return code;
  };

  if (options.tx) return createEntry(options.tx as PostingTransaction);

  const tp = await requireTenantPrisma();
  return tp.$transaction(
    (tx) => createEntry(tx as unknown as PostingTransaction),
    { isolationLevel: "Serializable" },
  );
}
/** Membalik seluruh jurnal sumber yang belum dibatalkan, lalu menandai mereka sebagai void. */
export async function postVoidReversal(
  sourceRefType: JournalRefType,
  sourceReference: string,
  reason: string,
  options: PostingOptions = {},
): Promise<string> {
  const tenantId = options.tenantId ?? await getCurrentTenantId();
  const userId = options.userId ?? await getSystemUserId();

  if (!options.tx) {
    const tp = await requireTenantPrisma();
    return tp.$transaction(
      (tx) => postVoidReversal(sourceRefType, sourceReference, reason, {
        tx,
        tenantId,
        userId,
        date: options.date,
      }),
      { isolationLevel: "Serializable" },
    );
  }

  const tx = options.tx as PostingTransaction;
  const sources = await tx.journalEntry.findMany({
    where: {
      tenantId,
      refType: sourceRefType,
      reference: sourceReference,
      voidAt: null,
    },
    include: {
      lines: {
        orderBy: { sideId: "asc" },
        include: { account: { select: { code: true } } },
      },
    },
  });

  let firstCode = "";
  if (sources.length === 0) {
    // Also check for legacy "SALE" refType
    const legacySources = await tx.journalEntry.findMany({
      where: {
        tenantId,
        refType: "SALE",
        reference: sourceReference,
        voidAt: null,
      },
      include: {
        lines: {
          orderBy: { sideId: "asc" },
          include: { account: { select: { code: true } } },
        },
      },
    });
    if (legacySources.length === 0) {
      throw new Error(`Jurnal sumber ${sourceRefType}/${sourceReference} tidak ditemukan atau sudah dibatalkan.`);
    }

    // Create reversal for legacy SALE entries
    for (const source of legacySources) {
      const reversalCode = await postJournalEntry({
        date: options.date ?? getCurrentDate(),
        description: `Pembatalan: ${source.description}`,
        reference: `${sourceReference}:${source.id}`,
        refType: "VOID_REVERSAL",
        lines: source.lines.map((line) => ({
          accountCode: line.account.code,
          debit: Number(line.credit),
          credit: Number(line.debit),
        })),
      }, { tx, tenantId, userId });
      if (!firstCode) firstCode = reversalCode;
    }
    if (firstCode) return firstCode;
  }

  // Process main sources (refType matches sourceRefType)
  for (const source of sources) {
    const reversalCode = await postJournalEntry({
      date: options.date ?? getCurrentDate(),
      description: `Pembatalan: ${source.description}`,
      reference: `${sourceReference}:${source.id}`,
      refType: "VOID_REVERSAL",
      lines: source.lines.map((line) => ({
        accountCode: line.account.code,
        debit: Number(line.credit),
        credit: Number(line.debit),
      })),
    }, { tx, tenantId, userId });
    if (!firstCode) firstCode = reversalCode;
  }

  return firstCode;
}

// ── Auto-posting helpers ──

export async function postSalesInvoice(
  invoiceId: string,
  total: number,
  paidAmount: number,
  customerName: string,
  items: Array<{ productType?: ProductType; hpp: number; quantity: number }> = [],
  options: PostingOptions = {},
  taxAmount = 0,
  pphWithholding = 0,
): Promise<string> {
  // PPh yang dipotong pembeli (B2B) disetor langsung ke otoritas pajak, bukan
  // ke bisnis. Piutang usaha harus dikurangi sebesar PPh tersebut, dan sisanya
  // dicatat sebagai Piutang Pajak (aset) yang nanti ditagih dari otoritas pajak.
  const pph = Math.max(0, Math.min(pphWithholding, total - paidAmount));
  const remaining = total - paidAmount;
  const lines: PostingLine[] = [];

  if (paidAmount > 0) {
    lines.push({ accountCode: "2-1300", debit: paidAmount, credit: 0 });
  }
  if (remaining - pph > 0) {
    lines.push({ accountCode: "1-1100", debit: remaining - pph, credit: 0 });
  }
  if (pph > 0) {
    lines.push({ accountCode: "1-1500", debit: pph, credit: 0 });
  }

  // Pendapatan bersih (tanpa pajak) + utang pajak bila ada.
  lines.push({ accountCode: "4-1000", debit: 0, credit: total - taxAmount });
  if (taxAmount > 0) {
    lines.push({ accountCode: "2-1100", debit: 0, credit: taxAmount });
  }

  const totalCogs = items.reduce((sum, item) => sum + item.hpp * item.quantity, 0);
  if (totalCogs > 0) {
    const cogsAccount = getCogsAccountCode(items);
    lines.push({ accountCode: cogsAccount, debit: totalCogs, credit: 0 });
    const inventoryAccount = getInventoryAccountCode(items);
    lines.push({ accountCode: inventoryAccount, debit: 0, credit: totalCogs });
  }

  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Penjualan ke ${customerName} (Invoice ${invoiceId})`,
    reference: invoiceId,
    refType: "INVOICE",
    lines,
  }, options);
}

function getCogsAccountCode(items: Array<{ productType?: ProductType; hpp: number; quantity: number }>): string {
  const hasPackaging = items.some((item) => item.productType === "PACKAGING");
  const hasGreenBean = items.some((item) => item.productType === "GREEN_BEAN");
  const hasRoastedBean = items.some((item) => item.productType === "ROASTED_BEAN");
  const hasFinishedGoods = items.some((item) => item.productType === "FINISHED_GOODS");

  if (hasPackaging && !hasGreenBean && !hasRoastedBean && !hasFinishedGoods) return "5-1030";
  if (hasGreenBean && !hasRoastedBean && !hasFinishedGoods) return "5-1000";
  if (hasRoastedBean && !hasFinishedGoods) return "5-1000";
  if (hasFinishedGoods) return "5-1000";

  return "5-1000";
}

function getInventoryAccountCode(items: Array<{ productType?: ProductType; hpp: number; quantity: number }>): string {
  const hasPackaging = items.some((item) => item.productType === "PACKAGING");
  const hasGreenBean = items.some((item) => item.productType === "GREEN_BEAN");
  const hasRoastedBean = items.some((item) => item.productType === "ROASTED_BEAN");
  const hasFinishedGoods = items.some((item) => item.productType === "FINISHED_GOODS");

  if (hasPackaging && !hasGreenBean && !hasRoastedBean && !hasFinishedGoods) return "1-1230";
  if (hasGreenBean && !hasRoastedBean && !hasFinishedGoods) return "1-1200";
  if (hasRoastedBean && !hasFinishedGoods) return "1-1210";
  if (hasFinishedGoods) return "1-1220";

  return "1-1220";
}

export async function postExpense(
  expenseId: string,
  amount: number,
  categoryCode: string,
  description: string,
  options: PostingOptions = {},
): Promise<string> {
  const accountMap: Record<string, string> = {
    GAJI: "5-2000",
    UTILITAS: "5-2020",
    OPERASIONAL: "5-2030",
    SEWA: "5-2010",
    PEMASARAN: "5-2050",
    LAINNYA: "5-2060",
  };

  const expenseAccount = accountMap[categoryCode] ?? "5-2060";

  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Beban: ${description}`,
    reference: expenseId,
    refType: "EXPENSE",
    lines: [
      { accountCode: expenseAccount, debit: amount, credit: 0 },
      { accountCode: "1-1000", debit: 0, credit: amount },
    ],
  }, options);
}

export async function postCapitalInjection(
  capitalTxnId: string,
  amount: number,
  description: string,
  options: PostingOptions = {},
): Promise<string> {
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Setoran modal: ${description}`,
    reference: capitalTxnId,
    refType: "CAPITAL",
    lines: [
      { accountCode: "1-1000", debit: amount, credit: 0 },
      { accountCode: "3-1000", debit: 0, credit: amount },
    ],
  }, options);
}

export async function postOwnerWithdrawal(
  capitalTxnId: string,
  amount: number,
  description: string,
  options: PostingOptions = {},
): Promise<string> {
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Prive: ${description}`,
    reference: capitalTxnId,
    refType: "CAPITAL",
    lines: [
      { accountCode: "3-1010", debit: amount, credit: 0 },
      { accountCode: "1-1000", debit: 0, credit: amount },
    ],
  }, options);
}

export async function postCustomerPayment(
  paymentId: string,
  amount: number,
  invoiceCode: string,
  customerName: string,
  options: PostingOptions = {},
): Promise<string> {
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Pembayaran dari ${customerName} — ${invoiceCode}`,
    reference: paymentId,
    refType: "PAYMENT",
    lines: [
      { accountCode: "1-1000", debit: amount, credit: 0 },
      { accountCode: "1-1100", debit: 0, credit: amount },
    ],
  }, options);
}

export async function postCustomerPrepayment(
  paymentId: string,
  amount: number,
  invoiceCode: string,
  customerName: string,
  options: PostingOptions = {},
): Promise<string> {
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Uang muka dari ${customerName} — ${invoiceCode}`,
    reference: paymentId,
    refType: "PAYMENT",
    lines: [
      { accountCode: "1-1000", debit: amount, credit: 0 },
      { accountCode: "2-1300", debit: 0, credit: amount },
    ],
  }, options);
}

export const REFUND_PAYABLE_ACCOUNT = "2-1400"; // Refund Pelanggan (liabilitas)

export async function postCreditNote(
  creditNoteId: string,
  totalReturned: number,
  invoiceCode: string,
  invoiceId: string,
  items: Array<{ productType?: ProductType; hpp: number; quantity: number }> = [],
  options: PostingOptions = {},
  taxInfo?: { taxAmount: number; arPortion: number; refundPortion: number },
): Promise<string> {
  const taxAmount = Math.min(taxInfo?.taxAmount ?? 0, totalReturned);
  const arPortion = taxInfo?.arPortion ?? 0;
  const refundPortion = taxInfo?.refundPortion ?? 0;
  const netReturn = totalReturned - taxAmount;
  const lines: PostingLine[] = [
    { accountCode: "4-1000", debit: netReturn, credit: 0 },
  ];
  if (taxAmount > 0) {
    lines.push({ accountCode: "2-1100", debit: taxAmount, credit: 0 });
  }
  // Porsi tagihan yang masih outstanding mengurangi Piutang (1-1100);
  // kelebihannya (uang muka pelanggan) menjadi liabilitas Refund Pelanggan (2-1400).
  // Kas (1-1000) TIDAK berubah di sini — pengembalian kas dilakukan di fase terpisah.
  if (arPortion > 0.01) {
    lines.push({ accountCode: "1-1100", debit: 0, credit: arPortion });
  }
  if (refundPortion > 0.01) {
    lines.push({ accountCode: REFUND_PAYABLE_ACCOUNT, debit: 0, credit: refundPortion });
  }

  // COGS/inventory reversal: gunakan akun PERSIS milik jurnal penjualan asli
  // (historis — tidak bergantung pada state Product saat ini).
  const { cogsAccount, inventoryAccount } = await resolveCreditNoteAccounts(options, invoiceId, items);
  const totalCogs = items.reduce((sum, item) => sum + item.hpp * item.quantity, 0);
  if (totalCogs > 0) {
    lines.push({ accountCode: inventoryAccount, debit: totalCogs, credit: 0 });
    lines.push({ accountCode: cogsAccount, debit: 0, credit: totalCogs });
  }

  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Retur penjualan — ${invoiceCode}`,
    reference: creditNoteId,
    refType: "CREDIT_NOTE",
    lines,
  }, options);
}

/**
 * Tentukan akun COGS & inventory untuk retur dari jurnal penjualan ASLI
 * (refType INVOICE), sehingga reversal selalu memantul ke klasifikasi yang
 * benar-benar dibukukan saat penjualan — bukan hasil turunan ulang yang bisa
 * berubah bila ProductType dimutasi. Fallback ke turunan per-line bila jurnal
 * asli tidak ditemukan.
 */
async function resolveCreditNoteAccounts(
  options: PostingOptions,
  invoiceId: string,
  items: Array<{ productType?: ProductType; hpp: number; quantity: number }>,
): Promise<{ cogsAccount: string; inventoryAccount: string }> {
  const fallback = {
    cogsAccount: getCogsAccountCode(items),
    inventoryAccount: getInventoryAccountCode(items),
  };
  if (!options.tx) return fallback;
  const tenantId = options.tenantId ?? await getCurrentTenantId();
   
  const tx = options.tx as any;
  const sale = await tx.journalEntry.findFirst({
    where: { tenantId, refType: "INVOICE", reference: invoiceId, voidAt: null },
    include: { lines: { include: { account: true } } },
  });
  if (!sale) return fallback;
  // Di jurnal penjualan: COGS diposting sebagai KREDIT (5-1xxx) dan inventory
  // sebagai DEBIT (1-12xx). Cari berdasarkan arah saldo tersebut.
  const cogs = sale.lines.find(
    (l: any) => l.account.type === "EXPENSE" && l.account.code.startsWith("5-1") && Number(l.credit) > 0,
  );
  const inventory = sale.lines.find(
    (l: any) => l.account.type === "ASSET" && l.account.code.startsWith("1-12") && Number(l.debit) > 0,
  );
  if (!cogs || !inventory) return fallback;
  return { cogsAccount: cogs.account.code, inventoryAccount: inventory.account.code };
}

export async function postSupplierPayment(
  paymentId: string,
  amount: number,
  purchaseCode: string,
  supplierName: string,
  options: PostingOptions = {},
): Promise<string> {
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Pembayaran ke ${supplierName} — ${purchaseCode}`,
    reference: paymentId,
    refType: "SUPPLIER_PAYMENT",
    lines: [
      { accountCode: "2-1000", debit: amount, credit: 0 },
      { accountCode: "1-1000", debit: 0, credit: amount },
    ],
  }, options);
}

export async function postProductionBatch(
  batchId: string,
  totalRbCost: number,
  packagingCost: number,
  supplyCost: number,
  laborCost: number,
  overheadCost: number,
  fgProductName: string,
  options: PostingOptions = {},
  nonHppSupplyCost: number = 0,
): Promise<string> {
  const totalCost = totalRbCost + packagingCost + supplyCost + nonHppSupplyCost + laborCost + overheadCost;
  const lines: PostingLine[] = [
    { accountCode: "1-1220", debit: totalCost, credit: 0 },
    { accountCode: "1-1210", debit: 0, credit: totalRbCost },
    { accountCode: "1-1230", debit: 0, credit: packagingCost },
  ];
  if (supplyCost > 0) {
    lines.push({ accountCode: getSupplyInventoryAccount("PACKAGING"), debit: 0, credit: supplyCost });
  }
  if (nonHppSupplyCost > 0) {
    lines.push({ accountCode: getSupplyInventoryAccount("PACKAGING"), debit: 0, credit: nonHppSupplyCost });
    lines.push({ accountCode: getSupplyIssueExpenseAccount("CONSUMABLE", false), debit: nonHppSupplyCost, credit: 0 });
  }
  if (laborCost > 0) {
    lines.push({ accountCode: "5-1010", debit: 0, credit: laborCost });
  }
  if (overheadCost > 0) {
    lines.push({ accountCode: "5-1020", debit: 0, credit: overheadCost });
  }
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Produksi: ${fgProductName}`,
    reference: batchId,
    refType: "PRODUCTION",
    lines,
  }, options);
}

export async function postRoastingBatch(
  batchId: string,
  inputCost: number,
  inputKg: number,
  outputKg: number,
  gbProductName: string,
  rbProductName: string,
  options: PostingOptions = {},
): Promise<string> {
  if (inputKg <= 0 || outputKg < 0 || inputCost < 0) {
    throw new Error("Data biaya roasting tidak valid.");
  }
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Roasting: ${gbProductName} → ${rbProductName}`,
    reference: batchId,
    refType: "ROASTING",
    lines: [
      // Normal shrinkage is part of RB conversion cost. A total-loss batch has no asset.
      outputKg > 0
        ? { accountCode: "1-1210", debit: inputCost, credit: 0 }
        : { accountCode: "5-1000", debit: inputCost, credit: 0 },
      { accountCode: "1-1200", debit: 0, credit: inputCost },
    ],
  }, options);
}

export async function postPurchase(
  purchaseId: string,
  type: "GREEN_BEAN" | "ROASTED_BEAN" | "PACKAGING" | "SUPPLY",
  totalCost: number,
  paidAmount: number,
  supplierName: string,
  options: PostingOptions = {},
  supplyCategory?: InventorySupplyCategory,
): Promise<string> {
  const inventoryAccount =
    type === "GREEN_BEAN"
      ? "1-1200"
      : type === "ROASTED_BEAN"
        ? "1-1210"
        : type === "SUPPLY"
          ? getSupplyInventoryAccount(supplyCategory ?? "OTHER")
          : "1-1230";

  const lines: PostingLine[] = [
    { accountCode: inventoryAccount, debit: totalCost, credit: 0 },
  ];

  if (paidAmount > 0) {
    lines.push({ accountCode: "1-1000", debit: 0, credit: paidAmount });
  }
  const remaining = totalCost - paidAmount;
  if (remaining > 0.01) {
    lines.push({ accountCode: "2-1000", debit: 0, credit: remaining });
  }

  const typeLabel =
    type === "GREEN_BEAN"
      ? "Green Bean"
      : type === "ROASTED_BEAN"
        ? "Roasted Bean"
        : type === "SUPPLY"
          ? "Supply"
          : "Kemasan";
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Pembelian ${typeLabel} dari ${supplierName} — ${purchaseId}`,
    reference: purchaseId,
    refType: "PURCHASE",
    lines,
  }, options);
}

export type StockAdjustmentTarget =
  | ProductType
  | "PACKAGING"
  | "SUPPLY";

export type SupplyAdjustmentContext = {
  category: InventorySupplyCategory;
  includeInProductHpp: boolean;
};

export async function postStockAdjustment(
  adjustmentId: string,
  productType: StockAdjustmentTarget,
  entryType: "IN" | "OUT",
  quantity: number,
  unitCost: number,
  options: PostingOptions = {},
  supplyContext?: SupplyAdjustmentContext,
): Promise<string> {
  const value = quantity * unitCost;
  const inventoryAccount = supplyContext
    ? getSupplyInventoryAccount(supplyContext.category)
    : productType === "GREEN_BEAN"
      ? "1-1200"
      : productType === "ROASTED_BEAN"
        ? "1-1210"
        : productType === "FINISHED_GOODS"
          ? "1-1220"
          : "1-1230";
  const expenseAccount = supplyContext
    ? getSupplyIssueExpenseAccount(supplyContext.category, supplyContext.includeInProductHpp)
    : "5-1040";

  const lines: PostingLine[] = [];

  if (entryType === "IN") {
    lines.push({ accountCode: inventoryAccount, debit: value, credit: 0 });
    lines.push({ accountCode: expenseAccount, debit: 0, credit: value });
  } else {
    lines.push({ accountCode: expenseAccount, debit: value, credit: 0 });
    lines.push({ accountCode: inventoryAccount, debit: 0, credit: value });
  }

  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Penyesuaian stok ${productType} — ${adjustmentId}`,
    reference: adjustmentId,
    refType: "ADJUSTMENT",
    lines,
  }, options);
}

export async function postSampleUsage(
  sampleId: string,
  totalCost: number,
  components: Array<{ productType?: ProductType; totalCost: number }>,
  options: PostingOptions = {},
): Promise<string> {
  const lines: PostingLine[] = [
    { accountCode: "5-2050", debit: totalCost, credit: 0 },
  ];

  const distribution: Record<string, number> = {};

  for (const component of components) {
    const account =
      component.productType === "GREEN_BEAN"
        ? "1-1200"
        : component.productType === "ROASTED_BEAN"
          ? "1-1210"
          : component.productType === "FINISHED_GOODS"
            ? "1-1220"
            : "1-1230";

    distribution[account] = (distribution[account] || 0) + component.totalCost;
  }

  for (const [account, amount] of Object.entries(distribution)) {
    lines.push({ accountCode: account, debit: 0, credit: amount });
  }

  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Sample / Promosi — ${sampleId}`,
    reference: sampleId,
    refType: "SAMPLE_USAGE",
    lines,
  }, options);
}

export async function postGrindingBatch(
  batchId: string,
  totalRbCost: number,
  grindingCost: number,
  outputProductName: string,
  options: PostingOptions = {},
): Promise<string> {
  const totalCost = totalRbCost + grindingCost;
  const lines: PostingLine[] = [
    { accountCode: "1-1220", debit: totalCost, credit: 0 },
    { accountCode: "1-1210", debit: 0, credit: totalRbCost },
  ];
  if (grindingCost > 0) {
    lines.push({ accountCode: "5-1010", debit: 0, credit: grindingCost });
  }
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Grinding: ${outputProductName}`,
    reference: batchId,
    refType: "GRINDING",
    lines,
  }, options);
}

export async function postExperimentalProduction(
  batchId: string,
  totalCost: number,
  grindingCost: number,
  outputProductName: string,
  options: PostingOptions = {},
): Promise<string> {
  const rbCost = totalCost - grindingCost;
  const lines: PostingLine[] = [
    { accountCode: "1-1220", debit: totalCost, credit: 0 },
  ];
  if (rbCost > 0) {
    lines.push({ accountCode: "1-1210", debit: 0, credit: rbCost });
  }
  if (grindingCost > 0) {
    lines.push({ accountCode: "5-1010", debit: 0, credit: grindingCost });
  }
  return postJournalEntry({
    date: options.date ?? getCurrentDate(),
    description: `Experimental: ${outputProductName}`,
    reference: batchId,
    refType: "EXPERIMENTAL",
    lines,
  }, options);
}