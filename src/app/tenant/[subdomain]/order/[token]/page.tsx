import Image from "next/image";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { paymentStatusLabel } from "@/lib/manual-payments";
import { PaymentProofForm } from "./PaymentProofForm";
import { STOREFRONT_GRIND_LABEL } from "@/lib/storefront-grind";

export const dynamic = "force-dynamic";

type Destination = {
  label?: string; bankName?: string | null; accountNumber?: string | null;
  accountHolder?: string | null; qrisImageUrl?: string | null; instructions?: string | null;
};

const fulfillmentLabels: Record<string, string> = {
  AWAITING_PAYMENT: "Menunggu pembayaran",
  PAID: "Pembayaran diterima",
  NEEDS_PRODUCTION: "Sedang disiapkan",
  READY_TO_PACK: "Siap dikemas",
  PACKED: "Sudah dikemas",
  SHIPPED: "Dalam pengiriman",
  DELIVERED: "Pesanan selesai",
  CANCELLED: "Pesanan dibatalkan",
};

const fulfillmentColors: Record<string, string> = {
  AWAITING_PAYMENT: "bg-amber-100 text-amber-800",
  PAID: "bg-blue-100 text-blue-800",
  NEEDS_PRODUCTION: "bg-blue-100 text-blue-800",
  READY_TO_PACK: "bg-indigo-100 text-indigo-800",
  PACKED: "bg-purple-100 text-purple-800",
  SHIPPED: "bg-sky-100 text-sky-800",
  DELIVERED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export default async function PublicOrderPage({ params }: { params: Promise<{ subdomain: string; token: string }> }) {
  const { subdomain, token } = await params;
  const invoice = await prisma.invoice.findFirst({
    where: {
      tenant: { subdomain },
      OR: [{ publicOrderToken: token }, { paymentSubmissions: { some: { publicToken: token } } }],
    },
    select: {
      id: true, code: true, status: true, fulfillmentStatus: true, issuedAt: true,
      subtotal: true, tax: true, shippingCost: true, grandTotal: true, paidAmount: true,
      shippingMethod: true, courierName: true, trackingNumber: true, paymentUrl: true,
      reservationExpiresAt: true,
      dueDate: true, paymentMethod: true, salesChannel: true, purchaseOrderReference: true,
      customer: { select: { name: true } },
      tenant: { select: { name: true, subdomain: true, whatsappNumber: true } },
      items: {
        select: {
          id: true, quantity: true, unitPrice: true, subtotal: true,
          grindSize: true, customGrindLabel: true,
          offeringName: true, packageName: true, netWeightGrams: true, roastLevel: true,
          product: { select: { name: true } },
        },
      },
      tracking: {
        select: {
          awb: true, courierCode: true, providerStatus: true,
          providerDelivered: true, events: true, lastRefreshedAt: true,
        },
      },
      fulfillmentTasks: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { shortageQuantity: true } },
      paymentSubmissions: {
        orderBy: { createdAt: "desc" }, take: 10,
        select: {
          id: true, publicToken: true, method: true, status: true, amount: true,
          declaredAmount: true, reviewedAmount: true, destination: true,
          rejectionReason: true, expiresAt: true,
        },
      },
    },
  });
  if (!invoice) notFound();

  const submission = invoice.paymentSubmissions.find((item) => item.publicToken === token)
    ?? invoice.paymentSubmissions[0]
    ?? null;
  const destination = (submission?.destination || {}) as Destination;
  const canUpload = submission
    ? (submission.status === "AWAITING_PROOF" || submission.status === "REJECTED") && submission.expiresAt > new Date()
    : false;
  const waNumber = invoice.tenant.whatsappNumber?.replace(/\D/g, "").replace(/^0/, "62");
  const amountDue = Math.max(0, Number(invoice.grandTotal) - Number(invoice.paidAmount));
  const nextSubmission = amountDue > 0
    ? invoice.paymentSubmissions.find((item) => (
      item.id !== submission?.id
      && item.status === "AWAITING_PROOF"
      && item.expiresAt > new Date()
    )) ?? null
    : null;
  const shortage = invoice.fulfillmentTasks.reduce((sum, task) => sum + task.shortageQuantity, 0);

  return (
    <main className="min-h-screen bg-[#f3efe8] px-4 py-8 text-stone-900 md:py-14">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl shadow-stone-900/5">
        <header className="border-b border-stone-200 bg-[#071015] px-6 py-6 text-white md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">{invoice.tenant.name}</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <div><h1 className="text-2xl font-black">Status pesanan</h1><p className="mt-1 text-sm text-white/60">{invoice.code} · {invoice.customer.name}</p></div>
            <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold text-white">{fulfillmentLabels[invoice.fulfillmentStatus]}</span>
          </div>
        </header>

        <div className="space-y-6 p-6 md:p-8">
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">Total</p><p className="mt-1 text-xl font-black">Rp {Number(invoice.grandTotal).toLocaleString("id-ID")}</p></div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">Pembayaran</p><p className="mt-1 text-sm font-black">{invoice.status === "PAID" ? "Lunas" : amountDue > 0 ? `Sisa Rp ${amountDue.toLocaleString("id-ID")}` : invoice.status}</p></div>
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Pengiriman</p>
              <p className="mt-1 text-sm font-black">{invoice.shippingMethod === "PICKUP" ? "Ambil di roastery" : invoice.trackingNumber ? `${invoice.courierName || "Kurir"} · ${invoice.trackingNumber}` : "Belum dikirim"}</p>
            </div>
          </section>

          {invoice.salesChannel === "B2B_DIRECT" ? (
            <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
              <p className="text-xs font-black uppercase tracking-wider text-emerald-700">Pesanan Partner B2B</p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
                {invoice.purchaseOrderReference ? <span>Referensi PO: <strong>{invoice.purchaseOrderReference}</strong></span> : null}
                {invoice.paymentMethod === "CREDIT" && invoice.dueDate ? (
                  <span>Jatuh tempo: <strong>{invoice.dueDate.toLocaleDateString("id-ID", { dateStyle: "long" })}</strong></span>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Fulfillment + Tracking Status */}
          <section className="rounded-xl border border-stone-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-black uppercase tracking-wider text-stone-600">Status Pesanan</h2>
              <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${fulfillmentColors[invoice.fulfillmentStatus] || "bg-stone-100 text-stone-800"}`}>
                {fulfillmentLabels[invoice.fulfillmentStatus] || invoice.fulfillmentStatus}
              </span>
            </div>
            {invoice.tracking ? (
              <div className="mt-3 rounded-lg bg-stone-50 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-bold text-stone-700">{invoice.tracking.courierCode?.toUpperCase()}</span>
                  <span className="text-stone-500">·</span>
                  <span className="font-mono text-stone-600">{invoice.tracking.awb}</span>
                </div>
                {invoice.tracking.providerStatus && (
                  <p className="mt-1.5 text-xs text-stone-500">
                    Status kurir: <span className="font-semibold text-stone-700">{invoice.tracking.providerStatus}</span>
                  </p>
                )}
                {invoice.tracking.lastRefreshedAt && (
                  <p className="mt-0.5 text-[11px] text-stone-400">
                    Diperbarui: {new Date(invoice.tracking.lastRefreshedAt).toLocaleString("id-ID")}
                  </p>
                )}
                {Array.isArray(invoice.tracking.events) && invoice.tracking.events.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-stone-200 pt-3">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Riwayat Tracking</p>
                    {(invoice.tracking.events as any[]).slice(0, 5).map((event, idx) => (
                      <div key={idx} className="flex gap-3 text-xs">
                        <span className="text-stone-400 whitespace-nowrap">{event.timestamp || "-"}</span>
                        <span className="text-stone-600">{event.description}</span>
                        {event.location && <span className="text-stone-400">· {event.location}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : invoice.trackingNumber ? (
              <p className="mt-2 text-xs text-stone-500">
                Resi: {invoice.trackingNumber} — tracking belum diperbarui.
              </p>
            ) : invoice.shippingMethod !== "PICKUP" ? (
              <p className="mt-2 text-xs text-stone-500">Belum ada informasi pengiriman.</p>
            ) : null}
          </section>

          <section>
            <h2 className="text-xs font-black uppercase tracking-wider text-stone-600">Isi pesanan</h2>
            <div className="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200">
              {invoice.items.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div>
                  <p className="font-bold">{item.offeringName ?? item.product.name}</p>
                  <p className="text-xs text-stone-500">
                    {item.quantity} × Rp {Number(item.unitPrice).toLocaleString("id-ID")}
                    {item.packageName ? ` · ${item.packageName}` : ""}
                    {item.netWeightGrams ? ` · ${Number(item.netWeightGrams).toLocaleString("id-ID")}g` : ""}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    {item.roastLevel ? `${item.roastLevel.replace("_", " ")} · ` : ""}
                    {item.grindSize ? (item.grindSize === "CUSTOM" ? item.customGrindLabel : STOREFRONT_GRIND_LABEL[item.grindSize]) : null}
                  </p>
                </div>
                <strong>Rp {Number(item.subtotal).toLocaleString("id-ID")}</strong>
              </div>)}
              {Number(invoice.shippingCost) > 0 ? <div className="flex justify-between px-4 py-3 text-sm"><span>Ongkir</span><strong>Rp {Number(invoice.shippingCost).toLocaleString("id-ID")}</strong></div> : null}
              {Number(invoice.tax) > 0 ? <div className="flex justify-between px-4 py-3 text-sm"><span>Pajak</span><strong>Rp {Number(invoice.tax).toLocaleString("id-ID")}</strong></div> : null}
            </div>
          </section>

          {shortage > 0 ? <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900"><strong>Pesanan diterima.</strong><br />Sebagian stok ({shortage} unit) sedang diproduksi. Roastery tidak perlu membuat order ulang; task produksi sudah dibuat otomatis.</div> : null}

          {submission ? <section className="rounded-xl border border-stone-200 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-black">Pembayaran {destination.label || submission.method}</h2><span className={`rounded-full px-3 py-1 text-xs font-bold ${submission.status === "VERIFIED" ? "bg-emerald-100 text-emerald-800" : submission.status === "REJECTED" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>{paymentStatusLabel(submission.status)}</span></div>
            {submission.status !== "VERIFIED" ? <>
              {submission.method === "QRIS" && destination.qrisImageUrl ? <div className="mt-4 flex justify-center rounded-xl border border-stone-200 p-4"><Image src={destination.qrisImageUrl} alt={`QRIS ${invoice.tenant.name}`} width={600} height={600} className="max-h-72 object-contain" unoptimized /></div> : null}
              {submission.method === "TRANSFER" ? <dl className="mt-4 grid gap-2 rounded-lg bg-stone-50 p-4 text-sm"><div><dt className="text-xs text-stone-500">Bank</dt><dd className="font-bold">{destination.bankName}</dd></div><div><dt className="text-xs text-stone-500">Nomor rekening</dt><dd className="font-mono text-lg font-black">{destination.accountNumber}</dd></div><div><dt className="text-xs text-stone-500">Atas nama</dt><dd className="font-bold">{destination.accountHolder}</dd></div></dl> : null}
              {destination.instructions ? <p className="mt-3 text-sm text-stone-600">{destination.instructions}</p> : null}
            </> : <p className="mt-3 text-sm text-emerald-800">Bukti sudah diverifikasi roastery.</p>}
            {submission.status === "REJECTED" && submission.rejectionReason ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{submission.rejectionReason}</p> : null}
            {canUpload ? <div className="mt-4"><PaymentProofForm endpoint={`/api/tenant/${subdomain}/payments/${token}/submit`} expectedAmount={Number(submission.amount)} /></div> : submission.status === "AWAITING_VERIFICATION" ? <p className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Bukti sudah diterima dan menunggu verifikasi roastery.</p> : null}
            {nextSubmission ? <Link className="mt-4 flex min-h-11 items-center justify-center rounded-lg bg-stone-900 px-5 text-sm font-black text-white" href={`/tenant/${subdomain}/order/${nextSubmission.publicToken}`}>Bayar sisa tagihan</Link> : null}
          </section> : invoice.paymentUrl && invoice.status !== "PAID" ? <a className="flex min-h-11 items-center justify-center rounded-lg bg-stone-900 px-5 text-sm font-black text-white" href={invoice.paymentUrl}>Lanjutkan pembayaran online</a> : null}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-5 text-xs text-stone-500">
            <span>
              Dibuat {invoice.issuedAt.toLocaleString("id-ID")}
              {invoice.salesChannel !== "B2B_DIRECT" && invoice.reservationExpiresAt && invoice.status !== "PAID"
                ? ` · stok ditahan sampai ${invoice.reservationExpiresAt.toLocaleString("id-ID")}`
                : ""}
            </span>
            {waNumber ? <a className="font-bold text-stone-800 underline" href={`https://wa.me/${waNumber}?text=${encodeURIComponent(`Halo ${invoice.tenant.name}, saya ingin menanyakan pesanan ${invoice.code}.`)}`}>Hubungi roastery</a> : null}
          </footer>
        </div>
      </div>
    </main>
  );
}
