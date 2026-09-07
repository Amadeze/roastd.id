"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Flame, ChevronDown, ChevronUp,
  Package, Scale, TrendingDown,
  Factory, Coffee, FlaskConical, CopyPlus, Activity,
} from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Legend,
} from "recharts";
import {
  type MetricStats,
  type RoastConsistencyReport,
  isOutlier,
} from "@/lib/roast-intelligence";
import { createProfileFromRoast } from "../../../actions";

type RoastData = {
  id: string;
  title: string | null;
  roastDate: string | null;
  duration: number | null;
  chargeTemperature: number | null;
  dropTemperature: number | null;
  firstCrackStartTime: number | null;
  firstCrackEndTime: number | null;
  greenWeightGrams: number | null;
  roastedWeightGrams: number | null;
  lossPercent: number | null;
  beanTemperatureSeries: Array<{ second: number; value: number }> | null;
  environmentalTemperatureSeries: Array<{ second: number; value: number }> | null;
  events: Array<{ second: number; type: string; value?: string | number; label?: string }> | null;
  metadata: Record<string, unknown> | null;
};

type ChildBatch = {
  id: string;
  index: number;
  roastId: string | null;
  roastDuration: number | null;
  dropTemp: number | null;
  recordedAt: string;
  matchScore: number | null;
  matchStatus: "ON_TRACK" | "WATCH" | "DIVERGED" | "INVALID" | null;
  matchDetails: {
    btRmse?: number | null;
    rorRmse?: number | null;
    durationDeltaSeconds?: number | null;
  } | null;
  roast: RoastData | null;
};

type DownstreamBatch = {
  type: "PRD" | "GRD" | "EXP";
  id: string;
  code: string;
  productName: string;
  quantity: number;
  createdAt: string;
};

type OutputPlacement = {
  quantityKg: number;
  batchCode: string;
  location: {
    code: string;
    name: string;
    warehouseName: string;
  };
};

type RecapData = {
  id: string;
  code: string;
  status: string;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  inputProduct: { id: string; name: string };
  outputProduct: { id: string; name: string };
  machine: { id: string; name: string; capacityKg: number | null } | null;
  createdBy: { id: string; name: string };
  targetWeightKg: number;
  actualOutputKg: number | null;
  totalLossPercent: number | null;
  childCount: number;
  completedCount: number;
  pendingCount: number;
  referenceProfile: {
    id: string;
    title: string;
    duration: number | null;
    beanTemperatureSeries: Array<{ second: number; value: number }> | null;
    environmentalTemperatureSeries: Array<{ second: number; value: number }> | null;
    events: Array<{ second: number; type: string }> | null;
  } | null;
  children: ChildBatch[];
  summary: {
    totalGreenGrams: number;
    totalRoastedGrams: number;
    avgDuration: number | null;
    roastCount: number;
  };
  downstreamBatches: DownstreamBatch[];
  outputPlacements: OutputPlacement[];
  /** Control chart konsistensi antar-batch untuk produk output yang sama. */
  consistency: RoastConsistencyReport;
};

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "numeric", month: "short", year: "numeric",
  });
}

/** Cloneable = roast punya suhu charge & drop (syarat minimal turunkan profil). */
function isCloneableRoastData(roast: RoastData): boolean {
  return typeof roast.chargeTemperature === "number" && typeof roast.dropTemperature === "number";
}

