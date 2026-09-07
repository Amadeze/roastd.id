import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { TenantPortalClient } from "./_components/TenantPortalClient";
import { getTenantAccessState } from "@/lib/subscription";
import { planHasFeature } from "@/lib/plans";
import { resolveTenantPortalTheme } from "@/features/portal-theme/resolver";
import { tenantStorefrontUrl } from "@/lib/tenant-host";
import { loadStorefrontCatalog, loadPublicCuppingSessions } from "@/lib/storefront-catalog";
import {
  buildStorefrontMetadata,
  buildStorefrontStructuredData,
  serializeStorefrontStructuredData,
} from "@/lib/storefront-seo";
import { verifyB2bAccessToken } from "@/lib/b2b-access";
import {
  loadStorefrontB2bContext,
  resolveB2bCatalogPrice,
} from "@/lib/storefront-b2b";

export const dynamic = "force-dynamic";

interface TenantPageProps {
  params: Promise<{
    subdomain: string;
  }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

const getStorefrontTenant = cache((subdomain: string) =>
  prisma.tenant.findUnique({
    where: { subdomain },
    select: {
      id: true,
      name: true,
      subdomain: true,
      themeColor: true,
      logoUrl: true,
      heroImageUrl: true,
      heroText: true,
      backgroundImageUrl: true,
      whatsappNumber: true,
      contactEmail: true,
      instagramHandle: true,
      aboutText: true,
      catalogTitle: true,
      catalogSubtitle: true,
      footerText: true,
      problemStatement: true,
      solutionStatement: true,
      uspText: true,
      features: true,
      testimonials: true,
      faqs: true,
      layoutStyle: true,
      fontFamily: true,
      themeMode: true,
      borderRadius: true,
      animationStyle: true,
      animationDirection: true,
      iconStyle: true,
      themeConfig: true,
      isActive: true,
      subscriptionTier: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      nextBillingDate: true,
      storefrontPickupEnabled: true,
      storefrontDeliveryEnabled: true,
      storefrontFlatShippingRate: true,
      storefrontFreeShippingMinimum: true,
      storefrontTaxRate: true,
      tenantPaymentMethods: {
        where: { isActive: true },
        orderBy: [{ displayOrder: "asc" as const }, { createdAt: "asc" as const }],
        select: {
          id: true,
          provider: true,
          method: true,
          label: true,
          bankName: true,
          accountNumber: true,
          accountHolder: true,
          qrisImageUrl: true,
          instructions: true,
          requireProof: true,
        },
      },
    },
  }),
);

async function loadPortalThemeCompat(tenantId: string) {
  try {
    return await prisma.portalTheme.findUnique({
      where: { tenantId },
      select: {
        draftConfig: true,
        publishedConfig: true,
        publishedAt: true,
      },
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params, searchParams }: TenantPageProps): Promise<Metadata> {
  const [{ subdomain }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({}),
  ]);
  const tenant = await getStorefrontTenant(subdomain);

  if (
    !tenant ||
    getTenantAccessState(tenant) !== "ACTIVE" ||
    !planHasFeature(tenant.subscriptionTier, "STOREFRONT")
  ) return {};
  const preview = (resolvedSearchParams as Record<string, string | string[] | undefined>).preview;
  const b2b = (resolvedSearchParams as Record<string, string | string[] | undefined>).b2b;
  return buildStorefrontMetadata({
    tenant,
    canonicalUrl: tenantStorefrontUrl(subdomain),
    isPreview: preview === "1" || preview === "true" || typeof b2b === "string",
  });
}

export default async function TenantB2BPortal({ params, searchParams }: TenantPageProps) {
  const resolvedParams = await params;
  const subdomain = resolvedParams.subdomain;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const isPreviewMode = resolvedSearchParams?.preview === "1" || resolvedSearchParams?.preview === "true";
  const b2bAccessToken = typeof resolvedSearchParams?.b2b === "string" ? resolvedSearchParams.b2b : null;

  const tenant = await getStorefrontTenant(subdomain);

  if (
    !tenant ||
    getTenantAccessState(tenant) !== "ACTIVE" ||
    !planHasFeature(tenant.subscriptionTier, "STOREFRONT")
  ) {
    notFound();
  }

  // Next.js App Router Server -> Client serialization doesn't support Prisma Decimal
  // Only storefront fields are serialized; internal costs and credentials stay server-side.

  let b2bContext = null;
  if (b2bAccessToken && !isPreviewMode) {
    try {
      const access = verifyB2bAccessToken(b2bAccessToken);
      if (access) b2bContext = await loadStorefrontB2bContext(prisma, tenant.id, access);
    } catch {
      b2bContext = null;
    }
  }

  // Canonical catalog (products + coffee offerings dengan ketersediaan kg real-time)
  // — payload yang sama dipakai customizer preview via /api/portal-theme/products.
  let catalog: { products: any[]; offerings: any[] } = { products: [], offerings: [] };
  let portalTheme: any = null;
  let cuppingResult: any[] = [];

  try {
    const [catalogResult, portalThemeResult, cuppingSessions] = await Promise.all([
      loadStorefrontCatalog(prisma, tenant.id, b2bContext ? {
        b2b: {
          customerTier: b2bContext!.customer.tier,
          priceBreaksByProduct: b2bContext!.priceBreaksByProduct,
        },
      } : {}),
      loadPortalThemeCompat(tenant.id),
      loadPublicCuppingSessions(prisma, tenant.id),
    ]);
    catalog = catalogResult;
    portalTheme = portalThemeResult;
    cuppingResult = cuppingSessions;
  } catch (catalogError) {
    console.error("[storefront] Failed to load catalog/theme:", catalogError);
    // Continue with empty catalog/theme to prevent total failure
    catalog = { products: [], offerings: [] };
    portalTheme = null;
    cuppingResult = [];
  }

  // Resolve the active theme config (draft for preview, published for public view)
  let resolvedThemeConfig: any = null;
  try {
    resolvedThemeConfig = resolveTenantPortalTheme({
      portalTheme,
      legacyTenantFields: tenant as Record<string, unknown>,
      mode: isPreviewMode ? "customizer" : "public",
    });
  } catch (themeError) {
    console.error("[storefront] Failed to resolve theme:", themeError);
    // Fallback to default theme
    const { DEFAULT_PORTAL_THEME_CONFIG } = await import("@/features/portal-theme/defaults/default-config");
    resolvedThemeConfig = structuredClone(DEFAULT_PORTAL_THEME_CONFIG);
  }

  const serializedTenant = {
    name: tenant.name,
    subdomain: tenant.subdomain,
    themeColor: tenant.themeColor,
    logoUrl: tenant.logoUrl,
    heroImageUrl: tenant.heroImageUrl,
    heroText: tenant.heroText,
    backgroundImageUrl: tenant.backgroundImageUrl,
    whatsappNumber: tenant.whatsappNumber,
    contactEmail: tenant.contactEmail,
    instagramHandle: tenant.instagramHandle,
    aboutText: tenant.aboutText,
    catalogTitle: tenant.catalogTitle,
    catalogSubtitle: tenant.catalogSubtitle,
    footerText: tenant.footerText,
    problemStatement: tenant.problemStatement,
    solutionStatement: tenant.solutionStatement,
    uspText: tenant.uspText,
    features: tenant.features,
    testimonials: tenant.testimonials,
    faqs: tenant.faqs,
    layoutStyle: tenant.layoutStyle,
    fontFamily: tenant.fontFamily,
    themeMode: tenant.themeMode,
    borderRadius: tenant.borderRadius,
    animationStyle: tenant.animationStyle,
    animationDirection: tenant.animationDirection,
    iconStyle: tenant.iconStyle,
    themeConfig: tenant.themeConfig,
    portalThemeConfig: resolvedThemeConfig,
    storefrontPickupEnabled: tenant.storefrontPickupEnabled,
    storefrontDeliveryEnabled: tenant.storefrontDeliveryEnabled,
    storefrontFlatShippingRate: Number(tenant.storefrontFlatShippingRate),
    storefrontFreeShippingMinimum: tenant.storefrontFreeShippingMinimum === null ? null : Number(tenant.storefrontFreeShippingMinimum),
    storefrontTaxRate: Number(tenant.storefrontTaxRate),
    paymentMethods: tenant.tenantPaymentMethods.filter((method) => (
      method.method !== "CREDIT" || Boolean(b2bContext?.contract.allowCredit)
    )),
    products: catalog.products,
    offerings: catalog.offerings,
    cuppingSessions: cuppingResult,
    b2bAccessInvalid: Boolean(b2bAccessToken && !b2bContext),
    b2bProfile: b2bContext ? {
      accessToken: b2bAccessToken,
      customer: b2bContext.customer,
      contract: {
        ...b2bContext.contract,
        endDate: b2bContext.contract.endDate?.toISOString() ?? null,
      },
      recentOrders: b2bContext.recentOrders.map((order) => ({
        id: order.id,
        code: order.code,
        issuedAt: order.issuedAt.toISOString(),
        grandTotal: order.grandTotal,
        purchaseOrderReference: order.purchaseOrderReference,
        items: order.items.flatMap((item) => {
          const product = catalog.products.find((candidate) => candidate.id === item.productId);
          if (!product || !item.product.isActive) return [];
          const resolvedPrice = resolveB2bCatalogPrice({
            price: product.retailPrice ?? product.price ?? 0,
            priceSilver: product.priceSilver ?? 0,
            priceGold: product.priceGold ?? 0,
          }, b2bContext.customer.tier, item.quantity, product.b2bPriceBreaks);
          return [{
            id: item.productId,
            productId: item.productId,
            code: item.product.code,
            name: item.product.name,
            imageUrl: item.product.imageUrl,
            price: resolvedPrice.unitPrice,
            quantity: item.quantity,
            grindSize: item.grindSize ?? "WHOLE_BEAN",
            customGrindLabel: item.customGrindLabel,
            basePrice: product.price,
            priceBreaks: product.b2bPriceBreaks ?? [],
          }];
        }),
      })),
    } : null,
  };

  // Type cast back to any or specific shape since Client component expects Decimal type structurally
  // (Prisma types on client actually accept numbers for Decimals usually, or we can just cast to any)
  const structuredData = !isPreviewMode && !b2bContext && resolvedThemeConfig.globalSettings.seo.structuredData
    ? serializeStorefrontStructuredData(buildStorefrontStructuredData({
        tenant,
        canonicalUrl: tenantStorefrontUrl(subdomain),
        products: catalog.products,
        offerings: catalog.offerings,
      }))
    : null;

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: structuredData }}
        />
      ) : null}
      <TenantPortalClient
        tenant={serializedTenant as any}
        isPreviewMode={isPreviewMode}
      />
    </>
  );
}
