"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Pause, Play, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  computeRoRSeries,
  type RoastCurvePoint,
} from "./roastCurveReplayMath";

export type { RoastCurvePoint } from "./roastCurveReplayMath";

export interface RoastCurveData {
  title?: string;
  durationSeconds?: number;
  beanTemperatureSeries: RoastCurvePoint[];
  environmentalTemperatureSeries?: RoastCurvePoint[] | null;
  events?: Array<{ second: number; type: string; label?: string }> | null;
  matchScore?: number | null;
}

interface RoastCurveReplayProps {
  data: RoastCurveData;
  /** Optional reference (parent) profile for side-by-side compare. */
  reference?: RoastCurveData | null;
  /** Show the RoR (rate of rise) overlay on the BT line. */
  showRoR?: boolean;
  /** Replay play/pause controls. Defaults to true. */
  replay?: boolean;
  /** Cap on the longest x-axis window to avoid OOM on huge replays. */
  maxReplaySeconds?: number;
}

interface DerivedPoint {
  time: number;
  BT: number | null;
  ET: number | null;
  Target: number | null;
  RoR: number | null;
}

const ROAST_EVENT_TYPES = new Set(["CHARGE", "FCs", "FCe", "SCs", "DROP"]);

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function alignReference(
  reference: RoastCurveData | null | undefined,
  actualCharge: number,
): RoastCurvePoint[] {
  if (!reference || !reference.beanTemperatureSeries.length) return [];
  const referenceCharge = reference.events?.find((e) => e.type === "CHARGE")?.second ?? 0;
  return reference.beanTemperatureSeries.map((point) => ({
    second: point.second - referenceCharge + actualCharge,
    value: point.value,
  }));
}