const VERDICT_STYLE: Record<RoastConsistencyReport["verdict"], { label: string; className: string }> = {
  STABLE: { label: "Konsisten", className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
  WATCH: { label: "Waspada", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
  VARIABLE: { label: "Bervariasi", className: "bg-red-500/10 text-red-600 border-red-500/30" },
  NEEDS_DATA: { label: "Data Belum Cukup", className: "bg-gray-500/10 text-gray-500 border-gray-400/30" },
};

function ConsistencyPanel({
  report,
  batchChildren,
}: {
  report: RoastConsistencyReport;
  batchChildren: Array<{ index: number; roastId: string | null; roast: RoastData | null }>;
}) {
  const verdict = VERDICT_STYLE[report.verdict];

  // Tandai anak batch yang nilainya keluar dari batas mean ± 2σ.
  const outlierIndexes = new Set<number>();
  if (report.verdict !== "NEEDS_DATA") {
    for (const child of batchChildren) {
      const r = child.roast;
      if (!r) continue;
      const statsByKey = new Map(report.metrics.map((m) => [m.key, m]));
      const flagged =
        isOutlier(r.lossPercent, statsByKey.get("lossPercent")) ||
        isOutlier(r.duration, statsByKey.get("duration")) ||
        isOutlier(r.dropTemperature, statsByKey.get("dropTemperature")) ||
        isOutlier(r.firstCrackStartTime, statsByKey.get("firstCrackStartTime"));
      if (flagged) outlierIndexes.add(child.index);
    }
  }

  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--domain-roasting)]/10 text-[var(--domain-roasting)]">
            <Activity size={15} />
          </span>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Konsistensi Antar-Batch</h3>
            <p className="text-xs text-[var(--text-tertiary)]">{report.note}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {outlierIndexes.size > 0 && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-600">
              Batch #{[...outlierIndexes].sort((a, b) => a - b).join(", #")} di luar batas
            </span>
          )}
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${verdict.className}`}>
            {verdict.label}
            {report.score != null && <b className="tabular-nums">{report.score}</b>}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        {report.metrics.map((metric) => (
          <MetricCard key={metric.key} metric={metric} />
        ))}
      </div>
    </div>
  );
}

function MetricCard({ metric }: { metric: MetricStats }) {
  const hasControl = metric.lower !== null && metric.upper !== null;
  return (
    <div className="rounded-xl border border-[var(--glass-border)] px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {metric.label} · n={metric.sampleCount}
      </p>
      <p className="mt-1 text-base font-black tabular-nums text-[var(--text-primary)]">
        {metric.mean}
        <span className="text-xs font-semibold text-[var(--text-secondary)]"> ±{metric.stdDev}{metric.unit}</span>
      </p>
      <p className="mt-0.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
        {hasControl ? `Batas ${metric.lower}–${metric.upper}${metric.unit}` : "Belum ada batas kontrol"}
      </p>
    </div>
  );
}

export function BatchRecapClient({ data }: { data: RecapData }) {
  const [expandedChild, setExpandedChild] = useState<number | null>(null);
  const [cloningRoastId, setCloningRoastId] = useState<string | null>(null);
  const router = useRouter();

  const handleCloneProfile = async (roastId: string) => {
    setCloningRoastId(roastId);
    try {
      const result = await createProfileFromRoast(roastId);
      if (!result.success) {
        toast.error(result.error ?? "Gagal membuat profil.");
        return;
      }
      toast.success(`Profil "${result.profile.name}" tersimpan di kurva acuan.`);
      router.refresh();
    } finally {
      setCloningRoastId(null);
    }
  };

  const lossColor = data.totalLossPercent != null
    ? data.totalLossPercent < 18 ? "text-emerald-600"
    : data.totalLossPercent <= 25 ? "text-amber-600"
    : "text-red-600"
    : "text-[var(--text-tertiary)]";

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          icon={<Package size={16} />}
          label="Input"
          value={`${data.targetWeightKg} kg`}
          sub={data.inputProduct.name}
        />
        <SummaryCard
          icon={<Scale size={16} />}
          label="Output"
          value={data.actualOutputKg != null ? `${data.actualOutputKg} kg` : "-"}
          sub={data.outputProduct.name}
        />
        <SummaryCard
          icon={<TrendingDown size={16} />}
          label="Susut"
          value={data.totalLossPercent != null ? `${data.totalLossPercent}%` : "-"}
          valueClass={lossColor}
        />
        <SummaryCard
          icon={<Flame size={16} />}
          label="Rata-rata Durasi"
          value={data.summary.avgDuration != null ? formatDuration(data.summary.avgDuration) : "-"}
          sub={`${data.summary.roastCount} roasting`}
        />
      </div>

      {/* Konsistensi antar-batch (control chart deterministik) */}
      <ConsistencyPanel
        report={data.consistency}
        batchChildren={data.children}
      />

      {/* Batch Info */}
      <div className="glass-card rounded-2xl p-5">
        <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3">Info Batch</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <InfoField label="Kode" value={data.code} />
          <InfoField label="Status" value={data.status} />
          <InfoField label="Mesin" value={data.machine?.name ?? "-"} />
          <InfoField label="Kapasitas" value={data.machine?.capacityKg ? `${data.machine.capacityKg} kg` : "-"} />
          <InfoField label="Dibuat Oleh" value={data.createdBy.name} />
          <InfoField label="Tanggal" value={formatDate(data.createdAt)} />
          <InfoField label="Selesai" value={formatDate(data.completedAt)} />
          <InfoField label="Total Batch" value={`${data.completedCount}/${data.childCount} selesai`} />
          <InfoField label="Kurva Acuan" value={data.referenceProfile?.title ?? "Belum dipilih"} />
        </div>
        {data.notes && (
          <div className="mt-3 text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Catatan:</span> {data.notes}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link
            href="/inventory?view=stock&category=rb"
            className="text-xs font-semibold text-[var(--domain-roasting)] transition hover:underline"
          >
            Lihat stok roasted bean →
          </Link>
          {data.referenceProfile && (
            <Link
              href="/roasting/profiles"
              className="text-xs font-semibold text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] hover:underline"
            >
              Buka kurva acuan →
            </Link>
          )}
        </div>
      </div>

      {/* Child Batches */}
      <div>
        <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3">
          Detail Roasting ({data.children.length} batch)
        </h3>
        <div className="space-y-2">
          {data.children.map((child) => {
            const isExpanded = expandedChild === child.index;
            const r = child.roast;

            return (
              <div key={child.id} className="glass-card rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedChild(isExpanded ? null : child.index)}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-[var(--glass-bg-hover)] transition"
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                    r ? "bg-emerald-500/10 text-emerald-600" : "bg-gray-500/10 text-gray-400"
                  }`}>
                    {child.index}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {r?.title || `Batch ${child.index}`}
                      </span>
                      {r && (
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {r.duration ? formatDuration(r.duration) : ""}
                        </span>
                      )}
                      {child.matchScore != null && (
                        <MatchBadge score={child.matchScore} status={child.matchStatus} />
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">
                      {r ? (
                        <>
                          {r.greenWeightGrams}g → {r.roastedWeightGrams}g
                          {r.lossPercent != null && (
                            <span className={r.lossPercent < 18 ? "text-emerald-600" : r.lossPercent <= 25 ? "text-amber-600" : "text-red-600"}>
                              {" "}({r.lossPercent}%)
                            </span>
                          )}
                        </>
                      ) : (
                        "Belum ada data roast"
                      )}
                    </div>
                  </div>
                  {r && (
                    <div className="shrink-0 text-[var(--text-tertiary)]">
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </div>
                  )}
                </button>

                {isExpanded && r && (
                  <div className="border-t border-[var(--glass-border)] p-4 space-y-4">
                    {/* Stats */}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      <MiniStat label="Charge" value={r.chargeTemperature ? `${r.chargeTemperature}°C` : "-"} />
                      <MiniStat label="Drop" value={r.dropTemperature ? `${r.dropTemperature}°C` : "-"} />
                      <MiniStat label="FCs" value={r.firstCrackStartTime ? formatDuration(r.firstCrackStartTime) : "-"} />
                      <MiniStat label="Duration" value={r.duration ? formatDuration(r.duration) : "-"} />
                      <MiniStat label="Profile Match" value={child.matchScore != null ? `${Math.round(child.matchScore)}/100` : "-"} />
                    </div>

                    {child.matchDetails && (
                      <div className="flex flex-wrap gap-3 rounded-lg border border-[var(--glass-border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                        <span>BT RMSE <b>{child.matchDetails.btRmse ?? "-"}°C</b></span>
                        <span>RoR RMSE <b>{child.matchDetails.rorRmse ?? "-"}</b></span>
                        <span>Durasi Δ <b>{child.matchDetails.durationDeltaSeconds ?? "-"} detik</b></span>
                      </div>
                    )}

                    {/* AI deterministik: jadikan kurva ini profil referensi */}
                    {isCloneableRoastData(r) && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleCloneProfile(r.id)}
                          disabled={cloningRoastId === r.id}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--domain-roasting)]/30 bg-[var(--domain-roasting)]/10 px-3 text-xs font-bold text-[var(--domain-roasting)] transition hover:bg-[var(--domain-roasting)]/20 disabled:opacity-60"
                        >
                          <CopyPlus size={13} />
                          {cloningRoastId === r.id ? "Menyimpan..." : "Jadikan profil referensi"}
                        </button>
                      </div>
                    )}

                    {/* Temperature Chart */}
                    {r.beanTemperatureSeries && r.beanTemperatureSeries.length > 0 && (
                      <TemperatureChart
                        btData={r.beanTemperatureSeries}
                        etData={r.environmentalTemperatureSeries}
                        events={r.events}
                        targetBtData={data.referenceProfile?.beanTemperatureSeries ?? null}
                        targetEvents={data.referenceProfile?.events ?? null}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Hasil Roasted Bean — actual persisted placement(s) */}
      {data.outputPlacements.length > 0 && (
        <div className="glass-card rounded-2xl p-5">
          <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3">Hasil Roasted Bean</h3>
          <div className="space-y-2">
            {data.outputPlacements.map((placement) => (
              <div
                key={`${placement.batchCode}-${placement.location.code}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--glass-border)] px-3 py-2.5 text-sm"
              >
                <span className="font-bold text-[var(--text-primary)] tabular-nums">
                  {placement.quantityKg.toFixed(1)} kg
                </span>
                <span className="font-mono text-xs text-[var(--text-tertiary)]">
                  Lot {placement.batchCode}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {placement.location.warehouseName} · {placement.location.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lanjutkan ke proses berikutnya — dari hasil batch roasting ini */}
      {data.status === "COMPLETED" && (
        <div className="glass-card rounded-2xl p-5">
          <h3 className="text-sm font-bold text-[var(--text-primary)] mb-1">Lanjutkan</h3>
          <p className="text-xs text-[var(--text-tertiary)] mb-3">
            Mulai proses berikutnya dengan hasil roasting ini — tautan ke batch ini tercatat otomatis.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/produksi?productId=${data.outputProduct.id}&parentRoastBatchId=${data.id}`}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-bold text-white transition hover:bg-zinc-700"
            >
              <Factory size={15} /> Buat Produksi
            </Link>
            <Link
              href={`/grinding?sourceProductId=${data.outputProduct.id}&parentRoastBatchId=${data.id}`}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-4 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100"
            >
              <Coffee size={15} /> Grinding
            </Link>
            <Link
              href={`/eksperimen?parentRoastBatchId=${data.id}`}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-4 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100"
            >
              <FlaskConical size={15} /> Eksperimen
            </Link>
          </div>
        </div>
      )}

      {/* Downstream Batches */}
      {data.downstreamBatches.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3">
            Hasil Lanjutan ({data.downstreamBatches.length} batch)
          </h3>
          <div className="space-y-2">
            {data.downstreamBatches.map((downstream) => {
              const href =
                downstream.type === "PRD" ? "/produksi"
                : downstream.type === "GRD" ? "/grinding"
                : "/eksperimen";
              const label =
                downstream.type === "PRD" ? "Produksi"
                : downstream.type === "GRD" ? "Grinding"
                : "Eksperimen";
              return (
                <Link
                  key={downstream.id}
                  href={href}
                  className="glass-card flex items-center gap-3 rounded-xl p-3 transition hover:bg-[var(--glass-bg-hover)]"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-xs font-bold text-indigo-600">
                    {downstream.type}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {downstream.productName}
                    </p>
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {label} · {formatDate(downstream.createdAt)}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs font-bold text-[var(--text-tertiary)]">
                    {downstream.quantity} {downstream.type === "PRD" ? "unit" : "kg"}
                  </span>
                  <ChevronDown size={14} className="shrink-0 -rotate-90 text-[var(--text-tertiary)]" />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon, label, value, sub, valueClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center gap-1.5 text-[var(--text-tertiary)] mb-2">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-lg font-bold ${valueClass || "text-[var(--text-primary)]"}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">{label}</p>
      <p className="text-sm text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--glass-border)] p-2">
      <p className="text-xs text-[var(--text-tertiary)]">{label}</p>
      <p className="text-sm font-bold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function MatchBadge({
  score,
  status,
}: {
  score: number;
  status: ChildBatch["matchStatus"];
}) {
  const tone = status === "ON_TRACK"
    ? "bg-emerald-500/10 text-emerald-600"
    : status === "WATCH"
      ? "bg-amber-500/10 text-amber-600"
      : "bg-red-500/10 text-red-600";
  return <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${tone}`}>MATCH {Math.round(score)}</span>;
}

function TemperatureChart({
  btData, etData, events, targetBtData, targetEvents,
}: {
  btData: Array<{ second: number; value: number }>;
  etData: Array<{ second: number; value: number }> | null;
  events: Array<{ second: number; type: string }> | null;
  targetBtData: Array<{ second: number; value: number }> | null;
  targetEvents: Array<{ second: number; type: string }> | null;
}) {
  const points = new Map<number, { time: number; BT: number | null; ET: number | null; Target: number | null }>();
  const pointAt = (second: number) => points.get(second) ?? { time: second, BT: null, ET: null, Target: null };
  for (const bt of btData) points.set(bt.second, { ...pointAt(bt.second), BT: bt.value });
  for (const et of etData ?? []) points.set(et.second, { ...pointAt(et.second), ET: et.value });
  const actualCharge = events?.find((event) => event.type === "CHARGE")?.second ?? 0;
  const targetCharge = targetEvents?.find((event) => event.type === "CHARGE")?.second ?? 0;
  for (const target of targetBtData ?? []) {
    const alignedSecond = target.second - targetCharge + actualCharge;
    points.set(alignedSecond, { ...pointAt(alignedSecond), Target: target.value });
  }
  const chartData = [...points.values()].sort((a, b) => a.time - b.time);

  const eventMarkers = events?.filter((e) =>
    ["CHARGE", "FCs", "FCe", "SCs", "DROP"].includes(e.type),
  ) ?? [];

  const eventColors: Record<string, string> = {
    CHARGE: "var(--status-info)",
    FCs: "color-mix(in srgb, var(--stage-production-soft) 70%, var(--stage-production))",
    FCe: "color-mix(in srgb, var(--stage-production-soft) 70%, var(--stage-production))",
    SCs: "var(--status-danger)",
    DROP: "var(--instrument)",
  };

  return (
    <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-3">
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--glass-border)" />
          <Legend wrapperStyle={{ fontSize: "10px" }} />
          <XAxis
            dataKey="time"
            tickFormatter={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`}
            stroke="var(--text-tertiary)"
            fontSize={10}
            tickLine={false}
          />
          <YAxis stroke="var(--text-tertiary)" fontSize={10} tickLine={false} domain={["dataMin - 10", "dataMax + 10"]} />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--glass-bg-hover)",
              border: "1px solid var(--glass-border)",
              borderRadius: "8px",
              fontSize: "12px",
            }}
            formatter={(value, name) => [`${value}°C`, String(name)]}
            labelFormatter={(label) => {
              const min = Math.floor(Number(label) / 60);
              const sec = Number(label) % 60;
              return `${min}:${String(sec).padStart(2, "0")}`;
            }}
          />
          {eventMarkers.map((e) => (
            <ReferenceLine
              key={`${e.type}-${e.second}`}
              x={e.second}
              stroke={eventColors[e.type] || "#999"}
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
          ))}
          <Line type="monotone" dataKey="BT" stroke="var(--instrument-strong)" strokeWidth={2} dot={false} connectNulls />
          {targetBtData && targetBtData.length > 0 && (
            <Line type="monotone" dataKey="Target" stroke="var(--brass-soft)" strokeWidth={1.5} dot={false} strokeDasharray="8 6" connectNulls />
          )}
          {etData && etData.length > 0 && (
            <Line type="monotone" dataKey="ET" stroke="var(--status-info)" strokeWidth={1.5} dot={false} strokeDasharray="5 5" connectNulls />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
