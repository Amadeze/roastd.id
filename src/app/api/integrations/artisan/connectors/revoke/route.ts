import { NextRequest, NextResponse } from "next/server";
import { requireRole, requireTenantPrisma } from "@/lib/auth";
import { isNextRedirectError } from "@/lib/api-auth";
import { recordAudit } from "@/lib/audit";
import { tenantIdentifier } from "@/lib/client-identity";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";
import {
  getRequestId,
  internalErrorResponse,
  logServerError,
} from "@/lib/api-observability";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  try {
    const user = await requireRole("OWNER");
    const tenantPrisma = await requireTenantPrisma();

    // Rate limit: 10/minute per tenant
    await enforceRateLimit({
      scope: "artisan:revoke",
      identifiers: [tenantIdentifier(user.tenantId)],
      limit: 10,
      windowSeconds: 60,
    });

    const body = await req.json();
    const connectorId = body?.connectorId;
    if (!connectorId || typeof connectorId !== "string") {
      return NextResponse.json(
        { error: "connectorId wajib diisi." },
        { status: 400 },
      );
    }

    // Verify connector belongs to tenant
    const connector = await tenantPrisma.roastdStudio.findFirst({
      where: { id: connectorId, tenantId: user.tenantId },
      select: { id: true, tenantId: true, computerName: true, revokedAt: true },
    });

    if (!connector) {
      return NextResponse.json(
        { error: "Connector tidak ditemukan." },
        { status: 404 },
      );
    }

    if (connector.revokedAt) {
      return NextResponse.json(
        { error: "Connector sudah dicabut." },
        { status: 409 },
      );
    }

    await tenantPrisma.$transaction(async (tx) => {
      await tx.roastdStudio.update({
        where: { id: connectorId },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
        },
      });

      await recordAudit(tx, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "REVOKE",
        entityType: "RoastdStudio",
        entityId: connectorId,
        metadata: { computerName: connector.computerName },
      });
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: e.message },
        { status: 429, headers: { "Retry-After": String(e.retryAfter) } },
      );
    }
    if (isNextRedirectError(e)) {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Sesi tidak valid." } },
        { status: 401 },
      );
    }
    logServerError("artisan.revoke", e, { requestId });
    return internalErrorResponse(requestId, "Gagal mencabut connector.");
  }
}
