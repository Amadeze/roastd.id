import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { recordAudit } from "@/lib/audit";
import { getRequestId, internalErrorResponse, logServerError } from "@/lib/api-observability";
import { canSubmitPaymentProof } from "@/lib/manual-payments";
import { prisma } from "@/lib/prisma";
import { dispatchPaymentProofSubmittedNotifications } from "@/lib/payment-notifications";
import {
  digestIdentifier,
  layeredIdentifiers,
  resolveClientIdentity,
} from "@/lib/client-identity";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { hasValidImageSignature, uploadPrivateImage } from "@/lib/storage";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; token: string }> },
) {
  const requestId = getRequestId(request.headers);
  let subdomainForLog = "unknown";
  try {
    const { subdomain, token } = await params;
    subdomainForLog = subdomain;
    const identity = resolveClientIdentity(request.headers);
    await enforceRateLimit({
      scope: "payment-proof",
      identifiers: layeredIdentifiers(identity, [
        digestIdentifier("tenant", subdomain),
        digestIdentifier("submission", token),
      ]),
      limit: 8,
      windowSeconds: 60 * 60,
    });

    const submission = await prisma.paymentSubmission.findFirst({
      where: { publicToken: token, tenant: { subdomain } },
      include: { invoice: { select: { code: true, createdById: true } } },
    });
    if (!submission) return NextResponse.json({ error: "Pesanan tidak ditemukan." }, { status: 404 });
    if (submission.expiresAt <= new Date()) {
      await prisma.paymentSubmission.update({ where: { id: submission.id }, data: { status: "EXPIRED" } });
      return NextResponse.json({ error: "Waktu pembayaran pesanan sudah habis." }, { status: 410 });
    }
    if (!canSubmitPaymentProof(submission.status)) {
      return NextResponse.json({ error: "Bukti pembayaran sudah dikirim atau diproses." }, { status: 409 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const payerName = String(formData.get("payerName") || "").trim();
    const reference = String(formData.get("reference") || "").trim();
    const declaredAmount = Number(formData.get("declaredAmount"));
    if (!(file instanceof File) || !payerName || !Number.isFinite(declaredAmount) || declaredAmount <= 0 || declaredAmount > 1_000_000_000_000) {
      return NextResponse.json({ error: "Nama pengirim, nominal transfer, dan foto bukti wajib diisi." }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE || !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json({ error: "Bukti harus berupa JPG, PNG, atau WebP maksimal 5 MB." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!hasValidImageSignature(buffer, file.type)) {
      return NextResponse.json({ error: "Isi file tidak cocok dengan format gambarnya." }, { status: 400 });
    }
    const proofSha256 = createHash("sha256").update(buffer).digest("hex");

    const objectPath = await uploadPrivateImage({
      tenantId: submission.tenantId,
      namespace: "payment-proofs",
      buffer,
      mimeType: file.type,
    });

    await prisma.$transaction(async (tx) => {
      const currentSubmission = await tx.paymentSubmission.findFirst({
        where: { id: submission.id },
        select: { id: true, status: true },
      });
      if (!currentSubmission || !canSubmitPaymentProof(currentSubmission.status)) {
        throw new Error("Bukti pembayaran sudah dikirim atau diproses.");
      }

      const duplicate = await tx.paymentSubmission.findFirst({
        where: {
          tenantId: submission.tenantId,
          id: { not: submission.id },
          status: { in: ["AWAITING_VERIFICATION", "VERIFIED"] },
          OR: [
            { proofSha256 },
            ...(reference ? [{ reference: reference.slice(0, 150) }] : []),
          ],
        },
        orderBy: { submittedAt: "desc" },
        select: { id: true },
      });
      await tx.paymentSubmission.update({
        where: { id: submission.id },
        data: {
          status: "AWAITING_VERIFICATION",
          payerName: payerName.slice(0, 120),
          declaredAmount,
          reference: reference.slice(0, 150) || null,
          proofSha256,
          suspectedDuplicateOfId: duplicate?.id || null,
          proofObjectPath: objectPath,
          proofMimeType: file.type,
          proofFilename: file.name.slice(0, 255),
          submissionAttempt: { increment: 1 },
          submittedAt: new Date(),
          rejectionReason: null,
        },
      });
      await recordAudit(tx, {
        tenantId: submission.tenantId,
        userId: submission.invoice.createdById,
        action: "SUBMIT_PUBLIC",
        entityType: "PaymentSubmission",
        entityId: submission.id,
        after: {
          status: "AWAITING_VERIFICATION",
          invoiceCode: submission.invoice.code,
          declaredAmount,
          suspectedDuplicateOfId: duplicate?.id || null,
        },
        metadata: { source: "tenant-storefront", requestId },
      });
    });

    await dispatchPaymentProofSubmittedNotifications(submission.id).catch((error) => {
      logServerError("tenant.payment-proof.notification", error, { requestId, subdomain: subdomainForLog });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": String(error.retryAfter) } });
    }
    logServerError("tenant.payment-proof.submit", error, { requestId, subdomain: subdomainForLog });
    return internalErrorResponse(requestId, "Bukti pembayaran gagal dikirim.");
  }
}
