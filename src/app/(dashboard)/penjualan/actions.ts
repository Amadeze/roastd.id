"use server";
import { getCurrentTenantId, requireFeature, requireRole, requireTenantPrisma, getSystemUserId } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { appendLedger } from "@/lib/stock";
import { recordAudit } from "@/lib/audit";
import { decryptCredential } from "@/lib/credentials";
import { z } from "zod";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { findDuplicateSaleProductIds, resolveCustomerUnitPrice } from "@/lib/sale-intent";
import { calculateTax } from "@/lib/tax";
import { getTenantTaxConfig } from "@/lib/tax-server";
import { postSalesInvoice, postCreditNote, postVoidReversal, postJournalEntry } from "@/lib/posting";
import { getCurrentDate } from "@/lib/date-utils";
import { createMidtransSnapTransaction } from "@/lib/midtrans";
import { fulfillInvoiceAtHandover, fulfillWalkInSaleStock, reserveInvoiceStock } from "@/lib/storefront-commerce";
import { releaseInvoiceReservations } from "@/lib/storefront-commerce";
import { postCustomerPrepayment } from "@/lib/posting";
import {
  canOperatorTransitionFulfillment,
  type OperatorFulfillmentStatus,
} from "@/lib/fulfillment-status";
import { withSerializableRetry } from "@/lib/transaction-retry";
import { computeReceivable } from "@/lib/finance-formulas";
import { buildMidtransItemDetails } from "@/lib/midtrans-item-details";

// =============================================================================
// TYPES
// =============================================================================

export type CustomerOption = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  tier: "RETAIL" | "WHOLESALE_SILVER" | "WHOLESALE_GOLD";
};

export type FGStockOption = {
  id: string;
  code: string;
  name: string;
  price: number;
  priceSilver: number;
  priceGold: number;
  stockUnit: number;
  lastHppPerUnit: number | null;
};

export type ContractPriceOption = {
  id: string;
  customerId: string;
  productId: string;
  tierName: string;
  minOrderQty: number;
  pricePerUnit: number;
};

export type InvoiceItemInput = {
  productId: string;
  quantity: number;
  discount: number; // per unit
};

export type CreateInvoiceInput = {
  operationKey: string;
  customerId: string;
  items: InvoiceItemInput[];
  invoiceDiscount: number;
  tax: number;
  taxType?: "PPN" | "PPH_21" | "PPH_23" | "PPH_4_2" | "NONE";
  customTaxRate?: number;
  pphType?: string;
  status: "PAID" | "ISSUED";
  salesChannel?: "WALK_IN" | "WHATSAPP" | "MARKETPLACE" | "B2B_DIRECT" | "OTHER";
  paymentMethod?: "CASH" | "TRANSFER" | "QRIS" | "CREDIT";
  dueDate?: string; // YYYY-MM-DD
  notes?: string;
};

export type SalesActionResult =
  | { success: true; invoiceCode: string; invoiceId: string }
  | { success: false; error: string };

export type InvoiceRow = {
  id: string;
  code: string;
  customerName: string;
  itemCount: number;
  grandTotal: number;
  paidAmount: number;
  returnedAmount: number;
  balance: number;
  status: string;
  salesChannel: string;
  fulfillmentStatus: string;
  deliveredAt: string | null;
  issuedAt: string;
  dueDate: string | null;
  shippingMethod: string | null;
  shippingAddress: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  shippingCourierCode: string | null;
  shippingCost: number;
  purchaseOrderReference: string | null;
};

export type SalesPageData = {
  invoices: InvoiceRow[];
  customers: CustomerOption[];
  fgOptions: FGStockOption[];
  contractPrices: ContractPriceOption[];
};

export type CashierPageData = Pick<SalesPageData, "customers" | "fgOptions" | "contractPrices">;

// ── Print ──

export type InvoicePrintData = {
  code: string;
  issuedAt: string;
  dueDate: string | null;
  status: string;
  customerName: string;
  customerPhone: string | null;
  customerAddress: string | null;
  items: {
    productName: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    subtotal: number;
    hpp: number;
    margin: number;
  }[];
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  paidAmount: number;
  balance: number;
  payments: {
    code: string;
    amount: number;
    method: string;
    paidAt: string;
  }[];
  notes: string | null;
};

const CreateInvoiceSchema = z.object({
  operationKey: z.string().uuid(),
  customerId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().positive().max(100_000),
    discount: z.number().nonnegative(),
  })).min(1).max(100),
  invoiceDiscount: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  taxType: z.enum(["PPN", "PPH_21", "PPH_23", "PPH_4_2", "NONE"]).optional(),
  customTaxRate: z.number().optional(),
  pphType: z.string().optional(),
  status: z.enum(["PAID", "ISSUED"]),
  salesChannel: z.enum(["WALK_IN", "WHATSAPP", "MARKETPLACE", "B2B_DIRECT", "OTHER"]).default("WALK_IN"),
  paymentMethod: z.enum(["CASH", "TRANSFER", "QRIS", "CREDIT"]).optional(),
  dueDate: z.string().optional(),
  notes: z.string().max(2_000).optional(),
});

// =============================================================================
// PAGE DATA
// =============================================================================

