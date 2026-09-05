import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/transaction-retry";
import { revalidatePath } from "next/cache";
import { sendInvoiceEmail, sendInvoiceWhatsApp, sendNewOrderNotificationEmail, sendNewOrderNotificationWhatsApp } from "@/lib/notifications";
import { getTenantAccessState } from "@/lib/subscription";
import { recordAudit } from "@/lib/audit";
import crypto from "crypto";
import {
  enforceRateLimit,
  RateLimitError,
} from "@/lib/rate-limit";
import {
  digestIdentifier,
  layeredIdentifiers,
  phoneIdentifier,
  resolveClientIdentity,
} from "@/lib/client-identity";
import { planHasFeature } from "@/lib/plans";
import { isFlagEnabled } from "@/lib/featureFlags";
import { canIssueInvoice, loadCapacityUsage } from "@/lib/capacity";
import {
  getRequestId,
  internalErrorResponse,
  logServerError,
} from "@/lib/api-observability";
import { z } from "zod";
import { getCurrentDate } from "@/lib/date-utils";
import { paymentDestinationSnapshot, toPublicPaymentMethod } from "@/lib/manual-payments";
import { calculateStorefrontTotals, reserveInvoiceStock } from "@/lib/storefront-commerce";
import {
  LineageResolutionError,
  resolveOfferingLineage,
} from "@/lib/storefront-catalog";
import {
  normalizeStorefrontGrind,
  offeringReserveKg,
  STOREFRONT_GRIND_SIZES,
  type StorefrontGrindSize,
} from "@/lib/storefront-grind";
import { buildMidtransItemDetails } from "@/lib/midtrans-item-details";
import { recoverOrInitializeMidtrans } from "@/lib/midtrans-gateway";
import { calculateShipmentWeightForTenant } from "@/lib/shipping/weight";
import { createCartFingerprint } from "@/lib/shipping/fingerprint";
import {
  verifyOriginSelectionToken,
  type OriginSelectionPayload,
} from "@/lib/shipping/origin-token";
import {
  verifyShippingQuoteToken,
  type ShippingQuotePayload,
} from "@/lib/shipping/quote-token";
import { calculateDomesticCost } from "@/lib/shipping/providers/rajaongkir";
import { getRajaOngkirClientConfig } from "@/lib/shipping/platform-integration";
import { ShippingProviderError } from "@/lib/shipping/errors";
import { verifyB2bAccessToken } from "@/lib/b2b-access";
import {
  addDays,
  loadStorefrontB2bContext,
  resolveB2bCatalogPrice,
} from "@/lib/storefront-b2b";

type CheckoutItemInput = {
  id?: string;
  productId?: string | null;
  offeringId?: string;
  variantId?: string;
  quantity?: number;
  grindSize?: StorefrontGrindSize;
  customGrindLabel?: string | null;
};

type InvoiceItemCreateData = {
  tenantId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  subtotal: number;
  hpp: number;
  grindSize: StorefrontGrindSize;
  customGrindLabel: string | null;
  offeringId?: string | null;
  offeringVariantId?: string | null;
  offeringName?: string | null;
  packageName?: string | null;
  netWeightGrams?: number | null;
  roastLevel?: string | null;
  contractPriceId?: string | null;
  priceSource?: "BASE" | "TIER" | "CONTRACT";
};

const CheckoutSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().min(6).max(24),
  customerEmail: z.union([z.email(), z.literal("")]).optional(),
  customerAddress: z.string().trim().min(1).max(500),
  shippingMethod: z
    .enum(["PICKUP", "LOCAL_DELIVERY", "STORE_COURIER", "COURIER"])
    .default("PICKUP"),
  shippingQuoteToken: z.string().optional(), // required for COURIER
  destinationToken: z.string().optional(), // required for COURIER
  paymentMethodId: z.string().min(1).optional(),
  b2bAccessToken: z.string().max(2048).optional(),
  purchaseOrderReference: z.string().trim().max(100).optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        productId: z.string().nullable().optional(),
        offeringId: z.string().optional(),
        variantId: z.string().optional(),
        quantity: z.coerce.number().int().positive().max(10_000),
        grindSize: z.enum(STOREFRONT_GRIND_SIZES).default("WHOLE_BEAN"),
        customGrindLabel: z.string().trim().max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
})
  .refine(
    (data) => data.shippingMethod !== "COURIER" || (data.shippingQuoteToken && data.destinationToken),
    { message: "Kurir nasional memerlukan token pengiriman dan token quote", path: ["shippingQuoteToken"] },
  );

async function findOfferingRows(tenantId: string, offeringIds: string[]) {
  return prisma.coffeeOffering.findMany({
    where: { tenantId, id: { in: offeringIds }, isActive: true },
    select: {
      id: true,
      name: true,
      roastLevel: true,
      sourceMode: true,
      coffeeSourceId: true,
      lineageProductId: true,
      grindOptions: true,
      allowCustomGrind: true,
      variants: {
        where: { isActive: true, unitPrice: { gt: 0 } },
        select: { id: true, packageName: true, netWeightGrams: true, unitPrice: true },
      },
    },
  });
}

