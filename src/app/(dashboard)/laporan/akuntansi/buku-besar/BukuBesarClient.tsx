"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatRupiah, formatDate } from "@/lib/format";
import type { BukuBesarData } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ReportExport } from "../../_shared/ReportExport";

const TYPE_LABELS: Record<string, string> = {
  ASSET: "Aset",
  LIABILITY: "Kewajiban",
  EQUITY: "Ekuitas",
  REVENUE: "Pendapatan",
  EXPENSE: "Beban",
};

export function BukuBesarClient({
  accounts,
  data,
  error,
  selectedAccount,
  fromDate,
  toDate,
}: {
  accounts: { id: string; code: string; name: string; type: string; isActive: boolean }[];
  data: BukuBesarData | null;
  error: string | null;
  selectedAccount: string | null;
  fromDate: string | null;
  toDate: string | null;
}) {
  const router = useRouter();
  const [accountCode, setAccountCode] = useState(selectedAccount ?? "");
  const [from, setFrom] = useState(fromDate ?? "");
  const [to, setTo] = useState(toDate ?? "");

  function handleView() {
    const params = new URLSearchParams();
    if (accountCode) params.set("account", accountCode);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    router.push(`/laporan/akuntansi/buku-besar?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-stone-200 bg-white p-5 flex flex-wrap items-end gap-4">
        <div className="space-y-2 min-w-[240px]">
          <Label htmlFor="account">Akun</Label>
          <Select value={accountCode} onValueChange={(v) => setAccountCode(v ?? "")}>
            <SelectTrigger id="account">
              <SelectValue placeholder="Pilih akun" />
            </SelectTrigger>
            <SelectContent>
              {accounts
                .filter((a) => a.isActive)
                .map((a) => (
                  <SelectItem key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="from">Dari Tanggal</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="to">Sampai Tanggal</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={handleView} disabled={!accountCode}>
          Lihat
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger-mid bg-danger-light p-4 text-sm text-danger-base">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="rounded-xl border border-stone-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-stone-800">
                  {data.accountCode} — {data.accountName}
                </h2>
                <Badge variant="outline" className="mt-1 text-xs">
                  {TYPE_LABELS[data.accountType] ?? data.accountType}
                </Badge>
              </div>
              <div className="text-right">
                <div className="text-xs text-stone-400">Saldo Awal</div>
                <div className="text-sm font-semibold text-stone-700">
                  {formatRupiah(data.openingBalance)}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-50 px-4 py-2">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-500">Mutasi</span>
              <ReportExport
                title={`Buku Besar - ${data.accountCode} ${data.accountName}`}
                filename={`buku-besar-${data.accountCode}`}
                period={from || to ? `${from || "…"} s.d. ${to || "…"}` : undefined}
                subtitle="Riwayat mutasi per akun dengan saldo berjalan"
                status="FINAL"
                summary={[
                  { label: "Saldo Awal", value: formatRupiah(data.openingBalance) },
                  { label: "Total Debit", value: formatRupiah(data.lines.reduce((s, l) => s + l.debit, 0)) },
                  { label: "Total Kredit", value: formatRupiah(data.lines.reduce((s, l) => s + l.credit, 0)) },
                  { label: "Saldo Akhir", value: formatRupiah(data.closingBalance) },
                ]}
                columns={[
                  { header: "Tanggal", key: "date", format: (v) => formatDate(v as string) },
                  { header: "Jurnal", key: "journalCode" },
                  { header: "Keterangan", key: "description" },
                  { header: "Debit", key: "debit", format: (v) => (Number(v) > 0 ? formatRupiah(Number(v)) : "") },
                  { header: "Kredit", key: "credit", format: (v) => (Number(v) > 0 ? formatRupiah(Number(v)) : "") },
                  { header: "Saldo", key: "balance", format: (v) => formatRupiah(Number(v)) },
                ]}
                data={data.lines.map((l) => ({ ...l }))}
              />
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-stone-50">
                  <th className="text-left px-4 py-2 font-medium text-xs text-stone-500">Tanggal</th>
                  <th className="text-left px-4 py-2 font-medium text-xs text-stone-500">Jurnal</th>
                  <th className="text-left px-4 py-2 font-medium text-xs text-stone-500">Keterangan</th>
                  <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Debit</th>
                  <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Kredit</th>
                  <th className="text-right px-4 py-2 font-medium text-xs text-stone-500">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                <tr className="bg-stone-50/50">
                  <td colSpan={3} className="px-4 py-2 text-xs text-stone-400">
                    Saldo awal
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-stone-400">
                    {formatRupiah(0)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-stone-400">
                    {formatRupiah(0)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-stone-500">
                    {formatRupiah(data.openingBalance)}
                  </td>
                </tr>
                {data.lines.map((l, i) => (
                  <tr key={i} className="hover:bg-stone-50">
                    <td className="px-4 py-2 text-xs text-stone-500">{formatDate(l.date)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-600">{l.journalCode}</td>
                    <td className="px-4 py-2 text-xs text-stone-700">
                      {l.description}
                      {l.reference && (
                        <span className="ml-1 text-xs text-stone-400">({l.reference})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-stone-700">
                      {l.debit > 0 ? formatRupiah(l.debit) : ""}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-stone-700">
                      {l.credit > 0 ? formatRupiah(l.credit) : ""}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-stone-800">
                      {formatRupiah(l.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-stone-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-xs text-stone-500">
                    Saldo akhir
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-stone-700">
                    {formatRupiah(data.lines.reduce((s, l) => s + l.debit, 0))}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-stone-700">
                    {formatRupiah(data.lines.reduce((s, l) => s + l.credit, 0))}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-stone-800">
                    {formatRupiah(data.closingBalance)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {!data && !error && (
        <div className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-400">
          Pilih akun dan klik <strong>Lihat</strong> untuk menampilkan buku besar.
        </div>
      )}
    </div>
  );
}
