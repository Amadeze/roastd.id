"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { formatRupiah, formatDateLong } from "@/lib/format";
import type { PnLReport } from "../../keuangan/actions";
import { TrendingUp, TrendingDown, ChevronLeft, ChevronRight, FileText, FileSpreadsheet, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { getCurrentDate } from "@/lib/date-utils";
import { PageHeader } from "@/components/layout/PageHeader";
import { ReportComparisonBar } from "../_shared";
import { exportToProfessionalPdf, exportToProfessionalExcel } from "@/lib/export-utils";
import { reconciliationWarning } from "@/lib/pnl-reconciliation";
import { useState } from "react";

const MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const CATEGORY_LABELS: Record<string, string> = {
  GAJI: "Gaji & Tunjangan", UTILITAS: "Utilitas", OPERASIONAL: "Operasional",
  LAINNYA: "Lain-lain", FINISHED_GOODS: "Produk Jadi", ROASTED_BEAN: "Biji Kopi Sangrai",
  GREEN_BEAN: "Biji Kopi Mentah", PACKAGING: "Kemasan",
  BIAYA_SAMPLE_RB: "Sample Roasted Bean", BIAYA_SAMPLE_FG: "Sample Produk Jadi",
  BIAYA_SAMPLE_PKG: "Sample Kemasan", KERUGIAN_MATERIAL: "Kerugian Material",
  PENDAPATAN_LAINNYA: "Pendapatan Lainnya",
  BAHAN_BAKU: "Bahan Baku", TENAGA_KERJA: "Tenaga Kerja Langsung",
  OVERHEAD_PABRIK: "Overhead Pabrik",
};

const ACCENT = "var(--stage-roasting)";

function pct(part: number, total: number): string {
  if (total === 0) return "–";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function buildPnLExportConfig(report: PnLReport) {
  const period = `${MONTHS[report.month - 1]} ${report.year}`;
  const filename = `Laba_Rugi_${MONTHS[report.month - 1]}_${report.year}`;
  const fmt = (v: number) => formatRupiah(v);
  const pct2 = (p: number, t: number) => t > 0 ? `${((p / t) * 100).toFixed(1)}%` : "–";

  const summary = [
    { label: "Total Pendapatan",  value: fmt(report.revenue) },
    { label: "Laba Kotor",        value: fmt(report.grossProfit) },
    { label: "Gross Margin",      value: pct2(report.grossProfit, report.revenue) },
    { label: "Total OPEX",        value: fmt(report.opex) },
    { label: "Laba Bersih",       value: fmt(report.netProfit) },
    { label: "Net Margin",        value: pct2(report.netProfit, report.revenue) },
  ];

  const revenueRows = report.revenueBreakdown.length > 0
    ? report.revenueBreakdown.map(i => ({ kat: CATEGORY_LABELS[i.category] || i.category, jml: i.amount, pct: pct2(i.amount, report.revenue) }))
    : [{ kat: "Penjualan Produk", jml: report.revenue, pct: "100%" }];
  revenueRows.push({ kat: "TOTAL PENDAPATAN", jml: report.revenue, pct: "100%" });

  const cogsRows = report.cogsBreakdown.length > 0
    ? report.cogsBreakdown.map(i => ({ kat: CATEGORY_LABELS[i.category] || i.category, jml: i.amount, pct: pct2(i.amount, report.revenue) }))
    : [{ kat: "HPP Produk Terjual", jml: report.cogs, pct: pct2(report.cogs, report.revenue) }];
  cogsRows.push({ kat: "TOTAL HPP", jml: report.cogs, pct: pct2(report.cogs, report.revenue) });

  const opexRows = report.opexBreakdown.map(i => ({ kat: CATEGORY_LABELS[i.category] || i.category, jml: i.amount, pct: pct2(i.amount, report.revenue) }));
  opexRows.push({ kat: "TOTAL BEBAN OPERASIONAL", jml: report.opex, pct: pct2(report.opex, report.revenue) });

  const profitRows = [
    { kat: "Laba Kotor",   jml: report.grossProfit, pct: pct2(report.grossProfit, report.revenue) },
    { kat: "Laba Bersih",  jml: report.netProfit,   pct: pct2(report.netProfit, report.revenue) },
  ];

  const stdCols = [
    { header: "Keterangan",       accessor: (r: {kat:string;jml:number;pct:string}) => r.kat },
    { header: "Jumlah (IDR)",     accessor: (r: {kat:string;jml:number;pct:string}) => fmt(r.jml), align: "right" as const },
    { header: "% Revenue",        accessor: (r: {kat:string;jml:number;pct:string}) => r.pct, align: "right" as const },
  ];

  return {
    filename,
    summary,
    period,
    sections: [
      { title: "I. Pendapatan Usaha",          columns: stdCols, data: revenueRows },
      { title: "II. Harga Pokok Penjualan",    columns: stdCols, data: cogsRows },
      { title: "III. Beban Operasional",        columns: stdCols, data: opexRows },
      { title: "Ikhtisar Laba",                 columns: stdCols, data: profitRows },
    ],
    flatData: [
      ...revenueRows, { kat: "---", jml: 0, pct: "" },
      ...cogsRows,    { kat: "---", jml: 0, pct: "" },
      ...opexRows,    { kat: "---", jml: 0, pct: "" },
      ...profitRows,
    ],
    flatCols: stdCols,
  };
}

async function doExportPdf(report: PnLReport) {
  const cfg = buildPnLExportConfig(report);
  const brand = report.businessName || "Laporan Keuangan";
  await exportToProfessionalPdf({
    title: "Laporan Laba Rugi",
    subtitle: `${brand} · Laporan Laba Rugi`,
    filename: cfg.filename,
    sheetName: "P&L",
    columns: cfg.flatCols as Parameters<typeof exportToProfessionalPdf>[0]["columns"],
    data: cfg.flatData as Record<string, unknown>[],
    summary: cfg.summary,
    period: cfg.period,
    status: "DRAFT",
    sections: cfg.sections as Parameters<typeof exportToProfessionalPdf>[0]["sections"],
    generatedBy: brand,
  });
}

async function doExportExcel(report: PnLReport) {
  const cfg = buildPnLExportConfig(report);
  const brand = report.businessName || "Laporan Keuangan";
  await exportToProfessionalExcel({
    title: "Laporan Laba Rugi",
    subtitle: `${brand} · Laporan Laba Rugi`,
    filename: cfg.filename,
    sheetName: "P&L",
    columns: cfg.flatCols as Parameters<typeof exportToProfessionalExcel>[0]["columns"],
    data: cfg.flatData as Record<string, unknown>[],
    summary: cfg.summary,
    period: cfg.period,
    status: "DRAFT",
    generatedBy: brand,
  });
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="border-b border-stone-200 bg-stone-50 px-5 py-2">
      <span className="text-xs font-bold uppercase tracking-widest text-stone-500">{label}</span>
    </div>
  );
}

interface LineRowProps {
  label: string; value: number; indent?: 0 | 1 | 2; bold?: boolean;
  highlight?: "positive" | "negative" | "neutral"; separator?: "top" | "double" | "bottom";
  percentage?: string; showSign?: boolean;
}

function LineRow({ label, value, indent = 0, bold = false, highlight, separator, percentage, showSign = false }: LineRowProps) {
  const indentCls = ["", "ml-6", "ml-12"][indent];
  const valueCls = cn(
    "tabular-nums font-mono", bold ? "font-bold" : "font-medium",
    highlight === "positive" && "text-emerald-700", highlight === "negative" && "text-red-600",
    highlight === "neutral" && "text-stone-600", !highlight && "text-stone-800",
  );
  const rowCls = cn(
    "grid grid-cols-[1fr_auto_auto] items-center gap-x-2 sm:gap-x-6 px-5 py-2.5",
    separator === "double" && "border-t-2 border-double border-stone-300",
    separator === "top" && "border-t border-stone-200",
    separator === "bottom" && "border-b border-stone-200",
    bold && separator !== "double" && "bg-stone-50/50",
  );

  return (
    <div className={rowCls}>
      <span className={cn("text-sm", indentCls, bold ? "font-semibold text-stone-800" : "text-stone-600")}>{label}</span>
      <span className="text-xs text-stone-400 text-right min-w-[44px]">{percentage ?? ""}</span>
      <span className={cn("text-sm text-right min-w-[120px] sm:min-w-[180px]", valueCls)}>
        {showSign && value > 0 ? "+" : ""}
        {value < 0 ? `(${formatRupiah(Math.abs(value))})` : formatRupiah(value)}
      </span>
    </div>
  );
}

interface PnLReportClientProps {
  report: PnLReport;
  hideLayout?: boolean;
}

export function PnLReportClient({ report, hideLayout }: PnLReportClientProps) {
  const [exporting, setExporting] = useState<"pdf" | "excel" | null>(null);
  const handlePdf = async () => { setExporting("pdf"); try { await doExportPdf(report); } finally { setExporting(null); } };
  const handleExcel = async () => { setExporting("excel"); try { await doExportExcel(report); } finally { setExporting(null); } };
  const { month, year, revenue, cogs, grossProfit, opex, netProfit, opexBreakdown, revenueBreakdown, cogsBreakdown, cogsComponentBreakdown, salesVolumeUnits } = report;
  const grossMargin = pct(grossProfit, revenue);
  const netMargin = pct(netProfit, revenue);
  const cogsRatio = pct(cogs, revenue);
  const opexRatio = pct(opex, revenue);

  const chartColors = ["var(--stage-sales)", "var(--stage-roasting)", "var(--stage-inventory)", "var(--stage-production)", "var(--stage-finance)", "var(--ink-tertiary)"];

  const content = (
    <>
      {/* Reconciliation Alert — hanya muncul bila ada selisih nyata (> 1 sen). */}
      {(() => {
        const warning = reconciliationWarning(report.reconciliationDifference);
        return warning ? (
          <div className="mb-6 rounded-lg border border-danger-mid bg-danger-light px-4 py-3 text-xs font-medium text-danger-base">
            <strong>{warning.split(":")[0]}:</strong>{" "}
            {warning.split(": ")[1]}
          </div>
        ) : null;
      })()}

      {/* KPI Row */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "Total Pendapatan", value: revenue, icon: TrendingUp, color: "text-blue-700 bg-blue-50", prev: report.previousMonthRevenue },
          { label: "Laba Kotor", value: grossProfit, icon: TrendingUp, color: "text-emerald-700 bg-emerald-50", prev: report.previousMonthGrossProfit, pct: grossMargin },
          { label: "Beban (OPEX)", value: opex, icon: TrendingDown, color: "text-rose-700 bg-rose-50", prev: report.previousMonthOpex, pct: opexRatio },
          { label: "Laba Bersih", value: netProfit, icon: netProfit >= 0 ? TrendingUp : TrendingDown, color: netProfit >= 0 ? "text-violet-700 bg-violet-50" : "text-rose-700 bg-rose-50", prev: report.previousMonthNetProfit, pct: netMargin },
          { label: "Volume Terjual", value: `${salesVolumeUnits.toLocaleString("id-ID")} pcs`, icon: TrendingUp, color: "text-amber-700 bg-amber-50" },
        ].map((item, idx) => (
          <div key={idx} className="rounded-xl border border-stone-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-stone-500">{item.label}</p>
                <p className={cn("mt-1 font-mono text-lg font-black tabular-nums", item.color.split(" ")[0])}>
                  {typeof item.value === "number" && item.value < 0
                    ? `(${formatRupiah(Math.abs(item.value))})`
                    : typeof item.value === "number" ? formatRupiah(item.value) : item.value}
                </p>
                {(item as any).pct && <p className="text-xs text-stone-400">Margin: {(item as any).pct}</p>}
              </div>
              <div className={cn("rounded-lg p-2", item.color.split(" ").slice(1).join(" "))}>
                <item.icon size={16} className={item.color.split(" ")[0]} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Comparison */}
      {report.previousMonthRevenue !== undefined && (
        <div className="mb-6">
          <ReportComparisonBar
            title="vs Bulan Lalu"
            items={[
              { label: "Revenue", current: revenue, previous: report.previousMonthRevenue || 0, formatter: (v) => formatRupiah(v) },
              { label: "Laba Kotor", current: grossProfit, previous: report.previousMonthGrossProfit || 0, formatter: (v) => formatRupiah(v) },
              { label: "OPEX", current: opex, previous: report.previousMonthOpex || 0, formatter: (v) => formatRupiah(v), inverse: true },
              { label: "Laba Bersih", current: netProfit, previous: report.previousMonthNetProfit || 0, formatter: (v) => formatRupiah(v) },
            ]}
          />
        </div>
      )}

      {/* Rincian (drill-down) */}
      <div className="mb-6 rounded-xl border border-stone-200 bg-white p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-wider text-stone-500">
          Rincian Per Komponen
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Link
            href={`/laporan/keuangan/sales?start=${year}-${String(month).padStart(2, "0")}-01&end=${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`}
            className="group rounded-lg border border-stone-200 p-3 transition-colors hover:border-blue-300 hover:bg-blue-50/40"
          >
            <p className="text-xs font-semibold text-stone-700 group-hover:text-blue-700">Penjualan per Produk &amp; Retur</p>
            <p className="mt-0.5 text-[11px] text-stone-400">Breakdown pendapatan, HPP historis, margin &amp; analitik retur</p>
          </Link>
          <Link
            href={`/laporan/keuangan/expenses?start=${year}-${String(month).padStart(2, "0")}-01&end=${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`}
            className="group rounded-lg border border-stone-200 p-3 transition-colors hover:border-amber-300 hover:bg-amber-50/40"
          >
            <p className="text-xs font-semibold text-stone-700 group-hover:text-amber-700">Beban Operasional</p>
            <p className="mt-0.5 text-[11px] text-stone-400">Detail pengeluaran &amp; kategori beban</p>
          </Link>
          <Link
            href="/laporan/akuntansi/buku-besar"
            className="group rounded-lg border border-stone-200 p-3 transition-colors hover:border-violet-300 hover:bg-violet-50/40"
          >
            <p className="text-xs font-semibold text-stone-700 group-hover:text-violet-700">Buku Besar (GL)</p>
            <p className="mt-0.5 text-[11px] text-stone-400">Jurnal asal angka Laba Bersih pembukuan</p>
          </Link>
        </div>
      </div>

      {/* Charts */}
      <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex h-[260px] flex-col rounded-xl border border-stone-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-stone-500">Distribusi Pendapatan</h3>
          <div className="flex-1 min-h-0">
            {revenue > 0 ? (() => {
              const pieData = [
                { name: "HPP", amount: cogs },
                { name: "Operasional", amount: opex },
                { name: "Laba Bersih", amount: Math.max(0, netProfit) },
              ].filter(d => d.amount > 0);
              const pieColors = ["var(--ink-secondary)", "var(--status-danger)", "var(--stage-finance)"];
              return (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="amount" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={75} paddingAngle={2}>
                      {pieData.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} />)}
                    </Pie>
                    <RechartsTooltip formatter={(v: any) => formatRupiah(Number(v))} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: "11px" }} />
                  </PieChart>
                </ResponsiveContainer>
              );
            })() : (
              <div className="h-full flex items-center justify-center text-sm text-stone-400">Belum ada pendapatan</div>
            )}
          </div>
        </div>
        <div className="flex h-[260px] flex-col rounded-xl border border-stone-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-stone-500">Bulan Lalu vs Bulan Ini</h3>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[
                { name: "Bulan Lalu", Revenue: report.previousMonthRevenue || 0, Expenses: (report.previousMonthCogs || 0) + (report.previousMonthOpex || 0) },
                { name: "Bulan Ini", Revenue: revenue, Expenses: cogs + opex },
              ]} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--technical-line)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(val) => `${(val / 1000000).toFixed(0)}jt`} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={50} />
                <RechartsTooltip formatter={(v: any) => formatRupiah(Number(v))} cursor={{ fill: "transparent" }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: "11px" }} />
                <Bar dataKey="Revenue" fill="var(--status-info)" radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar dataKey="Expenses" fill="var(--status-danger)" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* P&L Statement */}
      <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
        <div className="border-b border-stone-100 bg-gradient-to-r from-stone-50 to-white px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-stone-800">Laporan Laba Rugi</h2>
              <p className="text-xs text-stone-400">
                1 {MONTHS[month - 1]} – {new Date(year, month, 0).getDate()} {MONTHS[month - 1]} {year}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold text-stone-500 uppercase tracking-wider">{report.businessName || "Laporan Keuangan"}</p>
              <p className="text-xs text-stone-400">Dalam Rupiah (IDR)</p>
            </div>
          </div>
        </div>

        {/* Revenue */}
        <SectionHeader label="I. Pendapatan Usaha" />
        {revenueBreakdown.length > 0 ? revenueBreakdown.map((item) => (
          <LineRow key={item.category} label={CATEGORY_LABELS[item.category] || item.category} value={item.amount} indent={1} percentage={pct(item.amount, revenue)} />
        )) : <LineRow label="Penjualan Produk" value={revenue} indent={1} percentage="100%" />}
        <LineRow label="Total Pendapatan" value={revenue} bold separator="top" percentage="100%" />

        {/* COGS */}
        <SectionHeader label="II. Harga Pokok Penjualan" />
        {cogsBreakdown.length > 0 ? cogsBreakdown.map((item) => (
          <LineRow key={item.category} label={CATEGORY_LABELS[item.category] || item.category} value={item.amount} indent={1} percentage={pct(item.amount, revenue)} />
        )) : <LineRow label="HPP Produk Terjual" value={cogs} indent={1} percentage={cogsRatio} />}
        {cogsComponentBreakdown.length > 0 && (
          <>
            {cogsComponentBreakdown.map((item) => (
              <LineRow key={item.category} label={"— " + (CATEGORY_LABELS[item.category] || item.category)} value={item.amount} indent={2} percentage={pct(item.amount, revenue)} />
            ))}
          </>
        )}
        <LineRow label="Total HPP" value={cogs} bold separator="top" percentage={cogsRatio} />

        {/* Gross Profit */}
        <div className="border-y border-emerald-100/80 bg-emerald-50/50">
          <LineRow label="LABA KOTOR (Gross Profit)" value={grossProfit} bold highlight={grossProfit >= 0 ? "positive" : "negative"} percentage={grossMargin} />
        </div>

        {/* OPEX */}
        <SectionHeader label="III. Beban Operasional" />
        {opexBreakdown.length === 0 ? (
          <div className="px-5 py-3 text-sm italic text-stone-400">Tidak ada pengeluaran tercatat bulan ini.</div>
        ) : opexBreakdown.map((item) => (
          <LineRow key={item.category} label={CATEGORY_LABELS[item.category] || item.category} value={item.amount} indent={1} percentage={pct(item.amount, revenue)} />
        ))}
        <LineRow label="Total Beban Operasional" value={opex} bold separator="top" percentage={opexRatio} highlight="negative" />

        {/* Net Profit */}
        <div className={cn("border-y", netProfit >= 0 ? "border-violet-100/80 bg-violet-50/50" : "border-red-100/80 bg-red-50/50")}>
          <LineRow label="LABA BERSIH (Net Profit)" value={netProfit} bold separator="double" highlight={netProfit >= 0 ? "positive" : "negative"} percentage={netMargin} />
        </div>

        {/* Footer */}
        <div className="border-t border-stone-100 bg-stone-50/60 px-5 py-3">
          <div className="flex items-center justify-between text-xs text-stone-400">
            <span>Dibuat otomatis oleh roastd.id</span>
            <span className="tabular-nums">Dicetak: {formatDateLong(getCurrentDate())}</span>
          </div>
        </div>
      </div>

      {/* OPEX Detail */}
      {opexBreakdown.length > 0 && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white overflow-hidden">
          <div className="border-b border-stone-100 px-5 py-3">
            <h3 className="text-sm font-bold text-stone-700">Rincian Beban Operasional</h3>
          </div>
          <div className="divide-y divide-stone-100">
            {opexBreakdown.map((item) => {
              const ratio = opex > 0 ? (item.amount / opex) * 100 : 0;
              return (
                <div key={item.category} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-[120px] sm:min-w-[180px] text-sm font-medium text-stone-700">
                    {CATEGORY_LABELS[item.category] || item.category}
                  </div>
                  <div className="flex-1">
                    <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
                      <div className="h-full rounded-full bg-rose-400 transition-all" style={{ width: `${Math.max(ratio, 2)}%` }} />
                    </div>
                  </div>
                  <div className="text-right min-w-[56px] tabular-nums text-xs font-mono text-stone-500">{ratio.toFixed(1)}%</div>
                  <div className="text-right min-w-[100px] sm:min-w-[140px] tabular-nums text-sm font-semibold text-stone-800 font-mono">{formatRupiah(item.amount)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Summary Strip */}
      <div className={cn(
        "mt-4 rounded-xl border p-5 flex items-center justify-between",
        netProfit >= 0 ? "border-emerald-200/60 bg-emerald-50/60" : "border-red-200/60 bg-red-50/60",
      )}>
        <div className="flex items-center gap-3">
          <div className={cn("rounded-xl p-2.5", netProfit >= 0 ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600")}>
            {netProfit >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
          </div>
          <div>
            <p className="text-xs font-medium text-stone-500">Laba Bersih · {MONTHS[month - 1]} {year}</p>
            <p className={cn("text-xl font-black font-mono tabular-nums", netProfit >= 0 ? "text-emerald-700" : "text-red-600")}>
              {netProfit < 0 ? `(${formatRupiah(Math.abs(netProfit))})` : formatRupiah(netProfit)}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-stone-400">Margin Laba Bersih</p>
          <p className={cn("text-2xl font-black tabular-nums", netProfit >= 0 ? "text-emerald-600" : "text-red-500")}>{netMargin}</p>
        </div>
      </div>
    </>
  );

  if (hideLayout) return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Button onClick={handlePdf} disabled={exporting !== null} variant="outline" className="h-8 gap-1.5 border-stone-200 bg-white shadow-sm">
          {exporting === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} PDF
        </Button>
        <Button onClick={handleExcel} disabled={exporting !== null} variant="outline" className="h-8 gap-1.5 border-stone-200 bg-white shadow-sm">
          {exporting === "excel" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Excel
        </Button>
        <Button onClick={() => window.print()} variant="outline" className="h-8 gap-1.5 border-stone-200 bg-white shadow-sm">
          Cetak
        </Button>
      </div>
      {content}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Laporan Laba Rugi"
        eyebrow="Intelligence"
        description={`Profit & Loss Statement · ${MONTHS[month - 1]} ${year}`}
        actions={
          <>
            <Button onClick={handlePdf} disabled={exporting !== null} variant="outline" className="h-8 gap-1.5 border-white/60 bg-white/40 shadow-sm">
              {exporting === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} PDF
            </Button>
            <Button onClick={handleExcel} disabled={exporting !== null} variant="outline" className="h-8 gap-1.5 border-white/60 bg-white/40 shadow-sm">
              {exporting === "excel" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Excel
            </Button>
            <Button onClick={() => window.print()} variant="outline" className="h-8 gap-1.5 border-white/60 bg-white/40 shadow-sm">
              Cetak
            </Button>
          </>
        }
      />
      <div className="custom-scrollbar flex-1 overflow-auto">
        <div className="mx-auto max-w-[1600px] p-4 md:p-6 lg:p-8">{content}</div>
      </div>
    </div>
  );
}
