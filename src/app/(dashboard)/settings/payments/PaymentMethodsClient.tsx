"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { Building2, ImagePlus, Pencil, Plus, QrCode, Trash2, WalletCards } from "lucide-react";
import { deleteTenantPaymentMethod, saveTenantPaymentMethod, setTenantPaymentMethodActive } from "./actions";
import { EmptyState } from "@/components/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type MethodRow = {
  id: string;
  method: "TRANSFER" | "QRIS" | "CASH" | "CREDIT";
  label: string;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  qrisImageUrl: string | null;
  instructions: string | null;
  requireProof: boolean;
  isActive: boolean;
};

const EMPTY = {
  id: "",
  method: "TRANSFER" as "TRANSFER" | "QRIS",
  label: "",
  bankName: "",
  accountNumber: "",
  accountHolder: "",
  qrisImageUrl: "",
  instructions: "",
};

export function PaymentMethodsClient({ initialMethods }: { initialMethods: MethodRow[] }) {
  const [methods, setMethods] = useState(initialMethods);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isUploading, setIsUploading] = useState(false);
  const [methodToDelete, setMethodToDelete] = useState<MethodRow | null>(null);

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

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveTenantPaymentMethod({
        id: form.id || undefined,
        method: form.method,
        label: form.label,
        bankName: form.method === "TRANSFER" ? form.bankName : null,
        accountNumber: form.method === "TRANSFER" ? form.accountNumber : null,
        accountHolder: form.method === "TRANSFER" ? form.accountHolder : null,
        qrisImageUrl: form.method === "QRIS" ? form.qrisImageUrl : null,
        instructions: form.instructions || null,
        requireProof: true,
      });
      if (!result.success) return setMessage(result.error);
      window.location.reload();
    });
  }

  function edit(method: MethodRow) {
    setForm({
      id: method.id,
      method: method.method === "QRIS" ? "QRIS" : "TRANSFER",
      label: method.label,
      bankName: method.bankName || "",
      accountNumber: method.accountNumber || "",
      accountHolder: method.accountHolder || "",
      qrisImageUrl: method.qrisImageUrl || "",
      instructions: method.instructions || "",
    });
  }

  function toggle(method: MethodRow) {
    const next = !method.isActive;
    setMethods((current) => current.map((item) => item.id === method.id ? { ...item, isActive: next } : item));
    startTransition(async () => {
      const result = await setTenantPaymentMethodActive(method.id, next);
      if (!result.success) {
        setMethods((current) => current.map((item) => item.id === method.id ? { ...item, isActive: method.isActive } : item));
        setMessage(result.error);
      }
    });
  }

  function remove(method: MethodRow) {
    setMethodToDelete(method);
  }

  function confirmRemove() {
    const method = methodToDelete;
    if (!method) return;
    startTransition(async () => {
      const result = await deleteTenantPaymentMethod(method.id);
      if (!result.success) {
        setMessage(result.error);
        setMethodToDelete(null);
        return;
      }
      setMethods((current) => current.filter((item) => item.id !== method.id));
      if (form.id === method.id) setForm(EMPTY);
      setMethodToDelete(null);
    });
  }

  const inputClass = "w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200";

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-stone-100 text-stone-700"><Plus size={18} /></span>
          <div><h2 className="text-sm font-bold text-stone-900">{form.id ? "Edit metode" : "Tambah metode"}</h2><p className="text-xs text-stone-500">Ditampilkan saat pelanggan checkout.</p></div>
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(["TRANSFER", "QRIS"] as const).map((method) => (
              <button key={method} type="button" onClick={() => setForm((current) => ({ ...current, method }))} className={`rounded-lg border px-3 py-2.5 text-sm font-semibold ${form.method === method ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 text-stone-600"}`}>{method === "TRANSFER" ? "Transfer bank" : "QRIS"}</button>
            ))}
          </div>
          <label className="block text-xs font-semibold text-stone-600">Nama tampilan<input className={`${inputClass} mt-1.5`} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder={form.method === "TRANSFER" ? "BCA Operasional" : "QRIS Roastd"} /></label>
          {form.method === "TRANSFER" ? (
            <>
              <label className="block text-xs font-semibold text-stone-600">Bank<input className={`${inputClass} mt-1.5`} value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} placeholder="BCA" /></label>
              <label className="block text-xs font-semibold text-stone-600">Nomor rekening<input className={`${inputClass} mt-1.5`} value={form.accountNumber} onChange={(event) => setForm({ ...form, accountNumber: event.target.value })} inputMode="numeric" /></label>
              <label className="block text-xs font-semibold text-stone-600">Atas nama<input className={`${inputClass} mt-1.5`} value={form.accountHolder} onChange={(event) => setForm({ ...form, accountHolder: event.target.value })} /></label>
            </>
          ) : (
            <label className="block text-xs font-semibold text-stone-600">Gambar QRIS
              <span className="mt-1.5 flex min-h-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 text-stone-500">
                {form.qrisImageUrl ? <Image src={form.qrisImageUrl} alt="Pratinjau QRIS" width={240} height={192} className="h-auto max-h-48 w-auto object-contain" unoptimized /> : <span className="flex items-center gap-2 text-sm"><ImagePlus size={18} /> {isUploading ? "Mengunggah..." : "Pilih JPG, PNG, atau WebP"}</span>}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={isUploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadQris(file); }} />
              </span>
            </label>
          )}
          <label className="block text-xs font-semibold text-stone-600">Instruksi opsional<textarea className={`${inputClass} mt-1.5 min-h-20`} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} placeholder="Contoh: cantumkan nomor invoice pada berita transfer." /></label>
          {message ? <p role="alert" className="text-sm text-red-700">{message}</p> : null}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={isPending || isUploading} className="flex-1 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{isPending ? "Menyimpan..." : "Simpan"}</button>
            {form.id ? <button type="button" onClick={() => setForm(EMPTY)} className="rounded-lg border border-stone-200 px-4 py-2.5 text-sm font-semibold text-stone-600">Batal</button> : null}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-5 text-emerald-900"><strong>Alur aman:</strong> pelanggan mengirim bukti → status menunggu verifikasi → tenant menyetujui → baru kas, piutang, dan status invoice diperbarui.</div>
        {methods.length === 0 ? <EmptyState label="Belum ada tujuan pembayaran" description="Tambahkan rekening atau QRIS agar pelanggan mendapat instruksi pembayaran otomatis setelah checkout." icon={<WalletCards size={21} />} /> : methods.map((method) => {
          const Icon = method.method === "QRIS" ? QrCode : Building2;
          return <article key={method.id} className="flex gap-4 rounded-xl border border-stone-200 bg-white p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-700"><Icon size={18} /></span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-stone-900">{method.label}</h3><span className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${method.isActive ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"}`}>{method.isActive ? "Aktif" : "Nonaktif"}</span></div><p className="mt-1 text-xs text-stone-500">{method.method === "QRIS" ? "QRIS • unggah bukti wajib" : `${method.bankName} • ${method.accountNumber} • ${method.accountHolder}`}</p></div>
            <div className="flex items-start gap-1"><button type="button" aria-label={`Edit ${method.label}`} onClick={() => edit(method)} className="rounded-md p-2 text-stone-500 hover:bg-stone-100"><Pencil size={15} /></button><button type="button" aria-label={`${method.isActive ? "Nonaktifkan" : "Aktifkan"} ${method.label}`} onClick={() => toggle(method)} className="rounded-md px-2 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100">{method.isActive ? "Off" : "On"}</button><button type="button" aria-label={`Hapus ${method.label}`} onClick={() => remove(method)} className="rounded-md p-2 text-red-600 hover:bg-red-50"><Trash2 size={15} /></button></div>
          </article>;
        })}
      </section>
      
      <AlertDialog open={!!methodToDelete} onOpenChange={(open) => !open && setMethodToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus {methodToDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Pesanan lama tetap menyimpan detail tujuan pembayarannya. Tindakan ini tidak dapat dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={confirmRemove}
            >
              Ya, Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
