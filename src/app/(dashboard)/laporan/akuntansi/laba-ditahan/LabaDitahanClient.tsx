"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatRupiah } from "@/lib/format";
import type { LabaDitahanData } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReportExport } from "../../_shared/ReportExport";

export function LabaDitahanClient({
  data,
  error,
  fromDate,
  toDate,
}: {
  data: LabaDitahanData | null;
  error: string | null;
  fromDate: string | null;
  toDate: string | null;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(fromDate ?? "");
  const [to, setTo] = useState(toDate ?? "");

  function handleFilter() {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    router.push(`/laporan/akuntansi/laba-ditahan?${p.toString()}`);
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
        {data && (
          <div className="ml-auto">
            <ReportExport
              title="Laporan Laba Ditahan"
              filename="laba-ditahan"
              period={from || to ? `${from || "…"} s.d. ${to || "…"}` : undefined}
              subtitle="Mutasi saldo laba ditahan selama periode"
              status="FINAL"
              summary={[
                { label: "Saldo Awal Laba Ditahan", value: formatRupiah(data.openingBalance) },
                { label: "Laba (Rugi) Bersih", value: data.netIncome < 0 ? `(${formatRupiah(Math.abs(data.netIncome))})` : formatRupiah(data.netIncome) },
                { label: "Dividen", value: data.dividends > 0 ? `(${formatRupiah(data.dividends)})` : "—" },
                { label: "Saldo Akhir Laba Ditahan", value: formatRupiah(data.closingBalance) },
              ]}
              columns={[
                { header: "Komponen", key: "label" },
                { header: "Jumlah", key: "amount", format: (v) => formatRupiah(Number(v)) },
              ]}
              data={[
                { label: "Saldo Awal Laba Ditahan", amount: data.openingBalance },
                { label: "Laba (Rugi) Bersih Periode", amount: data.netIncome },
                ...(data.dividends > 0 ? [{ label: "Dividen", amount: -data.dividends }] : []),
                { label: "Saldo Akhir Laba Ditahan", amount: data.closingBalance },
              ]}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-danger-mid bg-danger-light p-4 text-sm text-danger-base">{error}</div>
      )}

      {data && (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <div className="divide-y divide-stone-100">
            <div className="flex items-center justify-between px-5 py-4 bg-stone-50">
              <span className="text-sm text-stone-600">Saldo Awal Laba Ditahan</span>
              <span className="font-mono text-sm font-semibold text-stone-800">{formatRupiah(data.openingBalance)}</span>
            </div>
            <div className="flex items-center justify-between px-5 py-4">
              <span className="text-sm text-stone-600">Laba (Rugi) Bersih Periode</span>
              <span className={`font-mono text-sm font-semibold ${data.netIncome >= 0 ? "text-status-success" : "text-status-danger"}`}>
                {data.netIncome >= 0 ? formatRupiah(data.netIncome) : `(${formatRupiah(Math.abs(data.netIncome))})`}
              </span>
            </div>
            {data.dividends > 0 && (
              <div className="flex items-center justify-between px-5 py-4">
                <span className="text-sm text-stone-600">Dividen</span>
                <span className="font-mono text-sm text-status-danger">({formatRupiah(data.dividends)})</span>
              </div>
            )}
            <div className="flex items-center justify-between px-5 py-4 bg-stone-50 border-t border-stone-200 font-semibold">
              <span className="text-sm text-stone-800">Saldo Akhir Laba Ditahan</span>
              <span className="font-mono text-sm text-stone-800">{formatRupiah(data.closingBalance)}</span>
            </div>
          </div>
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