type CoffeeOfferingRow = Awaited<ReturnType<typeof findOfferingRows>>[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const requestId = getRequestId(req.headers);
  let tenantSubdomain = "unknown";
  try {
    const { subdomain } = await params;
    tenantSubdomain = subdomain;
    const parsedBody = CheckoutSchema.safeParse(await req.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Data checkout tidak valid", details: parsedBody.error.flatten() },
        { status: 400 },
      );
    }
    const identity = resolveClientIdentity(req.headers);
    await enforceRateLimit({
      scope: "tenant-checkout",
      identifiers: layeredIdentifiers(identity, [
        digestIdentifier("tenant", subdomain),
        phoneIdentifier(parsedBody.data.customerPhone),
      ]),
      limit: 30,
      windowSeconds: 10 * 60,
    });
    const {
      customerName: submittedCustomerName,
      customerPhone: submittedCustomerPhone,
      customerEmail: submittedCustomerEmail,
      customerAddress,
      shippingMethod,
      paymentMethodId,
      items,
    } = parsedBody.data;
    const rawIdempotencyKey = req.headers.get("idempotency-key")?.trim() || null;
    if (
      rawIdempotencyKey
      && (rawIdempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(rawIdempotencyKey))
    ) {
      return NextResponse.json({ error: "Idempotency key tidak valid." }, { status: 400 });
    }

    // 1. Dapatkan tenant
    const tenant = await prisma.tenant.findUnique({
      where: { subdomain },
      include: { users: { take: 1, orderBy: { createdAt: 'asc' }, select: { id: true } } }
    });

    if (
      !tenant ||
      getTenantAccessState(tenant) !== "ACTIVE"
    ) {
      return NextResponse.json({ error: "Tenant tidak ditemukan" }, { status: 404 });
    }
    if (isFlagEnabled("capacity-only-gates")) {
      const usage = await loadCapacityUsage(tenant.id);
      const decision = await canIssueInvoice(
        { tenantId: tenant.id, subscriptionTier: tenant.subscriptionTier },
        usage,
      );
      if (!decision.allowed) {
        return NextResponse.json(
          {
            error: "Monthly invoice capacity exceeded",
            limit: decision.limit,
            used: decision.used,
            tier: decision.tier,
          },
          { status: 403 },
        );
      }
    } else if (!planHasFeature(tenant.subscriptionTier, "STOREFRONT")) {
      return NextResponse.json({ error: "Tenant tidak ditemukan" }, { status: 404 });
    }

    const createdById = tenant.users[0]?.id;
    if (!createdById) {
      return NextResponse.json({ error: "Tenant belum memiliki user admin" }, { status: 400 });
    }

    let b2bContext = null;
    if (parsedBody.data.b2bAccessToken) {
      const access = verifyB2bAccessToken(parsedBody.data.b2bAccessToken);
      if (!access) {
        return NextResponse.json({ error: "Akses partner tidak valid atau kedaluwarsa." }, { status: 403 });
      }
      b2bContext = await loadStorefrontB2bContext(prisma, tenant.id, access, new Date(), { includeRecentOrders: false });
      if (!b2bContext) {
        return NextResponse.json({ error: "Customer atau kontrak partner tidak lagi aktif." }, { status: 403 });
      }
    }
    const customerName = b2bContext?.customer.name ?? submittedCustomerName;
    const customerPhone = b2bContext?.customer.phone ?? submittedCustomerPhone;
    const customerEmail = b2bContext?.customer.email ?? submittedCustomerEmail;

    if (rawIdempotencyKey) {
      const existing = await prisma.invoice.findUnique({
        where: {
          tenantId_operationKey: {
            tenantId: tenant.id,
            operationKey: rawIdempotencyKey,
          },
        },
      });
      if (existing?.publicOrderToken) {
        return NextResponse.json({
          success: true,
          invoice: {
            code: existing.code,
            status: existing.status,
            grandTotal: Number(existing.grandTotal),
          },
          snapToken: null,
          paymentUrl: existing.paymentUrl,
          orderUrl: `/tenant/${subdomain}/order/${existing.publicOrderToken}`,
          replayed: true,
        });
      }
    }

const activePaymentMethods = await prisma.tenantPaymentMethod.findMany({
      where: {
        tenantId: tenant.id,
        isActive: true,
        ...(!b2bContext?.contract.allowCredit ? { method: { not: "CREDIT" } } : {}),
      },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    const selectedPaymentMethod = paymentMethodId
      ? activePaymentMethods.find((method) => method.id === paymentMethodId)
      : null;
    if (paymentMethodId && !selectedPaymentMethod) {
      return NextResponse.json({ error: "Metode pembayaran tidak tersedia." }, { status: 400 });
    }
    if (activePaymentMethods.length > 0 && !selectedPaymentMethod) {
      return NextResponse.json({ error: "Pilih metode pembayaran." }, { status: 400 });
    }
    const isB2bCredit = Boolean(b2bContext && selectedPaymentMethod?.method === "CREDIT");

    const normalizedItems = (items as CheckoutItemInput[])
      .map((item) => ({
        productId: item.productId || item.id,
        offeringId: item.offeringId ?? null,
        variantId: item.variantId ?? null,
        quantity: Number(item.quantity || 0),
        grindSize: item.grindSize ?? "WHOLE_BEAN",
        customGrindLabel: item.customGrindLabel ?? null,
      }))
      .filter((item) => {
        if (item.offeringId) return Boolean(item.variantId);
        return Boolean(item.productId && Number.isInteger(item.quantity) && item.quantity > 0);
      });

    if (normalizedItems.length !== items.length) {
      return NextResponse.json({ error: "Item checkout tidak valid" }, { status: 400 });
    }

    const productLines = normalizedItems.filter((item) => !item.offeringId);
    const offeringLines = normalizedItems.filter((item) => item.offeringId);

    const productIds = Array.from(new Set(productLines.map((item) => item.productId!)));
    const products = await prisma.product.findMany({
      where: {
        tenantId: tenant.id,
        id: { in: productIds },
        type: "FINISHED_GOODS",
        isActive: true,
        ...(!b2bContext ? { price: { gt: 0 } } : {}),
      },
      select: {
        id: true,
        name: true,
        price: true,
        priceSilver: true,
        priceGold: true,
        netWeightGrams: true,
        recipes: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { storefrontGrindOptions: true },
        },
      },
    });

    if (products.length !== productIds.length) {
      return NextResponse.json({ error: "Ada produk yang tidak valid atau tidak aktif" }, { status: 400 });
    }

    // Batch HPP lookup to avoid N+1 queries
    const lastBatches = await prisma.productionBatch.findMany({
      where: {
        tenantId: tenant.id,
        status: "COMPLETED",
        outputProductId: { in: products.map(p => p.id) },
      },
      orderBy: { producedAt: "desc" },
      select: { outputProductId: true, hppPerUnit: true },
      distinct: ["outputProductId"],
    });
    const hppByProduct = new Map(
      lastBatches.map(b => [b.outputProductId, Number(b.hppPerUnit || 0)])
    );

    // ── Coffee offering lines: validate offering + variant, resolve the
    // lineage roasted bean product that will carry the kg reservation. ──
    let offeringById = new Map<string, CoffeeOfferingRow>();
    const lineageById = new Map<string, { productId: string; avgCostPerKg: number | null }>();
    if (offeringLines.length > 0) {
      const offeringIds = Array.from(new Set(offeringLines.map((line) => line.offeringId!)));
      const offeringRows = await findOfferingRows(tenant.id, offeringIds);
      if (offeringRows.length !== offeringIds.length) {
        return NextResponse.json({ error: "Ada penawaran yang tidak valid atau tidak aktif" }, { status: 400 });
      }
      offeringById = new Map(offeringRows.map((offering) => [offering.id, offering]));

      for (const offering of offeringRows) {
        try {
          const resolution = await resolveOfferingLineage(prisma, {
            ...offering,
            tenantId: tenant.id,
          });
          lineageById.set(offering.id, {
            productId: resolution.productId,
            avgCostPerKg: resolution.avgCostPerKg,
          });
        } catch (error) {
          return NextResponse.json(
            {
              error: error instanceof LineageResolutionError
                ? error.message
                : "Belum ada stok roasted bean untuk penawaran ini. Silakan hubungi roastery.",
            },
            { status: 400 },
          );
        }
      }
    }

    // 2. Kalkulasi Subtotal & Buat Items Array dari data server
    let subtotal = 0;
    const invoiceItemsData: InvoiceItemCreateData[] = [];
    
    const productById = new Map(products.map((product) => [product.id, product]));
    for (const line of productLines) {
      const product = productById.get(line.productId!);
      if (!product) {
        return NextResponse.json({ error: "Produk checkout tidak ditemukan" }, { status: 400 });
      }
      const qty = line.quantity;
      let preparation;
      try {
        preparation = normalizeStorefrontGrind(
          line.grindSize,
          line.customGrindLabel ?? undefined,
          product.recipes[0]?.storefrontGrindOptions ?? ["WHOLE_BEAN"],
        );
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Pilihan gilingan tidak valid" },
          { status: 400 },
        );
      }
      const b2bPrice = b2bContext
        ? resolveB2bCatalogPrice({
            price: Number(product.price ?? 0),
            priceSilver: Number(product.priceSilver ?? 0),
            priceGold: Number(product.priceGold ?? 0),
          }, b2bContext.customer.tier, qty, b2bContext.priceBreaksByProduct.get(product.id))
        : null;
      const unitPrice = b2bPrice?.unitPrice ?? Number(product.price || 0);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        return NextResponse.json({ error: `Harga untuk ${product.name} belum tersedia.` }, { status: 400 });
      }
      const itemSub = unitPrice * qty;
      subtotal += itemSub;
      
      invoiceItemsData.push({
        tenantId: tenant.id,
        productId: product.id,
        quantity: qty,
        unitPrice: unitPrice,
        discount: 0,
        subtotal: itemSub,
        hpp: hppByProduct.get(product.id) || 0,
        grindSize: preparation.grindSize,
        customGrindLabel: preparation.customGrindLabel,
        contractPriceId: b2bPrice?.contractPriceId ?? null,
        priceSource: b2bPrice?.priceSource ?? "BASE",
      });
    }

    for (const line of offeringLines) {
      const offering = offeringById.get(line.offeringId!);
      const variant = offering?.variants.find((v: { id: string }) => v.id === line.variantId);
      const lineage = offering ? lineageById.get(offering.id) : undefined;
      if (!offering || !variant || !lineage) {
        return NextResponse.json(
          { error: "Belum ada stok roasted bean untuk penawaran ini. Silakan hubungi roastery." },
          { status: 400 },
        );
      }
      const qty = line.quantity;
      let allowed = (offering.grindOptions ?? ["WHOLE_BEAN"]) as StorefrontGrindSize[];
      if (!offering.allowCustomGrind) allowed = allowed.filter((g) => g !== "CUSTOM");
      let preparation;
      try {
        preparation = normalizeStorefrontGrind(
          line.grindSize,
          line.customGrindLabel ?? undefined,
          allowed.length > 0 ? allowed : ["WHOLE_BEAN"],
        );
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Pilihan gilingan tidak valid" },
          { status: 400 },
        );
      }
      const netWeightGrams = Number(variant.netWeightGrams);
      const unitPrice = Number(variant.unitPrice);
      const itemSub = unitPrice * qty;
      subtotal += itemSub;

      invoiceItemsData.push({
        tenantId: tenant.id,
        productId: lineage.productId,
        quantity: qty,
        unitPrice,
        discount: 0,
        subtotal: itemSub,
        // Proxy cost basis until packing flows compute exact COGS (next commit):
        // WAC per kg of the lineage roasted bean × package net weight.
        hpp: Math.round((Number(lineage.avgCostPerKg ?? 0) * netWeightGrams / 1000) * 100) / 100,
        grindSize: preparation.grindSize,
        customGrindLabel: preparation.customGrindLabel,
        offeringId: offering.id,
        offeringVariantId: variant.id,
        offeringName: offering.name,
        packageName: variant.packageName,
        netWeightGrams,
        roastLevel: offering.roastLevel ?? null,
        contractPriceId: null,
        priceSource: "BASE",
      });
    }