export function RoastCurveReplay({
  data,
  reference,
  showRoR = true,
  replay = true,
  maxReplaySeconds = 3600,
}: RoastCurveReplayProps) {
  const series = useMemo(
    () => data.beanTemperatureSeries ?? [],
    [data.beanTemperatureSeries],
  );
  const totalSeconds = useMemo(() => {
    if (data.durationSeconds && data.durationSeconds > 0) {
      return Math.min(data.durationSeconds, maxReplaySeconds);
    }
    if (series.length === 0) return 0;
    return Math.min(series[series.length - 1].second, maxReplaySeconds);
  }, [data.durationSeconds, series, maxReplaySeconds]);

  const actualCharge = data.events?.find((e) => e.type === "CHARGE")?.second ?? 0;
  const alignedReference = useMemo(
    () => alignReference(reference, actualCharge),
    [reference, actualCharge],
  );

  const rorSeries = useMemo(
    () => (showRoR ? computeRoRSeries(series) : []),
    [series, showRoR],
  );

  const merged = useMemo(() => {
    const points = new Map<number, DerivedPoint>();
    const upsert = (second: number, patch: Partial<DerivedPoint>) => {
      const existing = points.get(second) ?? {
        time: second,
        BT: null,
        ET: null,
        Target: null,
        RoR: null,
      };
      points.set(second, { ...existing, ...patch });
    };
    for (const point of series) upsert(point.second, { BT: point.value });
    for (const point of data.environmentalTemperatureSeries ?? []) {
      upsert(point.second, { ET: point.value });
    }
    for (const ref of alignedReference) upsert(ref.second, { Target: ref.value });
    for (const ror of rorSeries) {
      if (ror.value == null) continue;
      upsert(ror.second, { RoR: ror.value });
    }
    return [...points.values()].sort((a, b) => a.time - b.time);
  }, [series, data.environmentalTemperatureSeries, alignedReference, rorSeries]);

  const eventMarkers = (data.events ?? []).filter((e) => ROAST_EVENT_TYPES.has(e.type));

  const [head, setHead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  const speedOptions = [
    { label: "0.5×", value: 0.5 },
    { label: "1×", value: 1 },
    { label: "2×", value: 2 },
  ] as const;

  useEffect(() => {
    if (!replay || !playing || totalSeconds <= 0) return;
    const step = (now: number) => {
      if (lastTickRef.current == null) lastTickRef.current = now;
      const dt = ((now - lastTickRef.current) / 1000) * speed;
      lastTickRef.current = now;
      setHead((prev) => {
        const next = prev + dt;
        if (next >= totalSeconds) {
          setPlaying(false);
          return totalSeconds;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [replay, playing, totalSeconds, speed]);

  const headLineX = replay && playing ? head : null;

  if (merged.length === 0) {
    return (
      <div
        className="rounded-xl border border-border bg-card p-4 text-center text-sm text-ink-secondary"
        role="status"
        aria-label="Empty roast curve"
      >
        Tidak ada data kurva roasting.
      </div>
    );
  }

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-elevation-soft">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-ink-tertiary">
            Roast curve
          </p>
          <h3 className="mt-0.5 font-heading text-base font-bold tracking-[-0.02em] text-ink">
            {data.title ?? "Profil roasting"}
          </h3>
        </div>
        {data.matchScore != null && (
          <div className="flex items-baseline gap-2 rounded-card border border-copper/30 bg-copper-soft px-3 py-2 text-copper-strong">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em]">Profile match</span>
            <span className="font-heading text-xl font-bold tabular-nums">
              {Math.round(data.matchScore)}
              <span className="text-base font-medium text-copper">/100</span>
            </span>
          </div>
        )}
      </header>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={merged} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #E7E2D9)" />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <XAxis
            dataKey="time"
            tickFormatter={formatClock}
            stroke="var(--ink-tertiary, #8A8378)"
            fontSize={10}
            tickLine={false}
            type="number"
            domain={[0, Math.max(totalSeconds, 60)]}
          />
          <YAxis
            yAxisId="temp"
            stroke="var(--ink-tertiary, #8A8378)"
            fontSize={10}
            tickLine={false}
            domain={["dataMin - 10", "dataMax + 10"]}
          />
          {showRoR && (
            <YAxis
              yAxisId="ror"
              orientation="right"
              stroke="var(--instrument, #15B8C6)"
              fontSize={10}
              tickLine={false}
              domain={[0, 40]}
            />
          )}
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card, #FFFFFF)",
              border: "1px solid var(--border, #E7E2D9)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const numeric = typeof value === "number" ? value : Number(value);
              const nameStr = String(name);
              if (nameStr === "RoR") return [`${numeric.toFixed(1)} °C/min`, "RoR"] as [string, string];
              return [`${numeric}°C`, nameStr] as [string, string];
            }}
            labelFormatter={(label) => formatClock(Number(label))}
          />
          {eventMarkers.map((e) => (
            <ReferenceLine
              key={`${e.type}-${e.second}`}
              yAxisId="temp"
              x={e.second}
              stroke="var(--instrument-strong, #0E7C8A)"
              strokeDasharray="4 4"
              strokeWidth={1.2}
              label={e.label ?? e.type}
            />
          ))}
          {headLineX != null && (
            <ReferenceLine
              yAxisId="temp"
              x={headLineX}
              stroke="var(--copper, #A94728)"
              strokeWidth={1.5}
            />
          )}
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="BT"
            name="BT"
            stroke="var(--copper, #A94728)"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          {alignedReference.length > 0 && (
            <Line
              yAxisId="temp"
              type="monotone"
              dataKey="Target"
              name="Target"
              stroke="var(--instrument, #15B8C6)"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {data.environmentalTemperatureSeries && data.environmentalTemperatureSeries.length > 0 && (
            <Line
              yAxisId="temp"
              type="monotone"
              dataKey="ET"
              name="ET"
              stroke="var(--ink-secondary, #5C564E)"
              strokeWidth={1.2}
              strokeDasharray="3 3"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {showRoR && (
            <Line
              yAxisId="ror"
              type="monotone"
              dataKey="RoR"
              name="RoR"
              stroke="var(--instrument-strong, #0E7C8A)"
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
      {replay && totalSeconds > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((prev) => !prev)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-ink transition hover:border-copper/60 hover:text-copper active:scale-95"
            aria-label={playing ? "Jeda replay" : "Mulai replay"}
          >
            {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setHead(0);
              setPlaying(false);
            }}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-ink-secondary transition hover:border-copper/60 hover:text-copper active:scale-95"
            aria-label="Reset replay ke awal"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-1 py-0.5" role="group" aria-label="Playback speed">
            {speedOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSpeed(opt.value)}
                aria-pressed={speed === opt.value}
                className={cn(
                  "h-7 rounded-md px-2 text-[11px] font-bold transition-colors",
                  speed === opt.value
                    ? "bg-copper text-white"
                    : "text-ink-secondary hover:bg-surface-sunken hover:text-ink",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(totalSeconds, 1)}
            value={head}
            onChange={(event) => {
              setHead(Number(event.currentTarget.value));
              setPlaying(false);
            }}
            className="flex-1 accent-copper"
            aria-label="Posisi playhead replay"
          />
          <span className="min-w-[64px] text-right font-mono text-xs text-ink-secondary tabular-nums">
            {formatClock(head)} / {formatClock(totalSeconds)}
          </span>
        </div>
      )}
    </div>
  );
}