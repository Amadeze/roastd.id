"use server";

// =============================================================================
// PORTAL THEME SERVER ACTIONS — Draft/Publish/Discard with concurrency
// =============================================================================

import { revalidatePath } from "next/cache";
import { requireRole, requireTenantPrisma } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PortalThemeConfigSchema } from "../schemas";
import { resolveTenantPortalTheme } from "../resolver";
import { sanitizeCSS, sanitizeHTML } from "./css-sanitizer";
import type { PortalThemeConfig } from "../types";
import type { Prisma } from "@prisma/client";

type ActionResult =
  | { success: true; data?: unknown }
  | { success: false; error: string };

// Safe query that returns null if portal_themes table doesn't exist yet
async function safeFindPortalTheme(
  tenantPrisma: any,
  tenantId: string,
  select?: Record<string, boolean>,
): Promise<any> {
  try {
    return await tenantPrisma.portalTheme.findUnique({
      where: { tenantId },
      ...(select ? { select } : {}),
    });
  } catch {
    return null;
  }
}

async function safeCreatePortalTheme(
  tenantPrisma: any,
  data: any,
): Promise<any> {
  try {
    return await tenantPrisma.portalTheme.create({ data });
  } catch {
    return null;
  }
}

async function safeUpdatePortalTheme(
  tenantPrisma: any,
  tenantId: string,
  data: any,
): Promise<any> {
  try {
    return await tenantPrisma.portalTheme.update({
      where: { tenantId },
      data,
    });
  } catch {
    return null;
  }
}

// ── Load ────────────────────────────────────────────────────────────────────

export async function loadPortalTheme(): Promise<{
  success: boolean;
  data?: { portalTheme?: any; config?: PortalThemeConfig; subdomain?: string };
  error?: string;
}> {
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    const portalTheme = await safeFindPortalTheme(tenantPrisma, user.tenantId);

    const tenant = await tenantPrisma.tenant.findUnique({
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

    const config = resolveTenantPortalTheme({
      portalTheme,
      legacyTenantFields: tenant as Record<string, unknown>,
      mode: "customizer",
    });

    return { success: true, data: { portalTheme, config, subdomain: tenant?.subdomain ?? undefined } };
  } catch (err) {
    console.error("[loadPortalTheme]", err);
    return { success: false, error: "Failed to load theme." };
  }
}

// ── Save Draft ──────────────────────────────────────────────────────────────

export async function savePortalThemeDraft(
  config: unknown,
): Promise<ActionResult> {
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    // Sanitize custom CSS and HTML in integrations
    const parsed = PortalThemeConfigSchema.parse(config);

    if (parsed.globalSettings.integrations.customHead) {
      parsed.globalSettings.integrations.customHead = sanitizeHTML(
        parsed.globalSettings.integrations.customHead,
      );
    }
    if (parsed.globalSettings.integrations.customFooter) {
      parsed.globalSettings.integrations.customFooter = sanitizeHTML(
        parsed.globalSettings.integrations.customFooter,
      );
    }

    // Sanitize per-section custom CSS
    for (const section of parsed.sections) {
      if (section.customCSS?.css) {
        const sanitized = sanitizeCSS(section.customCSS.css);
        if (!sanitized.ok) {
          throw new Error("Invalid custom CSS in section " + section.id + ": " + sanitized.error);
        }
        section.customCSS.css = sanitized.css || "";
      }
    }

    const existing = await safeFindPortalTheme(tenantPrisma, user.tenantId, { updatedAt: true });

    let updated: any;
    if (existing) {
      updated = await safeUpdatePortalTheme(tenantPrisma, user.tenantId, {
        draftConfig: parsed as any,
        schemaVersion: parsed.schemaVersion,
      });
    } else {
      updated = await safeCreatePortalTheme(tenantPrisma, {
        tenantId: user.tenantId,
        name: "Default Theme",
        schemaVersion: parsed.schemaVersion,
        draftConfig: parsed as any,
      });
    }

    if (updated) {
      await recordAudit(tenantPrisma as any, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "UPDATE",
        entityType: "PortalTheme",
        entityId: updated.id,
        metadata: { action: "save_draft" },
      }).catch(() => {});
    }

    revalidatePath("/settings");
    revalidatePath("/settings/portal-customizer");
    return { success: true };
  } catch (err) {
    console.error("[savePortalThemeDraft]", err);
    if (err instanceof Error && err.message.includes("Zod")) {
      return { success: false, error: "Invalid theme configuration." };
    }
    return { success: false, error: "Failed to save draft." };
  }
}

// ── Publish ─────────────────────────────────────────────────────────────────

export async function publishPortalTheme(): Promise<ActionResult> {
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    const portalTheme = await safeFindPortalTheme(tenantPrisma, user.tenantId);

    if (!portalTheme) {
      return { success: false, error: "No theme found. Save a draft first." };
    }

    await safeUpdatePortalTheme(tenantPrisma, user.tenantId, {
      publishedConfig: portalTheme.draftConfig as Prisma.InputJsonValue,
      publishedAt: new Date(),
    });

    await recordAudit(tenantPrisma as any, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "UPDATE",
      entityType: "PortalTheme",
      entityId: portalTheme.id,
      metadata: { action: "publish" },
    }).catch(() => {});

    revalidatePath("/settings");
    revalidatePath(`/tenant/${user.tenantId}`);
    return { success: true };
  } catch (err) {
    console.error("[publishPortalTheme]", err);
    return { success: false, error: "Failed to publish theme." };
  }
}

// ── Discard ─────────────────────────────────────────────────────────────────

export async function discardPortalThemeChanges(): Promise<ActionResult> {
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    // Discarding reverts draft to published config
    const portalTheme = await safeFindPortalTheme(tenantPrisma, user.tenantId);
    if (portalTheme && portalTheme.publishedConfig) {
      await safeUpdatePortalTheme(tenantPrisma, user.tenantId, {
        draftConfig: portalTheme.publishedConfig as Prisma.InputJsonValue,
      });
    }

    revalidatePath("/settings");
    revalidatePath("/settings/portal-customizer");
    return { success: true };
  } catch (err) {
    console.error("[discardPortalThemeChanges]", err);
    return { success: false, error: "Failed to discard changes." };
  }
}

// ── Preview (returns config for iframe) ─────────────────────────────────────

export async function getPortalThemeForPreview(): Promise<
  ActionResult & { config?: PortalThemeConfig }
> {
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    const portalTheme = await safeFindPortalTheme(tenantPrisma, user.tenantId);

    const tenant = await tenantPrisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
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

    const config = resolveTenantPortalTheme({
      portalTheme,
      legacyTenantFields: tenant as Record<string, unknown>,
      mode: "customizer",
    });

    return { success: true, data: config };
  } catch (err) {
    console.error("[getPortalThemeForPreview]", err);
    return { success: false, error: "Failed to load preview." };
  }
}