let tax: number, shippingCost: number, grandTotal: number;
    try {
      const totals = calculateStorefrontTotals(subtotal, shippingMethod, {
        pickupEnabled: tenant.storefrontPickupEnabled,
        deliveryEnabled: tenant.storefrontDeliveryEnabled,
        flatShippingRate: Number(tenant.storefrontFlatShippingRate),
        freeShippingMinimum: tenant.storefrontFreeShippingMinimum === null
          ? null
          : Number(tenant.storefrontFreeShippingMinimum),
        taxRate: Number(tenant.storefrontTaxRate),
      });
      tax = totals.tax;
      shippingCost = totals.shippingCost;
      grandTotal = totals.grandTotal;
    } catch (err) {
      if (err instanceof Error) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json({ error: "Konfigurasi pengiriman tidak valid" }, { status: 400 });
    }
    if (grandTotal <= 0) {
      return NextResponse.json({ error: "Total checkout tidak valid" }, { status: 400 });
    }

    // 3. Prepare Midtrans integration (if configured)
    const hasMidtrans = !selectedPaymentMethod && tenant.midtransServerKey && tenant.midtransClientKey;
    let midtransOrderId: string | null = null;
    let paymentUrl: string | null = null;
    let snapToken: string | null = null;

    const checkoutAt = getCurrentDate();
    const invoiceCode = `INV-${tenant.code}-${checkoutAt.getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const orderPublicToken = crypto.randomBytes(24).toString("base64url");
    const b2bDueDate = isB2bCredit
      ? addDays(checkoutAt, b2bContext?.contract.paymentTermsDays ?? 0)
      : null;
    const paymentExpiresAt = b2bDueDate
      ?? new Date(checkoutAt.getTime() + tenant.storefrontReservationMinutes * 60 * 1000);

    // Derive deterministic Midtrans order ID upfront (for idempotency)
    if (hasMidtrans) {
      midtransOrderId = rawIdempotencyKey
        ? `${tenant.code}-${crypto.createHash("sha256").update(rawIdempotencyKey).digest("hex").slice(0, 24)}`
        : `${invoiceCode}-${Date.now().toString().slice(-6)}`;
    }

    // NATIONAL COURIER REVALIDATION (before durable transaction)
    // For COURIER shipping method, re-validate the shipping quote with RajaOngkir
    // to ensure the rate hasn't changed and the quote is still valid.
    // Any change → HTTP 409 SHIPPING_RATE_CHANGED with ZERO durable state
    // (no Invoice, no reservation, no Payment, no Midtrans state).
    let authoritativeShippingCost = shippingCost;
    let authoritativeShippingMethod = shippingMethod;
    let verifiedQuote: ShippingQuotePayload | null = null;
    let verifiedDestination: OriginSelectionPayload | null = null;

    if (shippingMethod === "COURIER") {
      const shippingQuoteToken = parsedBody.data.shippingQuoteToken;
      const destinationToken = parsedBody.data.destinationToken;
      if (!shippingQuoteToken || !destinationToken) {
        return NextResponse.json(
          { error: "Kurir nasional memerlukan token quote dan token tujuan" },
          { status: 400 },
        );
      }

      // 1. Verify quote token (tamper-evident, short TTL).
      const quotePayload = verifyShippingQuoteToken(shippingQuoteToken);
      if (!quotePayload) {
        return NextResponse.json(
          { error: "Token quote pengiriman tidak valid atau kadaluwarsa" },
          { status: 400 },
        );
      }

      // 2. Verify destination token (tamper-evident, tenant-bound).
      const destinationPayload = verifyOriginSelectionToken(destinationToken);
      if (!destinationPayload) {
        return NextResponse.json(
          { error: "Token tujuan tidak valid atau kadaluwarsa" },
          { status: 400 },
        );
      }

      // 3. Tenant isolation: both tokens must belong to THIS tenant and the
      // destination token must match the destination bound into the quote.
      if (quotePayload.tenantId !== tenant.id || destinationPayload.tenantId !== tenant.id) {
        return NextResponse.json(
          { error: "Token pengiriman tidak valid untuk toko ini" },
          { status: 400 },
        );
      }
      if (quotePayload.destination.providerId !== destinationPayload.providerId) {
        return NextResponse.json(
          { error: "Token tujuan tidak cocok dengan token quote" },
          { status: 400 },
        );
      }

      // 4. Reload tenant shipping settings to ensure they haven't changed.
      const currentTenant = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: {
          nationalCourierEnabled: true,
          rajaOngkirOriginId: true,
          rajaOngkirCourierCodes: true,
          rajaOngkirTareGrams: true,
          rajaOngkirOriginLabel: true,
          rajaOngkirOriginProvince: true,
          rajaOngkirOriginCity: true,
          rajaOngkirOriginDistrict: true,
          rajaOngkirOriginSubdistrict: true,
          rajaOngkirOriginPostalCode: true,
        },
      });

      if (!currentTenant) {
        return NextResponse.json({ error: "Toko tidak ditemukan" }, { status: 404 });
      }
      if (!currentTenant.nationalCourierEnabled) {
        return NextResponse.json(
          { error: "Kurir nasional telah dinonaktifkan", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }
      if (!currentTenant.rajaOngkirOriginId) {
        return NextResponse.json(
          { error: "Asal pengiriman tidak dikonfigurasi", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      // 5. Origin must be unchanged.
      if (quotePayload.origin.providerId !== currentTenant.rajaOngkirOriginId) {
        return NextResponse.json(
          { error: "Asal pengiriman telah berubah, silakan hitung ulang ongkir", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      // 6. Courier must still be allowed by the tenant whitelist.
      const allowedCouriers = (Array.isArray(currentTenant.rajaOngkirCourierCodes)
        ? currentTenant.rajaOngkirCourierCodes.filter((code): code is string => typeof code === "string")
        : [])
        .map((code: string) => code.trim())
        .filter((code: string) => code.length > 0);
      if (!allowedCouriers.includes(quotePayload.courierCode)) {
        return NextResponse.json(
          { error: "Kurir yang dipilih tidak lagi diizinkan", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      // 7. Recompute canonical shipment weight + cart fingerprint from the
      // authoritative cart rows (identity, quantity, net weight, unit price,
      // tare). Any drift invalidates the quote.
      const weightLines = normalizedItems.map((item) =>
        item.variantId
          ? { productId: "", offeringVariantId: item.variantId, quantity: item.quantity }
          : { productId: item.productId!, offeringVariantId: null, quantity: item.quantity }
      );

      let currentWeight;
      try {
        currentWeight = await calculateShipmentWeightForTenant(tenant.id, weightLines);
      } catch {
        return NextResponse.json(
          { error: "Berat kirim berubah, silakan hitung ulang ongkir", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      const currentTareGrams = currentTenant.rajaOngkirTareGrams ?? 0;
      const fingerprintLines = normalizedItems.map((item) => {
        if (item.variantId) {
          const offering = offeringById.get(item.offeringId!);
          const variant = offering?.variants.find((v: { id: string }) => v.id === item.variantId);
          if (!variant) {
            return null;
          }
          return {
            productId: "",
            offeringVariantId: item.variantId,
            quantity: item.quantity,
            netWeightGrams: Number(variant.netWeightGrams),
            unitPrice: Number(variant.unitPrice),
          };
        }
        const product = productById.get(item.productId!);
        if (!product) {
          return null;
        }
        return {
          productId: item.productId!,
          offeringVariantId: null,
          quantity: item.quantity,
          netWeightGrams: Number(product.netWeightGrams),
          unitPrice: Number(product.price || 0),
        };
      });

      if (fingerprintLines.some((line) => line === null)) {
        return NextResponse.json(
          { error: "Item keranjang berubah, silakan hitung ulang ongkir", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      const recomputedFingerprint = createCartFingerprint({
        tenantId: tenant.id,
        originProviderId: currentTenant.rajaOngkirOriginId,
        destinationProviderId: destinationPayload.providerId,
        tareGrams: currentTareGrams,
        lines: fingerprintLines as NonNullable<typeof fingerprintLines[number]>[],
      });

      if (recomputedFingerprint !== quotePayload.cartFingerprint) {
        return NextResponse.json(
          { error: "Keranjang atau ongkir berubah, silakan hitung ulang", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      const currentShipmentWeightGrams = Math.round(currentWeight.shipmentWeightGrams);
      if (currentShipmentWeightGrams !== quotePayload.shipmentWeightGrams) {
        return NextResponse.json(
          { error: "Berat kirim berubah, silakan hitung ulang ongkir", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      // 8. Re-query RajaOngkir for the authoritative current rate.
      let config;
      try {
        config = await getRajaOngkirClientConfig();
      } catch (error) {
        if (error instanceof ShippingProviderError) {
          return NextResponse.json(
            { error: "Layanan ongkir sedang tidak tersedia, silakan coba lagi" },
            { status: 503 },
          );
        }
        throw error;
      }

      let currentRates;
      try {
        currentRates = await calculateDomesticCost(
          {
            origin: currentTenant.rajaOngkirOriginId,
            destination: destinationPayload.providerId,
            weight: currentShipmentWeightGrams,
            courier: quotePayload.courierCode,
          },
          config,
        );
      } catch (error) {
        if (error instanceof ShippingProviderError) {
          // Controlled, retryable provider failure → ZERO durable checkout state.
          return NextResponse.json(
            { error: "Layanan ongkir sedang tidak tersedia, silakan coba lagi" },
            { status: 503 },
          );
        }
        throw error;
      }

      const currentRate = currentRates.find(
        (r) => r.courierCode === quotePayload.courierCode && r.serviceCode === quotePayload.serviceCode,
      );
      if (!currentRate || !Number.isFinite(currentRate.cost) || currentRate.cost <= 0) {
        return NextResponse.json(
          { error: "Layanan pengiriman tidak lagi tersedia", code: "SHIPPING_RATE_CHANGED" },
          { status: 409 },
        );
      }

      // 9. Compare the current rate with the quoted rate (integer Rupiah).
      const currentCost = Math.round(currentRate.cost);
      if (currentCost !== quotePayload.cost) {
        return NextResponse.json(
          {
            error: "Ongkos kirim telah berubah, silakan hitung ulang",
            code: "SHIPPING_RATE_CHANGED",
            currentCost,
            quotedCost: quotePayload.cost,
          },
          { status: 409 },
        );
      }

      // Rate matches → use the authoritative rate (never the client value).
      authoritativeShippingCost = currentCost;
      authoritativeShippingMethod = "COURIER";
      verifiedQuote = quotePayload;
      verifiedDestination = destinationPayload;
    }

    // Recalculate grandTotal with the authoritative shipping cost.
    grandTotal = subtotal + tax + authoritativeShippingCost;
    if (grandTotal <= 0) {
      return NextResponse.json({ error: "Total checkout tidak valid" }, { status: 400 });
    }
    let replayed = false;
    const invoice = await withSerializableRetry(prisma, async (tx) => {
      let customer = b2bContext
        ? await tx.customer.findFirst({
            where: { id: b2bContext.customer.id, tenantId: tenant.id, isActive: true },
          })
        : await tx.customer.findFirst({
            where: { tenantId: tenant.id, phone: customerPhone },
          });

      if (!customer && !b2bContext) {
        customer = await tx.customer.create({
          data: {
            code: `CST-${tenant.code}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
            name: customerName,
            phone: customerPhone,
            email: customerEmail || null,
            address: customerAddress,
            tenantId: tenant.id,
          }
        });
      }
      if (!customer) throw new Error("Customer partner tidak lagi aktif.");

      const inv = await tx.invoice.create({
        data: {
          code: invoiceCode,
          operationKey: rawIdempotencyKey,
          customerId: customer.id,
          tenantId: tenant.id,
          createdById,
          status: "ISSUED",
          dueDate: b2bDueDate,
          subtotal,
          discount: 0,
          tax,
          taxRate: Number(tenant.storefrontTaxRate),
          taxType: tax > 0 ? "PPN" : "NONE",
          taxableAmount: subtotal,
          shippingCost: authoritativeShippingCost,
          shippingMethod: authoritativeShippingMethod || "PICKUP",
          shippingAddress: shippingMethod === "PICKUP" ? null : customerAddress || null,
          courierName: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.courierName ?? null : null,
          shippingCourierCode: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.courierCode ?? null : null,
          shippingServiceCode: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.serviceCode ?? null : null,
          shippingServiceName: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.serviceName ?? null : null,
          shippingEtd: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.etd ?? null : null,
          shipmentWeightGrams: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.shipmentWeightGrams ?? null : null,
          shippingSnapshot: authoritativeShippingMethod === "COURIER" && verifiedQuote ? {
            version: 1,
            provider: "RAJAONGKIR",
            origin: verifiedQuote.origin,
            destination: verifiedQuote.destination,
            courierCode: verifiedQuote.courierCode,
            courierName: verifiedQuote.courierName,
            serviceCode: verifiedQuote.serviceCode,
            serviceName: verifiedQuote.serviceName,
            cost: verifiedQuote.cost,
            etd: verifiedQuote.etd,
            shipmentWeightGrams: verifiedQuote.shipmentWeightGrams,
            tareGrams: verifiedQuote.tareGrams,
            cartFingerprint: verifiedQuote.cartFingerprint,
          } : Prisma.DbNull,
          cartFingerprint: authoritativeShippingMethod === "COURIER" ? verifiedQuote?.cartFingerprint ?? null : null,
          destinationProviderId: authoritativeShippingMethod === "COURIER" ? verifiedDestination?.providerId ?? null : null,
          destinationSnapshot: authoritativeShippingMethod === "COURIER" && verifiedDestination ? {
            providerId: verifiedDestination.providerId,
            label: verifiedDestination.label,
            province: verifiedDestination.province,
            city: verifiedDestination.city,
            district: verifiedDestination.district,
            subdistrict: verifiedDestination.subdistrict,
            postalCode: verifiedDestination.postalCode,
          } : Prisma.DbNull,
          grandTotal,
          publicOrderToken: orderPublicToken,
          reservationExpiresAt: paymentExpiresAt,
          midtransOrderId,
          paymentUrl,
          paymentMethod: selectedPaymentMethod?.method ?? null,
          purchaseOrderReference: b2bContext ? parsedBody.data.purchaseOrderReference || null : null,
          salesChannel: b2bContext ? "B2B_DIRECT" : "STOREFRONT",
          items: {
            create: invoiceItemsData
          }
        }
      });

      // Aggregate per lineage product: product lines reserve stock units;
      // offering lines preserve package count and reserve exact kg on the RB.
      const reserveMap = new Map<string, { productId: string; quantity: number; quantityKg: number | null }>();
      for (const item of invoiceItemsData) {
        const entry = reserveMap.get(item.productId) ?? { productId: item.productId, quantity: 0, quantityKg: null };
        if (item.offeringId && item.netWeightGrams) {
          const { units, quantityKg } = offeringReserveKg(item.quantity, item.netWeightGrams);
          entry.quantity += units;
          entry.quantityKg = (entry.quantityKg ?? 0) + quantityKg;
        } else {
          entry.quantity += item.quantity;
        }
        reserveMap.set(item.productId, entry);
      }
      const reservation = await reserveInvoiceStock(tx, {
        tenantId: tenant.id,
        invoiceId: inv.id,
        expiresAt: paymentExpiresAt,
        items: Array.from(reserveMap.values()),
      });
      if (reservation.hasShortage) {
        await tx.invoice.update({ where: { id: inv.id }, data: { fulfillmentStatus: "NEEDS_PRODUCTION" } });
      } else if (isB2bCredit) {
        await tx.invoice.update({ where: { id: inv.id }, data: { fulfillmentStatus: "READY_TO_PACK" } });
      }

      if (selectedPaymentMethod && selectedPaymentMethod.method !== "CREDIT") {
        const publicMethod = toPublicPaymentMethod(selectedPaymentMethod);
        await tx.paymentSubmission.create({
          data: {
            tenantId: tenant.id,
            invoiceId: inv.id,
            paymentMethodId: selectedPaymentMethod.id,
            publicToken: orderPublicToken,
            provider: selectedPaymentMethod.provider,
            method: selectedPaymentMethod.method,
            amount: grandTotal,
            destination: paymentDestinationSnapshot(publicMethod),
            expiresAt: paymentExpiresAt,
          },
        });
      }

      await recordAudit(tx, {
        tenantId: tenant.id,
        userId: createdById,
        action: "CREATE_PUBLIC",
        entityType: "Invoice",
        entityId: inv.id,
        after: {
          code: inv.code,
          status: inv.status,
          grandTotal: Number(inv.grandTotal),
        },
        metadata: {
          itemCount: invoiceItemsData.length,
          channel: b2bContext ? "B2B_DIRECT" : "STOREFRONT",
          contractId: b2bContext?.contract.id ?? null,
        },
      });

      return inv;
    }).catch(async (error: unknown) => {
      const prismaCode = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
      if (prismaCode !== "P2002" || !rawIdempotencyKey) throw error;
      const existing = await prisma.invoice.findUnique({
        where: {
          tenantId_operationKey: {
            tenantId: tenant.id,
            operationKey: rawIdempotencyKey,
          },
        },
      });
      if (!existing) throw error;
      replayed = true;
      return existing;
    });

    // 5. Recover or initialize Midtrans AFTER invoice is committed (idempotent)
    if (hasMidtrans) {
      // Prepare line items with exact prices for invariant-safe rounding
      const midtransLines = invoiceItemsData.map(item => {
        const product = productById.get(item.productId);
        return {
          id: item.offeringId
            ? `OFF-${item.offeringId}-${item.offeringVariantId}`.substring(0, 50)
            : `${item.productId}-${item.grindSize}`.substring(0, 50),
          price: item.unitPrice,  // exact price
          quantity: item.quantity,
          name: item.offeringId
            ? `${item.offeringName} ${item.packageName}`.substring(0, 50)
            : `${product?.name || "Product"} - ${item.grindSize}`.substring(0, 50),
        };
      });

      const safeItemDetails = buildMidtransItemDetails(
        midtransLines,
        grandTotal,
        authoritativeShippingCost,
        tax
      );

      // Use recovery logic that handles Windows A/B/C/D
      const recovery = await recoverOrInitializeMidtrans(
        {
          midtransServerKey: tenant.midtransServerKey!,
          midtransClientKey: tenant.midtransClientKey || "",
          midtransIsProduction: tenant.midtransIsProduction
        },
        {
          id: invoice.id,
          code: invoice.code,
          midtransOrderId: invoice.midtransOrderId,
          paymentUrl: invoice.paymentUrl,
          snapToken: null, // Invoice model doesn't have snapToken field
          grandTotal,
          customerName,
          customerPhone,
          customerEmail: customerEmail ?? null,
          itemDetails: safeItemDetails,
        }
      );

      snapToken = recovery.snapToken;
      paymentUrl = recovery.paymentUrl;

      // Persist recovered/initialized Midtrans result
      if (recovery.action !== "noop" && recovery.action !== "terminal" && recovery.paymentUrl) {
        try {
          await prisma.invoice.update({
            where: { id: invoice.id },
            data: { midtransOrderId: invoice.midtransOrderId, paymentUrl: recovery.paymentUrl },
          });
        } catch (updateError) {
          // Critical: Payment URL update failed but invoice was already created.
          // Log this as a serious error for recovery/manual intervention.
          logServerError("tenant.checkout.midtrans.persistence", updateError, {
            requestId,
            subdomain,
            invoiceId: invoice.id,
            midtransOrderId: invoice.midtransOrderId,
            action: recovery.action,
            severity: "CRITICAL - Invoice created but Midtrans payment URL not saved",
          });
          // Do not throw - invoice was already committed. Client already has success response.
          // Next query of invoice will trigger recovery again via the loading pattern.
        }
      }

      // Log recovery action for observability
      if (recovery.action !== "noop") {
        logServerError("tenant.checkout.midtrans.recovery", new Error(`Midtrans recovery action: ${recovery.action}`), {
          requestId,
          subdomain,
          invoiceId: invoice.id,
          midtransOrderId: invoice.midtransOrderId,
          action: recovery.action,
        });
      }
    }

    revalidatePath("/penjualan");
    revalidatePath("/inventory");

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
    const resolvedPublicOrderToken = invoice.publicOrderToken ?? orderPublicToken;
    const publicOrderUrl = `${appUrl}/tenant/${subdomain}/order/${resolvedPublicOrderToken}`;
    if (!replayed) {
      const notifications = [];
      if (customerEmail) {
        notifications.push(sendInvoiceEmail(customerEmail, invoice.code, publicOrderUrl));
      }
      notifications.push(sendInvoiceWhatsApp(customerPhone, invoice.code, publicOrderUrl));

      if (tenant.contactEmail) {
        notifications.push(sendNewOrderNotificationEmail({
          to: tenant.contactEmail,
          tenantName: tenant.name,
          invoiceCode: invoice.code,
          customerName,
          grandTotal,
          orderUrl: `${appUrl}/penjualan`,
        }));
      }
      if (tenant.whatsappNumber) {
        notifications.push(sendNewOrderNotificationWhatsApp({
          phone: tenant.whatsappNumber,
          tenantName: tenant.name,
          invoiceCode: invoice.code,
          customerName,
          grandTotal,
          orderUrl: `${appUrl}/penjualan`,
        }));
      }

      await Promise.allSettled(notifications);
    }

return NextResponse.json({
      success: true,
      invoice: {
        code: invoice.code,
        status: invoice.status,
        grandTotal: Number(invoice.grandTotal),
      },
      snapToken,
      paymentUrl,
      orderUrl: `/tenant/${subdomain}/order/${resolvedPublicOrderToken}`,
      replayed,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfter) } },
      );
    }
    logServerError("tenant.checkout", error, {
      requestId,
      subdomain: tenantSubdomain,
    });
    return internalErrorResponse(requestId);
  }
}