export async function getSalesPageData(): Promise<SalesPageData> {
  await requireRole("OWNER", "MANAGER", "CASHIER");
  const tenantId = await getCurrentTenantId();
  const tp = await requireTenantPrisma();
  const pricingAt = getCurrentDate();
  const [invoicesRaw, customers, fgProducts, contractPricesRaw] = await Promise.all([
    tp.invoice.findMany({
      include: {
        customer: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { issuedAt: "desc" },
      take: 200,
    }),
    tp.customer.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, phone: true, tier: true },
    }),
    tp.product.findMany({
      where: { type: "FINISHED_GOODS", isActive: true },
      orderBy: { name: "asc" },
      select: { 
        id: true, 
        code: true, 
        name: true, 
        price: true, 
        priceSilver: true, 
        priceGold: true,
        stockUnit: true,
        lastHpp: true
      },
    }),
    tp.contractPrice.findMany({
      where: {
        tenantId,
        pricePerUnit: { not: null },
        contract: {
          isActive: true,
          startDate: { lte: pricingAt },
          OR: [{ endDate: null }, { endDate: { gte: pricingAt } }],
        },
      },
      select: {
        id: true,
        productId: true,
        tierName: true,
        minOrderQty: true,
        pricePerUnit: true,
        contract: { select: { customerId: true } },
      },
    }),
  ]);

  const fgOptions = fgProducts.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    price: Number(p.price) || 0,
    priceSilver: Number(p.priceSilver) || 0,
    priceGold: Number(p.priceGold) || 0,
    stockUnit: p.stockUnit || 0,
    lastHppPerUnit: p.lastHpp ? Number(p.lastHpp) : null,
  }));

  const invoices: InvoiceRow[] = invoicesRaw.map((inv: any) => {
    const grand = Number(inv.grandTotal);
    const paid = Number(inv.paidAmount);
    const returned = Number(inv.returnedAmount ?? 0);
    return {
      id: inv.id,
      code: inv.code,
      customerName: inv.customer.name,
      itemCount: inv._count.items,
      grandTotal: grand,
      paidAmount: paid,
      returnedAmount: returned,
      // Sisa tagihan = tagihan − pembayaran − nilai retur (definisi 2F.2).
      balance: computeReceivable(grand, paid, returned),
      status: inv.status,
      salesChannel: inv.salesChannel,
      fulfillmentStatus: inv.fulfillmentStatus,
      deliveredAt: inv.deliveredAt ? inv.deliveredAt.toISOString() : null,
      issuedAt: inv.issuedAt.toISOString(),
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      shippingMethod: inv.shippingMethod,
      shippingAddress: inv.shippingAddress,
      courierName: inv.courierName,
      trackingNumber: inv.trackingNumber,
      shippingCourierCode: inv.shippingCourierCode,
      shippingCost: Number(inv.shippingCost || 0),
      purchaseOrderReference: inv.purchaseOrderReference,
    };
  });

  const contractPrices: ContractPriceOption[] = contractPricesRaw.flatMap((price) =>
    price.pricePerUnit === null
      ? []
      : [{
          id: price.id,
          customerId: price.contract.customerId,
          productId: price.productId,
          tierName: price.tierName,
          minOrderQty: Number(price.minOrderQty),
          pricePerUnit: Number(price.pricePerUnit),
        }],
  );

  return { invoices, customers: customers as CustomerOption[], fgOptions, contractPrices };
}

export async function getCashierPageData(): Promise<CashierPageData> {
  await requireRole("OWNER", "MANAGER", "CASHIER");
  const tenantId = await getCurrentTenantId();
  const tp = await requireTenantPrisma();
  const pricingAt = getCurrentDate();
  const [customers, fgProducts, contractPricesRaw, activeReservations] = await Promise.all([
    tp.customer.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, phone: true, tier: true },
    }),
    tp.product.findMany({
      where: { type: "FINISHED_GOODS", isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        priceSilver: true,
        priceGold: true,
        stockUnit: true,
        lastHpp: true,
      },
    }),
    tp.contractPrice.findMany({
      where: {
        tenantId,
        pricePerUnit: { not: null },
        contract: {
          isActive: true,
          startDate: { lte: pricingAt },
          OR: [{ endDate: null }, { endDate: { gte: pricingAt } }],
        },
      },
      select: {
        id: true,
        productId: true,
        tierName: true,
        minOrderQty: true,
        pricePerUnit: true,
        contract: { select: { customerId: true } },
      },
    }),
    tp.stockReservation.groupBy({
      by: ["productId"],
      where: { tenantId, status: "ACTIVE" },
      _sum: { quantity: true },
    }),
  ]);

  const reservedUnitsByProduct = new Map(
    activeReservations.map((reservation) => [
      reservation.productId,
      Number(reservation._sum.quantity ?? 0),
    ]),
  );

  return {
    customers: customers as CustomerOption[],
    fgOptions: fgProducts.map((product) => ({
      id: product.id,
      code: product.code,
      name: product.name,
      price: Number(product.price) || 0,
      priceSilver: Number(product.priceSilver) || 0,
      priceGold: Number(product.priceGold) || 0,
      // Cashier may only sell inventory that has not already been promised
      // to another active order. The server action enforces the same rule
      // under a product-row lock at checkout.
      stockUnit: Math.max(
        0,
        Number(product.stockUnit ?? 0) - (reservedUnitsByProduct.get(product.id) ?? 0),
      ),
      lastHppPerUnit: product.lastHpp ? Number(product.lastHpp) : null,
    })),
    contractPrices: contractPricesRaw.flatMap((price) =>
      price.pricePerUnit === null
        ? []
        : [{
            id: price.id,
            customerId: price.contract.customerId,
            productId: price.productId,
            tierName: price.tierName,
            minOrderQty: Number(price.minOrderQty),
            pricePerUnit: Number(price.pricePerUnit),
          }],
    ),
  };
}

// =============================================================================
// CREATE INVOICE — ACID TRANSACTION
// =============================================================================

