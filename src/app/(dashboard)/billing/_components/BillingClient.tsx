"use client";

import { useState } from "react";
import type { Tenant } from "@prisma/client";
import { CreditCard, CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { formatRupiah, formatDate } from "@/lib/format";
import Script from "next/script";
import { toast } from "sonner";
import { toastSafe } from "@/lib/toast";
import { PLAN_CATALOG } from "@/lib/plans";
import { PageHeader } from "@/components/layout/PageHeader";
import { SettingsNav } from "../../settings/_components/SettingsNav";
import { midtransSnapUrl } from "@/lib/midtrans-environment";

type BillingTenant = Pick<
  Tenant,
  "subscriptionTier" | "subscriptionStatus" | "trialEndsAt" | "nextBillingDate"
>;

export default function BillingClient({ tenant }: { tenant: BillingTenant }) {
  const isTrial = tenant.subscriptionTier === "TRIAL";
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  
  // Calculate remaining days if trial
  let daysRemaining = 0;
  if (isTrial && tenant.trialEndsAt) {
    const diffTime = new Date(tenant.trialEndsAt).getTime() - Date.now();
    daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  const isExpired = isTrial && daysRemaining <= 0;

  const handleSubscribe = async (tier: string) => {
    try {
      setLoadingTier(tier);
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Gagal membuat transaksi");

      // Midtrans Snap
      if (window.snap) {
        window.snap.pay(data.token, {
          onSuccess: function () {
            toast.success("Pembayaran berhasil. Akun sedang diperbarui...");
            setTimeout(() => window.location.reload(), 2000);
          },
          onPending: function () {
            toast.info("Menunggu pembayaran Anda.");
          },
          onError: function () {
            toast.error("Pembayaran gagal!");
          },
          onClose: function () {
            toast.error("Pembayaran dibatalkan.");
          }
        });
      } else {
        toast.error("Sistem pembayaran belum siap, coba sesaat lagi.");
      }
    } catch (error: any) {
      toastSafe.error(error.message);
    } finally {
      setLoadingTier(null);
    }
  };

  return (
    <>
      <Script 
        src={midtransSnapUrl({ clientKey: process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY, explicitProduction: process.env.NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION })}
        data-client-key={process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY} 
        strategy="lazyOnload" 
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          title="Paket & Tagihan"
          eyebrow="Pengaturan"
          description="Kelola paket roastd.id dan status pembayaran Anda."
        />
        <SettingsNav userRole="OWNER" />
        <div className="custom-scrollbar flex-1 overflow-auto">
          <div className="mx-auto max-w-[1600px] p-4 md:p-6 lg:p-8">
            <div className="mx-auto max-w-5xl space-y-6">
          
          {/* Header */}
          {/* Current Plan Status */}
          <div className="glass-card-static p-6 md:p-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                    {tenant.subscriptionTier} PLAN
                  </span>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-md ${tenant.subscriptionStatus === 'ACTIVE' && !isExpired ? 'bg-success-light text-success-base' : 'bg-danger-mid text-danger-base'}`}>
                    {isExpired ? 'EXPIRED' : tenant.subscriptionStatus}
                  </span>
                </div>
                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-1">
                  {isTrial ? "Trial roastd.id" : `roastd.id ${tenant.subscriptionTier}`}
                </h2>
                {isTrial ? (
                  <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
                    {isExpired ? (
                      <><AlertTriangle size={16} className="text-status-danger"/> Your trial has expired. Upgrade to continue using all features.</>
                    ) : (
                      <><Clock size={16} className="text-status-warning"/> {daysRemaining} days remaining in your trial.</>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">
                    Next billing date: {tenant.nextBillingDate ? formatDate(tenant.nextBillingDate) : 'N/A'}
                  </p>
                )}
              </div>

              {tenant.subscriptionTier !== "TRIAL" && (
                <button className="bg-[var(--amber-deep)] hover:brightness-110 text-white font-semibold py-2.5 px-6 rounded-xl transition-all shadow-[var(--glass-shadow)]">
                  Manage Billing
                </button>
              )}
            </div>
          </div>

          {/* Upgrade Options */}
          {tenant.subscriptionTier !== "PRO" && (
            <div className="mt-12">
              <h3 className="text-lg font-bold text-[var(--text-primary)] mb-6">Upgrade your plan</h3>
              <div className="grid gap-6">
                <div className="bg-[var(--amber-lighter)] rounded-2xl border border-amber-200 p-6 shadow-sm hover:shadow-md transition-all relative overflow-hidden">
                  <div className="absolute top-0 right-0 bg-[var(--amber-deep)] text-white text-xs font-bold px-3 py-1 rounded-bl-lg uppercase tracking-wider">Premium Access</div>
                  <h4 className="text-lg font-bold text-[var(--amber-warm)] mb-2">roastd.id Pro</h4>
                  <div className="mb-4">
                    <span className="text-3xl font-extrabold text-[var(--text-primary)]">{formatRupiah(PLAN_CATALOG.PRO.monthlyPrice)}</span>
                    <span className="text-[var(--text-secondary)] text-sm">/mo</span>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4 mb-8 mt-6">
                    <ul className="space-y-3">
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Core Inventory & Ledger</li>
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Roasting & Production Logs</li>
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Advanced B2B Portal</li>
                    </ul>
                    <ul className="space-y-3">
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Custom Domain</li>
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Payment Gateway (Midtrans)</li>
                      <li className="text-[var(--text-secondary)] text-sm flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Advanced Analytics & P&L</li>
                    </ul>
                  </div>
                  <button 
                    onClick={() => handleSubscribe("PRO")}
                    disabled={loadingTier !== null}
                    className="w-full py-3 rounded-xl bg-[var(--amber-deep)] hover:brightness-110 text-white font-bold transition-all flex items-center justify-center gap-2 shadow-[var(--glass-shadow)]"
                  >
                    {loadingTier === "PRO" ? "Processing..." : <><CreditCard size={18} /> Subscribe to Pro</>}
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  </div>
    </>
  );
}
