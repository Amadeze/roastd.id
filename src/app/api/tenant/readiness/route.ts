import { NextResponse } from "next/server";
import { requireCurrentUser, requireTenantPrisma } from "@/lib/auth";
import { isNextRedirectError } from "@/lib/api-auth";
import { calculateStorefrontReadiness } from "@/lib/storefront-readiness";

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const tenantId = user.tenantId;
    const prisma = await requireTenantPrisma();

    const [tenant, paymentMethods, products, offerings, portalTheme] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          logoUrl: true,
          heroImageUrl: true,
          heroText: true,
          whatsappNumber: true,
          contactEmail: true,
          instagramHandle: true,
          aboutText: true,
          catalogTitle: true,
          catalogSubtitle: true,
          portalTheme: {
            select: {
              draftConfig: true,
              publishedConfig: true,
            },
          },
        },
      }),
      prisma.tenantPaymentMethod.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, provider: true, method: true },
      }),
      prisma.product.findMany({
        where: { tenantId: tenantId, type: "FINISHED_GOODS", isActive: true },
        select: {
          id: true,
          imageUrl: true,
          description: true,
          origin: true,
          roastLevel: true,
        },
      }),
      prisma.coffeeOffering.findMany({
        where: { tenantId, isActive: true },
        select: { id: true },
      }),
      prisma.portalTheme.findUnique({
        where: { tenantId },
        select: { draftConfig: true, publishedConfig: true },
      }),
    ]);

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    const portalThemeConfig = portalTheme?.publishedConfig || portalTheme?.draftConfig;

    const toNull = (v: string | null | undefined) => (v ?? null);

    const readiness = calculateStorefrontReadiness({
      name: tenant.name,
      portalThemeConfig: portalThemeConfig as any,
      legacyFields: {
        logoUrl: toNull(tenant.logoUrl),
        heroImageUrl: toNull(tenant.heroImageUrl),
        heroText: toNull(tenant.heroText),
        whatsappNumber: toNull(tenant.whatsappNumber),
        contactEmail: toNull(tenant.contactEmail),
        instagramHandle: toNull(tenant.instagramHandle),
        aboutText: toNull(tenant.aboutText),
        catalogTitle: toNull(tenant.catalogTitle),
        catalogSubtitle: toNull(tenant.catalogSubtitle),
      },
      paymentMethods: paymentMethods.map((p) => ({
        id: p.id,
        provider: p.provider,
        method: p.method,
      })),
      products: products.map((p) => ({
        id: p.id,
        imageUrl: toNull(p.imageUrl),
        description: toNull(p.description),
        origin: toNull(p.origin),
        roastLevel: toNull(p.roastLevel),
      })),
      offerings: offerings.map((o) => ({ id: o.id })),
    });

    return NextResponse.json(readiness);
  } catch (error) {
    if (isNextRedirectError(error)) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    console.error("[readiness] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}