export async function createInvoice(input: CreateInvoiceInput): Promise<SalesActionResult> {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    const parsed = CreateInvoiceSchema.parse(input);
    if (parsed.status === "PAID" && !parsed.paymentMethod) {
      return { success: false, error: "Metode pembayaran wajib dipilih untuk nota lunas." };
    }
    // ── System user ──
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    const tenantPrisma = await requireTenantPrisma();

    const previousAttempt = await tenantPrisma.invoice.findFirst({
      where: { operationKey: parsed.operationKey },
      select: { id: true, code: true },
    });
    if (previousAttempt) {
      return { success: true, invoiceCode: previousAttempt.code, invoiceId: previousAttempt.id };
    }

    const duplicateProductIds = findDuplicateSaleProductIds(parsed.items);
    if (duplicateProductIds.length > 0) {
      return { success: false, error: "Produk yang sama tidak boleh ditambahkan dua kali. Ubah jumlah pada baris yang sudah ada." };
    }

    // ── Validate stock for every item ──
    const [customer, products] = await Promise.all([
      tenantPrisma.customer.findUnique({
        where: { id: parsed.customerId },
        select: { id: true, name: true, tier: true },
      }),
      tenantPrisma.product.findMany({
        where: {
          id: { in: parsed.items.map((item) => item.productId) },
          type: "FINISHED_GOODS",
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          type: true,
          price: true,
          priceSilver: true,
          priceGold: true,
          stockUnit: true,
          lastHpp: true,
          productionBatches: {
            where: { status: "COMPLETED" },
            orderBy: { producedAt: "desc" },
            take: 1,
            select: { hppPerUnit: true },
          },
        },
      }),
    ]);
    if (!customer) {
      return { success: false, error: "Customer tidak ditemukan." };
    }
    const productMap = new Map(products.map((product) => [product.id, product]));

    const pricingAt = getCurrentDate();
    const contractPrices = await tenantPrisma.contractPrice.findMany({
      where: {
        tenantId,
        productId: { in: parsed.items.map((item) => item.productId) },
        pricePerUnit: { not: null },
        contract: {
          customerId: customer.id,
          isActive: true,
          startDate: { lte: pricingAt },
          OR: [{ endDate: null }, { endDate: { gte: pricingAt } }],
        },
      },
      select: { id: true, productId: true, tierName: true, minOrderQty: true, pricePerUnit: true },
    });

    for (const item of parsed.items) {
      const product = productMap.get(item.productId);
      if (!product) {
        return { success: false, error: "Salah satu produk tidak valid atau sudah nonaktif." };
      }
    }

    // ── HPP snapshot per product ──
    // ── Generate invoice code ──
    const now = pricingAt;
    const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const randStr = randomBytes(4).toString("hex").toUpperCase();
    const invoiceCode = `${prefix}-${randStr}`;

    // ── Compute totals ──
    const enrichedItems = parsed.items.map((item) => {
      const product = productMap.get(item.productId)!;
      const resolvedPrice = resolveCustomerUnitPrice(
        {
          price: Number(product.price),
          priceSilver: Number(product.priceSilver),
          priceGold: Number(product.priceGold),
        },
        customer.tier,
        item.quantity,
        contractPrices
          .filter((price) => price.productId === item.productId)
          .map((price) => ({
            id: price.id,
            tierName: price.tierName,
            minOrderQty: Number(price.minOrderQty),
            pricePerUnit: price.pricePerUnit === null ? null : Number(price.pricePerUnit),
          })),
      );
      const unitPrice = resolvedPrice.unitPrice;
      if (item.discount > unitPrice) {
        throw new Error(`Diskon per unit untuk "${product.name}" melebihi harga jual.`);
      }
      const hpp = Number(product.lastHpp ?? product.productionBatches[0]?.hppPerUnit ?? 0);
      const effectivePrice = unitPrice - item.discount;
      const subtotal = effectivePrice * item.quantity;
      return {
        ...item,
        productType: product.type,
        unitPrice,
        hpp,
        subtotal,
        contractPriceId: resolvedPrice.contractPriceId,
        priceSource: resolvedPrice.priceSource,
      };
    });
    const subtotal = enrichedItems.reduce((s, i) => s + i.subtotal, 0);
    if (parsed.invoiceDiscount > subtotal) {
      return { success: false, error: "Diskon invoice tidak boleh melebihi subtotal." };
    }
    const taxConfig = await getTenantTaxConfig();
    let taxResult = calculateTax(
      subtotal,
      parsed.invoiceDiscount,
      parsed.taxType || "NONE",
      parsed.customTaxRate,
      parsed.pphType,
      taxConfig,
    );
    // Pajak manual (Rp) hanya berlaku saat tidak ada jenis pajak terpilih.
    if ((!parsed.taxType || parsed.taxType === "NONE") && parsed.tax > 0) {
      taxResult = { ...taxResult, taxAmount: parsed.tax, taxRate: 0, taxableAmount: 0 };
    }

    const grandTotal = subtotal - parsed.invoiceDiscount + taxResult.taxAmount;
    if (grandTotal <= 0) {
      return { success: false, error: "Total invoice harus lebih dari 0." };
    }
    if (parsed.status === "PAID" && parsed.paymentMethod === "CREDIT") {
      return { success: false, error: "Nota lunas (PAID) tidak dapat memakai metode pembayaran kredit." };
    }

    // ── ACID transaction — Serializable to prevent concurrent oversell (phantom read on stock) ──
    const invoice = await withSerializableRetry(tenantPrisma, async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          tenantId,
          code: invoiceCode,
          operationKey: parsed.operationKey,
          customerId: parsed.customerId,
          subtotal,
          discount: parsed.invoiceDiscount,
          tax: taxResult.taxAmount,
          taxType: taxResult.taxType as any,
          taxRate: taxResult.taxRate,
          taxableAmount: taxResult.taxableAmount,
          pphType: taxResult.pphType,
          pphWithholding: taxResult.pphWithholding,
          grandTotal,
          paidAmount: parsed.status === "PAID" ? grandTotal : 0,
          status: parsed.status === "PAID" ? "PAID" : "ISSUED",
          salesChannel: parsed.salesChannel,
          paymentMethod: parsed.paymentMethod,
          issuedAt: now,
          dueDate: parsed.dueDate ? new Date(`${parsed.dueDate}T00:00:00`) : null,
          notes: parsed.notes,
          createdById: userId,
        },
      });

      // Line items (immutable after insert) — satu createMany, bukan N create:
      // ownership-assert extension mem-batch cek productId dan insert
      // memperpendek serializable tx untuk invoice besar.
      await tx.invoiceItem.createMany({
        data: enrichedItems.map((item) => ({
          invoiceId: inv.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          subtotal: item.subtotal,
          hpp: item.hpp,
          tenantId,
          contractPriceId: item.contractPriceId,
          priceSource: item.priceSource,
        })),
      });

      const isWalkInHandover = parsed.salesChannel === "WALK_IN" && parsed.status === "PAID";
      if (isWalkInHandover) {
        await fulfillWalkInSaleStock(tx, {
          tenantId,
          invoiceId: inv.id,
          invoiceCode,
          createdById: userId,
          items: enrichedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        });
      } else {
        const isApprovedB2bCredit = parsed.salesChannel === "B2B_DIRECT" && parsed.paymentMethod === "CREDIT";
        const reservation = await reserveInvoiceStock(tx, {
          tenantId,
          invoiceId: inv.id,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          items: enrichedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        });
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            reservationExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
            fulfillmentStatus: reservation.hasShortage
              ? "NEEDS_PRODUCTION"
              : parsed.status === "PAID" || isApprovedB2bCredit
                ? "READY_TO_PACK"
                : "AWAITING_PAYMENT",
          },
        });
      }

      // Payment record if PAID
      if (parsed.status === "PAID" && parsed.paymentMethod) {
        const payPrefix = `PAY-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
        const payCode = `${payPrefix}-${randomBytes(4).toString("hex").toUpperCase()}`;

        const payment = await tx.payment.create({
          data: {
            tenantId,
            code: payCode,
            invoiceId: inv.id,
            amount: grandTotal,
            method: parsed.paymentMethod,
            paidAt: now,
            notes: "Lunas saat nota diterbitkan",
            createdById: userId,
          },
        });
        await postCustomerPrepayment(payment.id, grandTotal, inv.code, customer.name, { tx, tenantId, userId, date: now });
      }

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "CREATE",
        entityType: "Invoice",
        entityId: inv.id,
        after: {
          code: inv.code,
          status: inv.status,
          grandTotal: Number(inv.grandTotal),
        },
        metadata: { itemCount: enrichedItems.length, operationKey: parsed.operationKey },
      });

      if (isWalkInHandover) {
        await postSalesInvoice(
          inv.id, Number(inv.grandTotal), Number(inv.paidAmount), customer.name,
          enrichedItems.map((item) => ({ productType: item.productType, hpp: Number(item.hpp), quantity: item.quantity })),
          { tx, tenantId, userId, date: now }, taxResult.taxAmount, Number(taxResult.pphWithholding ?? 0),
        );
        await tx.invoice.update({ where: { id: inv.id }, data: { fulfillmentStatus: "DELIVERED", deliveredAt: now } });
      }

      return inv;
    });

    revalidatePath("/penjualan");
    revalidatePath("/kasir");
    revalidatePath("/inventory");
    revalidatePath("/dashboard");
    revalidatePath("/keuangan");
    revalidatePath("/laporan");

    return { success: true, invoiceCode, invoiceId: invoice.id };
  } catch (err) {
    console.error("[createInvoice]", err);
    if (
      err instanceof Prisma.PrismaClientKnownRequestError
      && err.code === "P2002"
      && input.operationKey
    ) {
      const existing = await (await requireTenantPrisma()).invoice.findFirst({
        where: { operationKey: input.operationKey },
        select: { id: true, code: true },
      });
      if (existing) return { success: true, invoiceCode: existing.code, invoiceId: existing.id };
    }
    return {
      success: false,
      error: err instanceof z.ZodError
        ? "Data nota tidak valid."
        : err instanceof Error
          ? err.message
          : "Gagal menyimpan nota. Coba lagi.",
    };
  }
}

// =============================================================================
// GET INVOICE FOR PRINT
// =============================================================================

export async function getInvoiceForPrint(id: string): Promise<InvoicePrintData | null> {
  const inv = await (await requireTenantPrisma()).invoice.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true, phone: true, address: true } },
      items: {
        include: { product: { select: { name: true, code: true } } },
        orderBy: { id: "asc" },
      },
      payments: { orderBy: { paidAt: "asc" } },
    },
  });

  if (!inv) return null;

  const grandTotal = Number(inv.grandTotal);
  const paidAmount = Number(inv.paidAmount);

  return {
    code: inv.code,
    issuedAt: inv.issuedAt.toISOString(),
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    status: inv.status,
    customerName: inv.customer.name,
    customerPhone: inv.customer.phone,
    customerAddress: inv.customer.address,
    items: inv.items.map((item) => {
      const unitPrice = Number(item.unitPrice);
      const disc = Number(item.discount);
      const hpp = Number(item.hpp);
      const subtotal = Number(item.subtotal);
      const margin = (unitPrice - disc - hpp) * item.quantity;
      return {
        productName: item.product.name,
        quantity: item.quantity,
        unitPrice,
        discount: disc,
        subtotal,
        hpp,
        margin,
      };
    }),
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discount),
    tax: Number(inv.tax),
    grandTotal,
    paidAmount,
    balance: grandTotal - paidAmount,
    payments: inv.payments.map((p) => ({
      code: p.code,
      amount: Number(p.amount),
      method: p.method,
      paidAt: p.paidAt.toISOString(),
    })),
    notes: inv.notes,
  };
}

// =============================================================================
// GET INVOICE FOR RETURN (CREDIT NOTE)
// =============================================================================

export type InvoiceReturnData = {
  id: string;
  code: string;
  customerName: string;
  grandTotal: number;
  returnedAmount: number;
  items: {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    unitDiscount: number;
    returnedQuantity: number;
  }[];
};

export async function getInvoiceForReturn(id: string): Promise<InvoiceReturnData | null> {
  const inv = await (await requireTenantPrisma()).invoice.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      items: {
        include: { product: { select: { name: true } } },
      },
      creditNotes: {
        include: { items: true },
      },
    },
  });

  if (!inv || inv.fulfillmentStatus !== "DELIVERED") return null;

  const items = inv.items.map((item) => {
    const returnedQuantity = inv.creditNotes.reduce((sum, cn) => {
      const cnItem = cn.items.find((i) => i.productId === item.productId);
      return sum + (cnItem?.quantity || 0);
    }, 0);

    return {
      productId: item.productId,
      productName: item.product.name,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      unitDiscount: Number(item.discount),
      returnedQuantity,
    };
  });

  return {
    id: inv.id,
    code: inv.code,
    customerName: inv.customer.name,
    grandTotal: Number(inv.grandTotal),
    returnedAmount: Number(inv.returnedAmount || 0),
    items,
  };
}

// =============================================================================
// VOID INVOICE
// =============================================================================

export type VoidResult =
  | { success: true }
  | { success: false; error: string };

export async function voidInvoice(
  invoiceId: string,
  reason: string
): Promise<VoidResult> {
  try {
    await requireRole("OWNER", "MANAGER");
    const userId = await getSystemUserId();
    const tenantId = await getCurrentTenantId();
    const tenantPrisma = await requireTenantPrisma();

    await withSerializableRetry(tenantPrisma, async (tx) => {
      const lockedRows = await tx.$queryRaw`
        SELECT "id" FROM "invoices"
        WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      ` as Array<{ id: string }>;
      if (lockedRows.length === 0) throw new Error("Nota tidak ditemukan.");

      const inv = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { items: true },
      });
      if (!inv) throw new Error("Nota tidak ditemukan.");
      if (inv.status === "VOID") throw new Error("Nota sudah di-void.");
      if (Number(inv.paidAmount) > 0 || inv.status === "PAID" || inv.status === "PARTIAL") {
        throw new Error("Void semua pembayaran nota terlebih dahulu sebelum membatalkan nota.");
      }

      const alreadyReversed = await tx.inventoryLedger.count({
        where: { tenantId, refId: invoiceId, refType: "VOID_REVERSAL" },
      });

      if (alreadyReversed === 0) {
        const saleEntries = await tx.inventoryLedger.findMany({
          where: { refId: invoiceId, refType: "SALE_FG_OUT", entryType: "OUT" },
        });
        if (saleEntries.length > 0) {
          // Kembalikan stok ke lot asal agar traceability tidak terputus.
          for (const entry of saleEntries) {
            await appendLedger(tx, {
              data: {
                tenantId,
                productId:    entry.productId,
                entryType:    "IN",
                refType:      "VOID_REVERSAL",
                refId:        invoiceId,
                reversalOfLedgerId: entry.id,
                quantityUnit: entry.quantityUnit,
                lotId:        entry.lotId,
                lotNumber:    entry.lotNumber,
                expiryDate:   entry.expiryDate,
                notes:        `VOID reversal: ${inv.code}`,
                createdById: userId,
              },
            });
            if (entry.lotId) {
              await tx.lot.update({ where: { id: entry.lotId }, data: { consumedAt: null } });
            }
          }
          await postVoidReversal("INVOICE", invoiceId, reason, { tx, tenantId, userId });
        } else {
          await releaseInvoiceReservations(tx, invoiceId, "RELEASED", getCurrentDate());
        }
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: "VOID", fulfillmentStatus: "CANCELLED", voidReason: reason, voidAt: getCurrentDate() },
      });

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "VOID",
        entityType: "Invoice",
        entityId: invoiceId,
        before: { code: inv.code, status: inv.status },
        after: { status: "VOID", reason },
      });
    });

    revalidatePath("/penjualan");
    revalidatePath("/inventory");
    revalidatePath("/keuangan");
    return { success: true };
  } catch (err) {
    console.error("[voidInvoice]", err);
    return { success: false, error: "Gagal melakukan void." };
  }
}
// =============================================================================
// APPROVE INVOICE & GENERATE MIDTRANS LINK
// =============================================================================

export async function approveInvoiceForMidtrans(invoiceId: string) {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    await requireFeature("MIDTRANS");
    const prisma = await requireTenantPrisma();
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { 
        customer: true,
        tenant: true,
        items: { include: { product: true } }
      },
    });

    if (!inv) return { success: false, error: "Nota tidak ditemukan." };
    if (inv.status !== "DRAFT") return { success: false, error: "Nota tidak berstatus DRAFT." };

    const tenant = inv.tenant;
    let paymentLink: string | null = null;
    let warningMessage: string | null = null;

    if (tenant.midtransServerKey) {
      try {
        const midtransLines = inv.items.map(i => ({
          id: i.productId,
          price: Number(i.unitPrice),
          quantity: i.quantity,
          name: i.product.name.substring(0, 50),
        }));

        const safeItemDetails = buildMidtransItemDetails(
          midtransLines,
          Number(inv.grandTotal),
          Number(inv.shippingCost),
          Number(inv.tax)
        );

        const snapParams = {
          order_id: inv.code,
          gross_amount: Math.round(Number(inv.grandTotal)),
          customer_details: {
            first_name: inv.customer.name,
            phone: inv.customer.phone || undefined,
            email: inv.customer.email || undefined,
          },
          item_details: safeItemDetails
        };

        const snapRes = await createMidtransSnapTransaction(
          decryptCredential(tenant.midtransServerKey),
          tenant.midtransIsProduction,
          snapParams
        );
        paymentLink = snapRes.redirect_url;
      } catch (midtransErr: any) {
        console.error("[approveInvoiceForMidtrans Midtrans Error]", midtransErr);
        warningMessage = midtransErr.message || "Gagal membuat link pembayaran Midtrans.";
      }
    }

    const existingNotes = inv.notes ? inv.notes + "\n\n" : "";
    const newNotes = paymentLink ? `${existingNotes}Link Pembayaran (Midtrans): ${paymentLink}` : inv.notes;
    const orderPublicToken = randomBytes(24).toString("base64url");

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { 
        status: "ISSUED",
        midtransOrderId: inv.code,
        paymentUrl: paymentLink,
        publicOrderToken: orderPublicToken,
        notes: newNotes
      }
    });

    revalidatePath("/penjualan");
    return { success: true, paymentLink, warning: warningMessage };
  } catch (err: unknown) {
    console.error("[approveInvoiceForMidtrans]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: "Gagal memproses nota: " + message };
  }
}

export async function updateInvoiceShipping(
  invoiceId: string, 
  data: { courierName?: string; trackingNumber?: string; shippingCost?: number; shippingMethod?: string; fulfillmentStatus?: string }
) {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    const tenantId = await getCurrentTenantId();
    const userId = await getSystemUserId();
    const tenantPrisma = await requireTenantPrisma();
    const parsed = z.object({
      courierName: z.string().trim().max(100).optional(),
      trackingNumber: z.string().trim().max(150).optional(),
      shippingCost: z.number().nonnegative().max(1_000_000_000).optional(),
      shippingMethod: z.string().trim().max(100).optional(),
      fulfillmentStatus: z.enum(["READY_TO_PACK", "PACKED", "SHIPPED", "DELIVERED"]).optional(),
    }).parse(data);

    const invoice = await tenantPrisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { customer: { select: { name: true, email: true, phone: true } }, tenant: { select: { name: true, subdomain: true } } },
    });
    if (!invoice) return { success: false, error: "Nota tidak ditemukan." };
    if (invoice.status === "VOID") return { success: false, error: "Nota yang sudah di-void tidak dapat diubah." };
    if (
      parsed.fulfillmentStatus
      && !canOperatorTransitionFulfillment(
        invoice.fulfillmentStatus as OperatorFulfillmentStatus,
        parsed.fulfillmentStatus,
      )
    ) {
      throw new Error(
        `Status fulfillment tidak dapat diubah dari ${invoice.fulfillmentStatus} ke ${parsed.fulfillmentStatus}.`,
      );
    }
    if (invoice.status === "PAID" && parsed.shippingCost !== undefined && parsed.shippingCost !== Number(invoice.shippingCost)) {
      return { success: false, error: "Ongkir nota lunas tidak dapat diubah." };
    }

    const { courierName, trackingNumber, shippingCost, shippingMethod, fulfillmentStatus } = parsed;
    const updateData: any = {};
    if (courierName !== undefined) updateData.courierName = courierName;
    if (trackingNumber !== undefined) updateData.trackingNumber = trackingNumber;
    if (shippingCost !== undefined) {
      updateData.shippingCost = shippingCost;
      updateData.grandTotal = Number(invoice.subtotal) - Number(invoice.discount) + Number(invoice.tax) + shippingCost;
      if (updateData.grandTotal < Number(invoice.paidAmount)) {
        return { success: false, error: "Total baru tidak boleh lebih kecil dari pembayaran yang sudah diterima." };
      }
    }
    if (shippingMethod !== undefined) updateData.shippingMethod = shippingMethod;
    const nextFulfillment = fulfillmentStatus || (trackingNumber?.trim() ? "SHIPPED" : undefined);
    if (nextFulfillment) {
      updateData.fulfillmentStatus = nextFulfillment;
      if (nextFulfillment === "PACKED") updateData.packedAt = getCurrentDate();
      if (nextFulfillment === "SHIPPED") updateData.shippedAt = getCurrentDate();
      if (nextFulfillment === "DELIVERED") updateData.deliveredAt = getCurrentDate();
    }

    await tenantPrisma.$transaction(async (tx) => {
      if (nextFulfillment === "DELIVERED") {
        await fulfillInvoiceAtHandover(tx, {
          tenantId,
          invoiceId,
          createdById: userId,
          now: getCurrentDate(),
        });
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: updateData,
      });

      // Jurnal penyesuaian ongkir: selisih ongkir mempengaruhi piutang/kas dan pendapatan.
      if (shippingCost !== undefined && shippingCost !== Number(invoice.shippingCost)) {
        const diff = shippingCost - Number(invoice.shippingCost);
        if (diff !== 0) {
          const receiver = invoice.status === "PAID" ? "1-1000" : "1-1100";
          await postJournalEntry(
            {
              date: getCurrentDate(),
              description: `Penyesuaian ongkir ${invoice.code}`,
              // Pasangan nilai lama/baru membuat retry idempotent tanpa
              // bertabrakan dengan jurnal invoice awal.
              reference: `${invoiceId}:shipping:${Number(invoice.shippingCost)}:${shippingCost}`,
              refType: "ADJUSTMENT",
              lines:
                diff > 0
                  ? [
                      { accountCode: receiver, debit: diff, credit: 0 },
                      { accountCode: "4-1000", debit: 0, credit: diff },
                    ]
                  : [
                      { accountCode: receiver, debit: 0, credit: -diff },
                      { accountCode: "4-1000", debit: -diff, credit: 0 },
                    ],
            },
            { tx, tenantId, userId },
          );
        }
      }

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "UPDATE",
        entityType: "InvoiceShipping",
        entityId: invoiceId,
        before: {
          courierName: invoice.courierName,
          trackingNumber: invoice.trackingNumber,
          shippingCost: Number(invoice.shippingCost),
          shippingMethod: invoice.shippingMethod,
        },
        after: updateData,
      });
    });

    revalidatePath("/penjualan");
    if (nextFulfillment && invoice.publicOrderToken && invoice.tenant.subdomain) {
      const labels: Record<string, string> = { READY_TO_PACK: "Siap dikemas", PACKED: "Sudah dikemas", SHIPPED: "Dalam pengiriman", DELIVERED: "Pesanan selesai" };
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
      const orderUrl = `${baseUrl}/tenant/${invoice.tenant.subdomain}/order/${invoice.publicOrderToken}`;
      const input = { customerName: invoice.customer.name, tenantName: invoice.tenant.name, invoiceCode: invoice.code, statusLabel: labels[nextFulfillment] || "Status pesanan diperbarui", trackingNumber: trackingNumber ?? invoice.trackingNumber, courierName: courierName ?? invoice.courierName, orderUrl };
      const { sendOrderStatusEmail, sendOrderStatusWhatsApp } = await import("@/lib/notifications");
      await Promise.allSettled([
        invoice.customer.email ? sendOrderStatusEmail({ ...input, to: invoice.customer.email }) : Promise.resolve(),
        invoice.customer.phone ? sendOrderStatusWhatsApp({ ...input, phone: invoice.customer.phone }) : Promise.resolve(),
      ]);
    }
    return { success: true };
  } catch (error: any) {
    console.error("Update Shipping Error:", error);
    return { success: false, error: "Gagal update data pengiriman: " + error.message };
  }
}

// =============================================================================
// AWB / TRACKING — Phase 2H Batch 4
// =============================================================================

/**
 * Save or replace AWB for a COURIER invoice. Derives courier code from the
 * immutable Invoice shipping snapshot — never trusts client-provided courier.
 */
export async function saveInvoiceAwb(
  invoiceId: string,
  data: { awb: string },
) {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    const tenantId = await getCurrentTenantId();
    const tenantPrisma = await requireTenantPrisma();

    const parsed = z
      .object({ awb: z.string().trim().min(1).max(150) })
      .parse(data);

    const invoice = await tenantPrisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        tenantId: true,
        shippingMethod: true,
        shippingCourierCode: true,
        courierName: true,
        trackingNumber: true,
        status: true,
      },
    });

    if (!invoice) return { success: false, error: "Nota tidak ditemukan." };
    if (invoice.tenantId !== tenantId)
      return { success: false, error: "Akses ditolak." };
    if (invoice.status === "VOID")
      return { success: false, error: "Nota yang sudah di-void tidak dapat diubah." };
    if (invoice.shippingMethod !== "COURIER")
      return { success: false, error: "AWB hanya untuk pengiriman kurir." };

    // Derive courier code from invoice shipping snapshot (server-side only)
    const courierCode = invoice.shippingCourierCode;
    if (!courierCode)
      return {
        success: false,
        error: "Kode kurir tidak tersedia. Invoice harus melalui checkout kurir.",
      };

    // Atomic: both InvoiceTracking and Invoice.trackingNumber must succeed or both roll back
    await tenantPrisma.$transaction(async (tx) => {
      await tx.invoiceTracking.upsert({
        where: { invoiceId },
        create: {
          tenantId,
          invoiceId,
          awb: parsed.awb,
          courierCode,
        },
        update: {
          awb: parsed.awb,
          courierCode,
          // Reset tracking state on AWB change
          providerStatus: null,
          providerDelivered: null,
          events: Prisma.JsonNull,
          lastRefreshedAt: null,
        },
      });

      // Also update the legacy trackingNumber on Invoice
      if (invoice.trackingNumber !== parsed.awb) {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { trackingNumber: parsed.awb },
        });
      }
    });

    await recordAudit(
      tenantPrisma,
      {
        tenantId,
        userId: await getSystemUserId(),
        action: "UPDATE",
        entityType: "InvoiceAwb",
        entityId: invoiceId,
        before: { awb: invoice.trackingNumber },
        after: { awb: parsed.awb, courierCode },
      },
    );

    revalidatePath("/penjualan");
    return { success: true };
  } catch (error: any) {
    console.error("Save AWB Error:", error);
    return { success: false, error: "Gagal menyimpan AWB: " + error.message };
  }
}

/**
 * Refresh tracking from RajaOngkir provider. Updates InvoiceTracking only —
 * NEVER mutates fulfillment status, accounting, or stock.
 */
export async function refreshInvoiceTracking(invoiceId: string) {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    const tenantId = await getCurrentTenantId();
    const tenantPrisma = await requireTenantPrisma();

    const invoice = await tenantPrisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        tenantId: true,
        shippingMethod: true,
        trackingNumber: true,
      },
    });

    if (!invoice) return { success: false, error: "Nota tidak ditemukan." };
    if (invoice.tenantId !== tenantId)
      return { success: false, error: "Akses ditolak." };
    if (invoice.shippingMethod !== "COURIER")
      return { success: false, error: "Tracking hanya untuk pengiriman kurir." };

    const tracking = await tenantPrisma.invoiceTracking.findUnique({
      where: { invoiceId },
    });

    if (!tracking)
      return {
        success: false,
        error: "AWB belum tercatat. Silakan masukkan AWB terlebih dahulu.",
      };

    // Resolve provider config (server-side only, never leaks key)
    const { getRajaOngkirClientConfig } = await import(
      "@/lib/shipping/platform-integration"
    );
    const config = await getRajaOngkirClientConfig();

    const { trackWaybillDetailed } = await import(
      "@/lib/shipping/providers/rajaongkir"
    );
    const { normalizeTrackingResponse } = await import(
      "@/lib/shipping/tracking"
    );

    const providerResult = await trackWaybillDetailed(
      { awb: tracking.awb, courier: tracking.courierCode },
      config,
    );

    const normalized = normalizeTrackingResponse(
      tracking.awb,
      tracking.courierCode,
      {
        summary: providerResult.summary,
        details: providerResult.details,
      },
    );

    // Upsert — never create duplicate tracking rows
    await tenantPrisma.invoiceTracking.update({
      where: { invoiceId },
      data: {
        providerStatus: normalized.providerStatus,
        providerDelivered: normalized.providerDelivered,
        events: normalized.events,
        lastRefreshedAt: new Date(normalized.lastRefreshedAt),
      },
    });

    revalidatePath("/penjualan");
    return {
      success: true,
      tracking: {
        awb: normalized.awb,
        courierCode: normalized.courierCode,
        providerStatus: normalized.providerStatus,
        providerDelivered: normalized.providerDelivered,
        events: normalized.events,
        lastRefreshedAt: normalized.lastRefreshedAt,
      },
    };
  } catch (error: any) {
    console.error("Refresh Tracking Error:", error);
    return {
      success: false,
      error: "Gagal refresh tracking: " + error.message,
    };
  }
}

/**
 * Read-only: get current tracking state for an invoice.
 */
export async function getInvoiceTracking(invoiceId: string) {
  try {
    const tenantId = await getCurrentTenantId();
    const tenantPrisma = await requireTenantPrisma();

    const invoice = await tenantPrisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, tenantId: true },
    });

    if (!invoice) return { success: false, error: "Nota tidak ditemukan." };
    if (invoice.tenantId !== tenantId)
      return { success: false, error: "Akses ditolak." };

    const tracking = await tenantPrisma.invoiceTracking.findUnique({
      where: { invoiceId },
      select: {
        awb: true,
        courierCode: true,
        providerStatus: true,
        providerDelivered: true,
        events: true,
        lastRefreshedAt: true,
      },
    });

    return { success: true, tracking };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// =============================================================================
// CREATE CREDIT NOTE (RETUR)
// =============================================================================

export type CreditNoteInput = {
  invoiceId: string;
  reason: string;
  operationKey?: string;
  items: {
    productId: string;
    quantity: number;
    unitDiscount?: number;
  }[];
};

export async function createCreditNote(input: CreditNoteInput) {
  try {
    await requireRole("OWNER", "MANAGER", "CASHIER");
    const tenantId = await getCurrentTenantId();
    const userId = await getSystemUserId();

    if (!tenantId || !userId) {
      return { success: false, error: "Unauthorized" };
    }
    if (input.items.length === 0) {
      return { success: false, error: "Pilih minimal satu item untuk diretur." };
    }
    if (input.items.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      return { success: false, error: "Jumlah retur harus bilangan bulat lebih dari nol." };
    }
    if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
      return { success: false, error: "Produk retur tidak boleh duplikat." };
    }

    const normalizedReason = input.reason.trim();
    if (normalizedReason.length < 3 || normalizedReason.length > 500) {
      return { success: false, error: "Alasan retur harus terdiri dari 3-500 karakter." };
    }

    const { invoiceId, items } = input;
    const opKey = input.operationKey || randomBytes(16).toString("hex");
    const tp = await requireTenantPrisma();
    const previousAttempt = await tp.creditNote.findFirst({
      where: { operationKey: opKey },
      select: { code: true },
    });
    if (previousAttempt) {
      return { success: true, creditNoteCode: previousAttempt.code };
    }
    let creditNoteCode = "";

    await withSerializableRetry(tp, async (tx) => {
      const committedAttempt = await tx.creditNote.findFirst({
        where: { operationKey: opKey },
        select: { code: true },
      });
      if (committedAttempt) {
        creditNoteCode = committedAttempt.code;
        return;
      }

      const lockedRows = await tx.$queryRaw`
        SELECT "id" FROM "invoices"
        WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      ` as Array<{ id: string }>;
      if (lockedRows.length === 0) throw new Error("Invoice tidak ditemukan.");

      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId, tenantId },
        include: {
          items: { include: { product: { select: { type: true } } } },
          creditNotes: { include: { items: true } },
        },
      });
      if (!inv) throw new Error("Invoice tidak ditemukan.");
      if (inv.fulfillmentStatus !== "DELIVERED") {
        throw new Error("Retur hanya dapat dibuat setelah pesanan diserahkan.");
      }

      for (const item of items) {
        const invItem = inv.items.find((candidate) => candidate.productId === item.productId);
        if (!invItem) throw new Error("Produk tidak ditemukan pada invoice.");
        const returnedQty = inv.creditNotes.reduce((sum, creditNote) => {
          const creditItem = creditNote.items.find((candidate) => candidate.productId === item.productId);
          return sum + (creditItem?.quantity || 0);
        }, 0);
        if (item.quantity > invItem.quantity - returnedQty) {
          throw new Error("Jumlah retur melebihi sisa yang dapat diretur.");
        }
      }

      creditNoteCode = `CN-${randomBytes(4).toString("hex").toUpperCase()}`;
      let returnedLineSubtotal = 0;
      const cnItemsData = items.map((item) => {
        const invItem = inv.items.find((i) => i.productId === item.productId)!;
        const unitPrice = invItem.unitPrice;
        // Nilai retur harus mengikuti harga/diskon immutable dari invoice,
        // bukan nilai diskon yang dikirim ulang oleh client.
        const subtotal = (Number(unitPrice) - Number(invItem.discount)) * item.quantity;
        returnedLineSubtotal += subtotal;

        return {
          productId: item.productId,
          quantity: item.quantity,
          unitPrice,
          unitDiscount: Number(invItem.discount),
          subtotal,
          tenantId,
        };
      });

      const invoiceSubtotal = Number(inv.subtotal);
      const returnRatio = invoiceSubtotal > 0 ? returnedLineSubtotal / invoiceSubtotal : 0;
      const netReturnedAmount = Math.round(
        (invoiceSubtotal - Number(inv.discount)) * returnRatio * 100,
      ) / 100;
      const returnedTaxAmount = Math.round(Number(inv.tax) * returnRatio * 100) / 100;
      const totalReturnedAmount = netReturnedAmount + returnedTaxAmount;

      const creditNote = await tx.creditNote.create({
        data: {
          code: creditNoteCode,
          invoiceId,
          total: totalReturnedAmount,
          reason: normalizedReason,
          operationKey: opKey,
          tenantId,
          items: {
            create: cnItemsData,
          },
        },
      });

      // Calculate if all items are fully returned
      const fullyReturned = inv.items.every((invItem) => {
        const totalReturnedQty = inv.creditNotes.reduce((sum, cn) => {
          const cnItem = cn.items.find((i) => i.productId === invItem.productId);
          return sum + (cnItem?.quantity || 0);
        }, 0);
        const newReturnedQty = items
          .filter((i) => i.productId === invItem.productId)
          .reduce((s, i) => s + i.quantity, 0);
        return (totalReturnedQty + newReturnedQty) >= invItem.quantity;
      });

      // Update Invoice returned amount and status
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          returnedAmount: { increment: totalReturnedAmount },
          ...(fullyReturned ? { status: "RETURNED" as const } : {}),
        },
      });

      // Restore stock via appendLedger
      for (const item of items) {
        const invoiceItem = inv.items.find((candidate) => candidate.productId === item.productId)!;
        const netWeightKg = Number(invoiceItem.netWeightGrams ?? 0) / 1000;
        const isKgBacked = netWeightKg > 0;
        await appendLedger(tx, {
          data: {
            tenantId,
            productId: item.productId,
            entryType: "IN",
            quantityUnit: isKgBacked ? 0 : item.quantity,
            quantityKg: isKgBacked
              ? Math.round(item.quantity * netWeightKg * 1000) / 1000
              : 0,
            incomingPrice: isKgBacked
              ? Number(invoiceItem.hpp) / netWeightKg
              : Number(invoiceItem.hpp),
            refType: "RETURN_FG_IN",
            refId: creditNote.id,
            notes: `Retur dari nota ${inv.code}`,
            createdById: userId,
          },
        });
      }

      // Alokasikan retur antara Piutang (porsi tagihan yang masih outstanding)
      // dan liabilitas Refund Pelanggan (porsi uang muka pelanggan). Kas TIDAK
      // berubah di sini — pengembalian kas dilakukan di fase terpisah.
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const originalOutstanding = Number(inv.grandTotal) - Number(inv.paidAmount);
      const cumulativeReturnBefore = Number(inv.returnedAmount);
      const arPortion = round2(Math.max(0, Math.min(totalReturnedAmount, originalOutstanding - cumulativeReturnBefore)));
      const refundPortion = round2(Math.max(0, totalReturnedAmount - arPortion));

      await postCreditNote(
        creditNote.id,
        totalReturnedAmount,
        inv.code,
        invoiceId,
        items.map((item) => {
          const invoiceItem = inv.items.find((candidate) => candidate.productId === item.productId)!;
          return {
            productType: invoiceItem.product.type,
            hpp: Number(invoiceItem.hpp),
            quantity: item.quantity,
          };
        }),
        { tx, tenantId, userId, date: getCurrentDate() },
        { taxAmount: returnedTaxAmount, arPortion, refundPortion },
      );
    });

    revalidatePath("/penjualan");

    return { success: true, creditNoteCode };
  } catch (error: any) {
    if (
      error && typeof error === "object" && "code" in error && error.code === "P2002"
      && input.operationKey
    ) {
      const existing = await (await requireTenantPrisma()).creditNote.findFirst({
        where: { operationKey: input.operationKey },
        select: { code: true },
      });
      if (existing) return { success: true, creditNoteCode: existing.code };
    }
    console.error("Create Credit Note Error:", error);
    return { success: false, error: error.message || "Terjadi kesalahan internal." };
  }
}
