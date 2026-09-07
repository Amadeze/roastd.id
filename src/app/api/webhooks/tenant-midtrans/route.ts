import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { decryptCredential } from "@/lib/credentials";
import { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { getCurrentDate } from "@/lib/date-utils";
import { postCustomerPrepayment } from "@/lib/posting";
import { postVoidReversal } from "@/lib/posting";
import { appendLedger } from "@/lib/stock";
import { markInvoicePaidForFulfillment, releaseInvoiceReservations } from "@/lib/storefront-commerce";
import {
  getRequestId,
  internalErrorResponse,
  logServerError,
} from "@/lib/api-observability";
import {
  claimWebhookEvent,
  PermanentWebhookError,
  timingSafeEqualText,
} from "@/lib/webhook-inbox";
import { deriveMidtransEventId, isSuccessfulPayment } from "@/lib/midtransWebhookDedupe";

type MidtransWebhookPayload = {
  order_id?: string;
  signature_key?: string;
  status_code?: string;
  gross_amount?: string;
  transaction_status?: string;
  fraud_status?: string;
  payment_type?: string;
  transaction_id?: string;
};

function isTerminalFailure(transactionStatus?: string) {
  return ["expire", "cancel", "deny"].includes(transactionStatus ?? "");
}

function toPaymentMethod(paymentType?: string) {
  return paymentType?.toLowerCase().includes("qris") ? "QRIS" : "TRANSFER";
}

export async function POST(req: Request) {
  const requestId = getRequestId(req.headers);
  let webhookEventId: string | null = null;
  try {
    const data = (await req.json()) as MidtransWebhookPayload;
    const orderId = data.order_id;
    const signatureKey = data.signature_key;
    const statusCode = data.status_code;
    const grossAmount = data.gross_amount;
    const transactionStatus = data.transaction_status;
    const fraudStatus = data.fraud_status;

    if (!orderId) {
      return NextResponse.json({ error: "Missing order_id" }, { status: 400 });
    }
    if (!signatureKey || !statusCode || !grossAmount) {
      return NextResponse.json({ error: "Incomplete Midtrans payload" }, { status: 400 });
    }

    // Find the invoice to get the tenant's Server Key
    const invoice = await prisma.invoice.findUnique({
      where: { midtransOrderId: orderId },
      include: { tenant: { select: { code: true, midtransServerKey: true } }, customer: { select: { name: true } } }
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const serverKey = decryptCredential(invoice.tenant.midtransServerKey);
    if (!serverKey) {
      return NextResponse.json({ error: "Tenant Midtrans server key is not configured" }, { status: 400 });
    }

    // Verify Signature Key using Tenant's Server Key
    const hash = crypto.createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
      .digest('hex');

    if (!timingSafeEqualText(hash, signatureKey)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    const eventId = deriveMidtransEventId({
      orderId,
      transactionStatus,
      transactionId: data.transaction_id,
      statusCode,
    });
    const claim = await claimWebhookEvent(prisma, {
      tenantId: invoice.tenantId,
      provider: "MIDTRANS_TENANT",
      eventId,
      eventType: transactionStatus || "unknown",
      payload: data as Prisma.InputJsonValue,
    });
    webhookEventId = claim.eventId;
    if (!claim.claimed) {
      return NextResponse.json({ success: true, duplicate: true });
    }

    const paidAmount = Number(grossAmount);
    const expectedAmount = Number(invoice.grandTotal);
    if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.01) {
      await prisma.webhookEvent.update({
        where: { id: webhookEventId! },
        data: {
          status: "IGNORED",
          error: "Payment amount does not match invoice total",
          processedAt: getCurrentDate(),
        },
      });
      return NextResponse.json({ success: true, ignored: "amount_mismatch" });
    }

    // Update Invoice Status
    if (isSuccessfulPayment(transactionStatus, fraudStatus)) {
      // Create Payment Record
      await prisma.$transaction(async (tx) => {
        const freshInvoice = await tx.invoice.findFirst({
          where: { id: invoice.id, tenantId: invoice.tenantId },
          select: { id: true, grandTotal: true, status: true, paidAmount: true },
        });

        if (!freshInvoice || freshInvoice.status === "VOID") {
          throw new PermanentWebhookError("Invoice is no longer payable");
        }

        if (freshInvoice.status === "PAID") {
          await tx.webhookEvent.update({
            where: { id: webhookEventId! },
            data: { status: "PROCESSED", processedAt: getCurrentDate() },
          });
          return;
        }
        const previousPaid = Number(freshInvoice.paidAmount);
        if (previousPaid + paidAmount > Number(freshInvoice.grandTotal) + 0.01) {
          throw new PermanentWebhookError(
            "Payment would exceed the remaining invoice balance.",
          );
        }

        const reference = `Midtrans:${orderId}:${data.transaction_id || transactionStatus || "success"}`;
        const existingPayment = await tx.payment.findFirst({
          where: {
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            reference,
          },
          select: { id: true },
        });

        if (existingPayment) {
          await tx.webhookEvent.update({
            where: { id: webhookEventId! },
            data: { status: "PROCESSED", processedAt: getCurrentDate() },
          });
          return;
        }

        const rawSettlement = (data as { settlement_time?: string }).settlement_time;
        const paidAtDate = rawSettlement ? new Date(rawSettlement) : new Date();
        const paidAt = !isNaN(paidAtDate.getTime()) ? paidAtDate : new Date();

        const payment = await tx.payment.create({
          data: {
            code: `PAY-${invoice.tenant.code}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
            invoiceId: invoice.id,
            amount: paidAmount,
            method: toPaymentMethod(data.payment_type),
            reference,
            paidAt,
            tenantId: invoice.tenantId,
            createdById: invoice.createdById, 
          }
        });

        // Update Invoice status to PAID
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { 
            status: "PAID",
            paidAmount: previousPaid + paidAmount,
          }
        });
        await markInvoicePaidForFulfillment(tx, {
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          invoiceCode: invoice.code,
          createdById: invoice.createdById,
          now: paidAt,
        });
        await postCustomerPrepayment(
          payment.id,
          paidAmount,
          invoice.code,
          invoice.customer.name,
          { tx, tenantId: invoice.tenantId, userId: invoice.createdById, date: paidAt },
        );
        await recordAudit(tx, {
          tenantId: invoice.tenantId,
          userId: invoice.createdById,
          action: "CREATE_WEBHOOK",
          entityType: "Payment",
          entityId: payment.id,
          after: {
            code: payment.code,
            invoiceId: invoice.id,
            amount: paidAmount,
            method: payment.method,
          },
          metadata: { provider: "MIDTRANS" },
        });
        await tx.webhookEvent.update({
          where: { id: webhookEventId! },
          data: { status: "PROCESSED", processedAt: getCurrentDate() },
        });
      }, { isolationLevel: "Serializable" });
    } else if (isTerminalFailure(transactionStatus)) {
      await prisma.$transaction(async (tx) => {
        const freshInvoice = await tx.invoice.findFirst({
          where: { id: invoice.id, tenantId: invoice.tenantId },
          select: { id: true, code: true, status: true, paidAmount: true },
        });
        if (!freshInvoice || freshInvoice.status === "VOID" || freshInvoice.status === "PAID") {
          await tx.webhookEvent.update({
            where: { id: webhookEventId! },
            data: { status: "PROCESSED", processedAt: getCurrentDate() },
          });
          return;
        }
        if (Number(freshInvoice.paidAmount) > 0) {
          throw new PermanentWebhookError("Partially paid invoice cannot be auto-cancelled.");
        }

        const saleEntries = await tx.inventoryLedger.findMany({
          where: { tenantId: invoice.tenantId, refId: invoice.id, refType: "SALE_FG_OUT", entryType: "OUT" },
        });
        const activeReservations = await tx.stockReservation.count({
          where: { tenantId: invoice.tenantId, invoiceId: invoice.id, status: "ACTIVE" },
        });
        for (const entry of saleEntries) {
          await appendLedger(tx, {
            data: {
              tenantId: invoice.tenantId,
              productId: entry.productId,
              packagingId: entry.packagingId,
              entryType: "IN",
              refType: "VOID_REVERSAL",
              refId: invoice.id,
              reversalOfLedgerId: entry.id,
              quantityKg: entry.quantityKg,
              quantityUnit: entry.quantityUnit,
              lotId: entry.lotId,
              lotNumber: entry.lotNumber,
              expiryDate: entry.expiryDate,
              notes: `Midtrans ${transactionStatus}: ${freshInvoice.code}`,
              createdById: invoice.createdById,
            },
          });
          if (entry.lotId) {
            await tx.lot.update({ where: { id: entry.lotId }, data: { consumedAt: null } });
          }
        }
        if (activeReservations > 0) {
          await releaseInvoiceReservations(tx, invoice.id, "RELEASED", getCurrentDate());
        }
        const reason = `Pembayaran Midtrans ${transactionStatus}`;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: "VOID", fulfillmentStatus: "CANCELLED", voidReason: reason, voidAt: getCurrentDate() },
        });
        await postVoidReversal("INVOICE", invoice.id, reason, {
          tx,
          tenantId: invoice.tenantId,
          userId: invoice.createdById,
        });
        await recordAudit(tx, {
          tenantId: invoice.tenantId,
          userId: invoice.createdById,
          action: "VOID_WEBHOOK",
          entityType: "Invoice",
          entityId: invoice.id,
          before: { status: freshInvoice.status },
          after: { status: "VOID", reason },
          metadata: { provider: "MIDTRANS", transactionStatus },
        });
        await tx.webhookEvent.update({
          where: { id: webhookEventId! },
          data: { status: "PROCESSED", processedAt: getCurrentDate() },
        });
      }, { isolationLevel: "Serializable" });
    } else {
      await prisma.webhookEvent.update({
        where: { id: webhookEventId! },
        data: { status: "IGNORED", processedAt: getCurrentDate() },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const permanent = error instanceof PermanentWebhookError;
    if (permanent) {
      console.warn(JSON.stringify({
        level: "warn",
        scope: "webhook.tenant-midtrans",
        requestId,
        timestamp: getCurrentDate().toISOString(),
        errorMessage: error.message,
      }));
    } else {
      logServerError("webhook.tenant-midtrans", error, { requestId });
    }
    if (webhookEventId) {
      await prisma.webhookEvent
        .update({
          where: { id: webhookEventId },
          data: {
            status: permanent ? "IGNORED" : "FAILED",
            error: error instanceof Error ? error.message : "Unknown error",
            processedAt: getCurrentDate(),
          },
        })
        .catch(() => undefined);
    }
    if (permanent) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statusCode, headers: { "X-Request-Id": requestId } },
      );
    }
    return internalErrorResponse(requestId, "Webhook gagal diproses.");
  }
}
