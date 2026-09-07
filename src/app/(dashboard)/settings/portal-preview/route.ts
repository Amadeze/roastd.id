// =============================================================================
// PORTAL PREVIEW ROUTE � Renders portal with draft config for iframe preview
// =============================================================================

import { NextResponse } from "next/server";
import { getValidatedCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveTenantPortalTheme } from "@/features/portal-theme/resolver";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getValidatedCurrentUser();
    if (!user || user.role !== "OWNER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let portalTheme: any = null;
    try {
      portalTheme = await prisma.portalTheme.findUnique({
        where: { tenantId: user.tenantId },
      });
    } catch {
      // Table not yet migrated
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        subdomain: true,
        themeColor: true,
        heroImageUrl: true,
        heroText: true,
        backgroundImageUrl: true,
        aboutText: true,
        catalogTitle: true,
        catalogSubtitle: true,
        footerText: true,
        logoUrl: true,
        layoutStyle: true,
        fontFamily: true,
        themeMode: true,
        borderRadius: true,
        animationStyle: true,
        animationDirection: true,
        iconStyle: true,
        themeConfig: true,
        problemStatement: true,
        solutionStatement: true,
        uspText: true,
        features: true,
        testimonials: true,
        faqs: true,
        whatsappNumber: true,
        contactEmail: true,
        instagramHandle: true,
        name: true,
      },
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    const config = resolveTenantPortalTheme({
      portalTheme,
      legacyTenantFields: tenant as Record<string, unknown>,
      mode: "customizer",
    });

    // Return the config as JSON for the iframe to consume
    return NextResponse.json({ config });
  } catch (err) {
    console.error("[portal-preview]", err);
    return NextResponse.json({ error: "Failed to load preview" }, { status: 500 });
  }
}
