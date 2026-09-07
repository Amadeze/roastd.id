"use client";

import { motion } from "framer-motion";
import { ArrowRight, Check, CreditCard, Loader2, Package, Plus, Settings2, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeOnboarding } from "./actions";
import { saveTenantPaymentMethod } from "../(dashboard)/settings/payments/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function OnboardingClient({ readiness }: { readiness: { activePaymentMethods: number; machines: number; products: number } }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  
  // Payment Inline State
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentType, setPaymentType] = useState<"TRANSFER" | "QRIS">("TRANSFER");
  const [isUploading, setIsUploading] = useState(false);
  
  const [form, setForm] = useState({
    label: "BCA Roastery",
    bankName: "BCA",
    accountNumber: "",
    accountHolder: "",
    qrisImageUrl: "",
    instructions: "Mohon sertakan nomor invoice pada berita transfer."
  });

  const paymentReady = readiness.activePaymentMethods > 0;

  async function handleStart() {
    setLoading(true);
    setMessage(null);
    const result = await completeOnboarding();
    if (result.success) {
      router.push("/dashboard");
      router.refresh();
      return;
    }
    setMessage(result.error || "Panduan belum dapat diselesaikan.");
    setLoading(false);
  }

  async function uploadQris(file: File) {
    setIsUploading(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/upload", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload QRIS gagal.");
      setForm((current) => ({ ...current, qrisImageUrl: result.url }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload QRIS gagal.");
    } finally {
      setIsUploading(false);
    }
  }

  function handleSavePayment(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await saveTenantPaymentMethod({
        method: paymentType,
        label: form.label,
        bankName: paymentType === "TRANSFER" ? form.bankName : null,
        accountNumber: paymentType === "TRANSFER" ? form.accountNumber : null,
        accountHolder: paymentType === "TRANSFER" ? form.accountHolder : null,
        qrisImageUrl: paymentType === "QRIS" ? form.qrisImageUrl : null,
        instructions: form.instructions || null,
        requireProof: true,
      });
      if (!result.success) {
        setMessage(result.error);
        return;
      }
      // If success, directly start onboarding completion
      await handleStart();
    });
  }

  return (
    <main className="min-h-screen bg-[#071015] p-4 text-stone-900 md:p-8 flex items-center justify-center">
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-[#f6f3ee] shadow-2xl">
        <header className="border-b border-stone-200 px-6 py-7 md:px-9">
          <p className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-[#B65331]">Setup awal roastd.id</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight md:text-3xl">Siapkan alur yang benar-benar dipakai</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">Satu hal wajib sebelum masuk: tentukan rekening atau QRIS roastery. Mesin dan produk boleh ditambahkan setelah dashboard terbuka.</p>
        </header>
        <div className="space-y-4 p-6 md:p-9">
          
          {!showPaymentForm ? (
            <button 
              onClick={() => {
                if (paymentReady) {
                  router.push("/settings/payments");
                } else {
                  setShowPaymentForm(true);
                }
              }} 
              className={`flex w-full items-center gap-4 rounded-xl border p-4 text-left transition hover:-translate-y-0.5 ${paymentReady ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}
            >
              <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${paymentReady ? "bg-emerald-700 text-white" : "bg-amber-500 text-white"}`}>{paymentReady ? <Check size={20} /> : <CreditCard size={20} />}</span>
              <span className="min-w-0 flex-1"><strong className="block text-sm">Rekening / QRIS tenant</strong><span className="mt-1 block text-xs leading-5 text-stone-600">{paymentReady ? `${readiness.activePaymentMethods} metode aktif. Klik untuk kelola.` : "Wajib: Klik untuk menambah rekening/QRIS pertama Anda."}</span></span>
              {!paymentReady ? <Plus size={17} className="text-amber-600" /> : <ArrowRight size={17} className="text-emerald-700" />}
            </button>
          ) : (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="rounded-xl border border-amber-200 bg-white p-5 shadow-inner">
              <div className="mb-4 flex items-center justify-between border-b border-stone-100 pb-3">
                <h3 className="font-bold text-stone-800">Tambah Metode Pembayaran</h3>
                <button type="button" onClick={() => setShowPaymentForm(false)} className="text-xs font-medium text-stone-500 hover:text-stone-800">Batal</button>
              </div>
              <form onSubmit={handleSavePayment} className="space-y-4">
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPaymentType("TRANSFER")} className={`flex-1 rounded-lg border py-2 text-sm font-semibold transition ${paymentType === "TRANSFER" ? "border-cyan-500 bg-cyan-50 text-cyan-800" : "border-stone-200 text-stone-500 hover:bg-stone-50"}`}>Transfer Bank</button>
                  <button type="button" onClick={() => setPaymentType("QRIS")} className={`flex-1 rounded-lg border py-2 text-sm font-semibold transition ${paymentType === "QRIS" ? "border-cyan-500 bg-cyan-50 text-cyan-800" : "border-stone-200 text-stone-500 hover:bg-stone-50"}`}>QRIS</button>
                </div>

                <div>
                  <Label className="text-xs uppercase font-bold text-stone-500">Label Tersimpan <span className="text-red-500">*</span></Label>
                  <Input required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Misal: BCA Roastery" className="mt-1 bg-stone-50" />
                </div>

                {paymentType === "TRANSFER" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-xs uppercase font-bold text-stone-500">Nama Bank <span className="text-red-500">*</span></Label>
                      <Input required value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder="BCA / Mandiri / BNI" className="mt-1 bg-stone-50" />
                    </div>
                    <div>
                      <Label className="text-xs uppercase font-bold text-stone-500">Atas Nama <span className="text-red-500">*</span></Label>
                      <Input required value={form.accountHolder} onChange={(e) => setForm({ ...form, accountHolder: e.target.value })} placeholder="Nama Pemilik Rekening" className="mt-1 bg-stone-50" />
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="text-xs uppercase font-bold text-stone-500">Nomor Rekening <span className="text-red-500">*</span></Label>
                      <Input required value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} placeholder="1234567890" className="mt-1 bg-stone-50 font-mono text-lg tracking-widest" />
                    </div>
                  </div>
                ) : (
                  <div>
                    <Label className="text-xs uppercase font-bold text-stone-500">Kode QRIS <span className="text-red-500">*</span></Label>
                    <div className="mt-1 rounded-xl border-2 border-dashed border-stone-200 bg-stone-50 p-4 text-center">
                      {form.qrisImageUrl ? (
                        <div className="space-y-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={form.qrisImageUrl} alt="QRIS" className="mx-auto max-h-40 rounded-lg shadow-sm" />
                          <button type="button" onClick={() => setForm({ ...form, qrisImageUrl: "" })} className="text-xs font-semibold text-red-600 hover:underline">Hapus / Ganti QRIS</button>
                        </div>
                      ) : (
                        <label className="flex cursor-pointer flex-col items-center justify-center gap-2">
                          {isUploading ? (
                            <Loader2 className="animate-spin text-stone-400" size={24} />
                          ) : (
                            <UploadCloud className="text-stone-400" size={24} />
                          )}
                          <span className="text-sm font-medium text-stone-600">
                            {isUploading ? "Mengunggah..." : "Pilih gambar QRIS"}
                          </span>
                          <input type="file" accept="image/*" className="hidden" disabled={isUploading} onChange={(e) => {
                            if (e.target.files?.[0]) uploadQris(e.target.files[0]);
                          }} />
                        </label>
                      )}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs uppercase font-bold text-stone-500">Instruksi Pembayaran</Label>
                  <Textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className="mt-1 bg-stone-50" rows={2} />
                </div>

                <div className="pt-2">
                  <button type="submit" disabled={isPending || isUploading} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 font-bold text-white transition hover:bg-cyan-700 disabled:opacity-50">
                    {isPending ? <Loader2 className="size-4 animate-spin" /> : "Simpan & Lanjut"}
                  </button>
                </div>
              </form>
            </motion.div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Link href="/settings/machines" className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-4 hover:border-stone-400"><Settings2 size={19} className="text-stone-500" /><span><strong className="block text-sm">Mesin roasting</strong><span className="text-xs text-stone-500">{readiness.machines} mesin aktif · opsional sekarang</span></span></Link>
            <Link href="/katalog" className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-4 hover:border-stone-400"><Package size={19} className="text-stone-500" /><span><strong className="block text-sm">Produk</strong><span className="text-xs text-stone-500">{readiness.products} produk aktif · bisa diisi nanti</span></span></Link>
          </div>
          {message ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{message}</p> : null}
          
          {!showPaymentForm && (
            <button type="button" onClick={handleStart} disabled={loading || !paymentReady} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#B65331] font-bold text-white transition hover:bg-[#934126] disabled:cursor-not-allowed disabled:opacity-45 shadow-lg shadow-[#B65331]/20">
              {loading ? <Loader2 className="size-5 animate-spin" /> : <>Masuk ke Dashboard <ArrowRight className="size-4" /></>}
            </button>
          )}
        </div>
      </motion.div>
    </main>
  );
}
