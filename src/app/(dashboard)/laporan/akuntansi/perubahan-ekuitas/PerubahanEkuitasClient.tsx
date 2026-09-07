"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatRupiah } from "@/lib/format";
import type { PerubahanEkuitasRow } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReportExport } from "../../_shared/ReportExport";

export function PerubahanEkuitasClient({
  data,
  error,
  fromDate,
  toDate,
}: {
  data: PerubahanEkuitasRow[] | null;
  error: string | null;
  fromDate: string | null;
  toDate: string | null;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(fromDate ?? "");
  const [to, setTo] = useState(toDate ?? "");

  const totalOpening = data?.reduce((s, r) => s + r.openingBalance, 0) ?? 0;
  const totalClosing = data?.reduce((s, r) => s + r.closingBalance, 0) ?? 0;
  const totalAddition = data?.reduce((s, r) => s + r.addition, 0) ?? 0;
  const totalDeduction = data?.reduce((s, r) => s + r.deduction, 0) ?? 0;

  function handleFilter() {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    router.push(`/laporan/akuntansi/perubahan-ekuitas?${p.toString()}`);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-stone-200 bg-white p-5 flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="from">Dari Tanggal</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="to">Sampai Tanggal</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={handleFilter}>Terapkan</Button>
        {data && data.length > 0 && (
          <div className="ml-auto">
            <ReportExport
              title="Laporan Perubahan Ekuitas"
              filename="perubahan-ekuitas"
              period={from || to ? `${from || "…"} s.d. ${to || "…"}` : undefined}
              subtitle="Mutasi setiap komponen ekuitas selama periode"
              status="FINAL"
              summary={[
                { label: "Total Saldo Awal", value: formatRupiah(totalOpening) },
                { label: "Total Penambahan", value: formatRupiah(totalAddition) },
                { label: "Total Pengurangan", value: formatRupiah(totalDeduction) },
                { label: "Total Saldo Akhir", value: formatRupiah(totalClosing) },
              ]}
              columns={[
                { header: "Komponen", key: "component" },
                { header: "Saldo Awal", key: "openingBalance", format: (v) => formatRupiah(Number(v)) },
                { header: "Penambahan", key: "addition", format: (v) => formatRupiah(Number(v)) },
                { header: "Pengurangan", key: "deduction", format: (v) => formatRupiah(Number(v)) },
                { header: "Saldo Akhir", key: "closingBalance", format: (v) => formatRupiah(Number(v)) },
              ]}
              data={data.map((r) => ({ ...r }))}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-danger-mid bg-danger-light p-4 text-sm text-danger-base">{error}</div>
      )}

      {data && (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-stone-50">
                <th className="text-left px-4 py-2 font-medium text-xs text-stone-500">Komponen</th>
                <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Saldo Awal</th>
                <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Penambahan</th>
                <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Pengurangan</th>
                <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Saldo Akhir</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.map((r, i) => (
                <tr key={i} className="hover:bg-stone-50">
                  <td className="px-4 py-3 text-stone-700">{r.component}</td>
                  <td className="px-4 py-3 text-right font-mono text-stone-700">{formatRupiah(r.openingBalance)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-600">{r.addition > 0 ? formatRupiah(r.addition) : ""}</td>
                  <td className="px-4 py-3 text-right font-mono text-red-500">{r.deduction > 0 ? `(${formatRupiah(r.deduction)})` : ""}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-stone-800">{formatRupiah(r.closingBalance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-stone-50 font-semibold">
                <td className="px-4 py-3 text-stone-800">Total Ekuitas</td>
                <td className="px-4 py-3 text-right font-mono text-stone-800">{formatRupiah(totalOpening)}</td>
                <td className="px-4 py-3 text-right font-mono"></td>
                <td className="px-4 py-3 text-right font-mono"></td>
                <td className="px-4 py-3 text-right font-mono text-stone-800">{formatRupiah(totalClosing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!data && !error && (
        <div className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-400">
          Atur periode dan klik <strong>Terapkan</strong>.
        </div>
      )}
    </div>
  );
}
