import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  CircleDot,
} from "lucide-react";
import {
  FLAG_REQUEST_HEADER,
  parseFlagRequestHeader,
} from "@/lib/featureFlags";

export const dynamic = "force-dynamic";

const BASE_URL = "https://roastd.id";

interface PublicHealth {
  status: "ok" | "degraded";
  database: "reachable" | "unreachable";
  timestamp: string;
}

interface StatusView {
  overall: "ok" | "degraded";
  database: "reachable" | "unreachable";
  checkedAt: string;
  unreachable: boolean;
}

export const metadata: Metadata = {
  title: "Status publik · roastd.id",
  description:
    "Status publik roastd.id — uptime, jangkauan database, dan hasil probe readiness terbaru.",
  alternates: { canonical: `${BASE_URL}/status` },
  openGraph: {
    title: "Status publik · roastd.id",
    description: "Uptime, jangkauan database, dan probe readiness terbaru.",
    url: `${BASE_URL}/status`,
    siteName: "roastd.id",
    locale: "id_ID",
    type: "website",
  },
};

const SUBSYSTEMS = [
  {
    id: "ledger",
    label: "Inventory ledger & kasir",
    description: "Immutable ledger, VOID/reversal, batch operasional.",
  },
  {
    id: "artisan",
    label: "Artisan webhook + Roastd Studio",
    description: ".alog ingest, hardware bridge pairing.",
  },
  {
    id: "midtrans",
    label: "Midtrans + bukti bayar manual",
    description: "Payment gateway dan verifikasi bukti transfer.",
  },
  {
    id: "storefront",
    label: "Tenant storefront publik",
    description: "Checkout, custom domain, dan tema portal.",
  },
] as const;

function probeOrigin(): string {
  const fromEnv = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? BASE_URL;
  return fromEnv.replace(/\/+$/, "");
}

async function fetchHealth(origin: string): Promise<StatusView> {
  const endpoint = `${origin}/api/health`;
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await response.json()) as PublicHealth;
    return {
      overall: data.status,
      database: data.database,
      checkedAt: data.timestamp,
      unreachable: false,
    };
  } catch {
    return {
      overall: "degraded",
      database: "unreachable",
      checkedAt: new Date().toISOString(),
      unreachable: true,
    };
  }
}

export default async function StatusPage() {
  const flagHeader = (await headers()).get(FLAG_REQUEST_HEADER);
  const flags = parseFlagRequestHeader(flagHeader);
  const enabled = flags["public-status-page"] ?? false;

  if (!enabled) {
    return (
      <main className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-3xl flex-col items-center justify-center px-6 text-center">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-ink-tertiary">
          roastd.id · Status
        </p>
        <h1 className="mt-6 font-heading text-3xl font-bold leading-[1.05] tracking-[-0.04em] text-ink">
          Halaman status publik sedang dipersiapkan
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-ink-secondary">
          Untuk probe internal, gunakan <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[12px]">/api/health</code>.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex h-11 items-center justify-center rounded-card border border-border bg-card px-5 text-sm font-bold text-foreground hover:border-primary/55 hover:bg-accent"
        >
          Kembali ke beranda
        </Link>
      </main>
    );
  }

  const view = await fetchHealth(probeOrigin());
  const checkedAt = new Date(view.checkedAt);

  return (
    <main className="bg-paper">
      <section className={`${view.overall === "ok" ? "bg-surface-inverse" : "bg-[#7A2A1F]"} text-white`}>
        <div className="mx-auto max-w-4xl px-6 py-16">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-white/55">
            Status publik · roastd.id
          </p>
          <h1 className="mt-5 font-heading text-[clamp(2.2rem,4vw,3.6rem)] font-bold leading-[0.96] tracking-[-0.05em]">
            {view.overall === "ok" ? "Semua sistem berjalan normal." : "Ada sistem yang tidak sehat."}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-white/65">
            Probe terakhir pada {checkedAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}.
            Data diambil langsung dari endpoint readiness internal.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <span className="inline-flex h-11 items-center gap-2 rounded-card border border-white/15 bg-white/[0.05] px-4 text-sm font-bold text-white">
              {view.overall === "ok" ? (
                <CheckCircle2 className="size-4 text-[#92F3FA]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="size-4 text-[#F2A17F]" aria-hidden="true" />
              )}
              Overall {view.overall === "ok" ? "ready" : "degraded"}
            </span>
            <span className="inline-flex h-11 items-center gap-2 rounded-card border border-white/15 bg-white/[0.05] px-4 text-sm font-bold text-white/80">
              Database {view.database}
            </span>
          </div>
        </div>
      </section>

      <section className="bg-paper py-16 sm:py-20" aria-labelledby="subsystems-heading">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-end justify-between gap-3">
            <h2
              id="subsystems-heading"
              className="font-heading text-2xl font-bold leading-tight tracking-[-0.03em] text-ink"
            >
              Subsistem
            </h2>
            <p className="text-xs text-ink-tertiary">
              Diperbarui tiap probe readiness (~5 menit cache).
            </p>
          </div>
          <ul className="mt-6 grid gap-4">
            {SUBSYSTEMS.map((sub) => {
              const reachable = view.overall === "ok" && view.database === "reachable";
              return (
                <li
                  key={sub.id}
                  className="flex items-start justify-between gap-4 rounded-card border border-border bg-card p-5 shadow-elevation-soft"
                >
                  <div>
                    <p className="font-heading text-base font-bold tracking-[-0.02em] text-ink">
                      {sub.label}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-ink-secondary">
                      {sub.description}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-2 text-xs font-bold text-ink-secondary">
                    {reachable ? (
                      <>
                        <CircleDot className="size-4 text-emerald-600" aria-hidden="true" />
                        OK
                      </>
                    ) : view.unreachable ? (
                      <>
                        <CircleDashed className="size-4 text-ink-tertiary" aria-hidden="true" />
                        Probe gagal
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="size-4 text-amber-700" aria-hidden="true" />
                        Degraded
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="border-t border-border bg-canvas py-12">
        <div className="mx-auto flex max-w-4xl flex-col items-start justify-between gap-4 px-6 sm:flex-row sm:items-center">
          <p className="max-w-md text-sm leading-6 text-ink-secondary">
            Ingin memonitor langsung? Setiap cron job menulis <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-[12px]">JobRun</code> historis.
          </p>
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-card border border-border bg-card px-5 text-sm font-bold text-foreground hover:border-primary/55 hover:bg-accent"
          >
            Kembali ke beranda <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </main>
  );
}