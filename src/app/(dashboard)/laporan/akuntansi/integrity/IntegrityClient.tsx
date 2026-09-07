"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle, AlertCircle, Info, CheckCircle } from "lucide-react";
import type { GlIntegrityIssue } from "../actions";
import { Button } from "@/components/ui/button";

const SEVERITY_CONFIG: Record<string, { icon: any; className: string }> = {
  ERROR: { icon: AlertCircle, className: "border-danger-mid bg-danger-light text-danger-base" },
  WARNING: { icon: AlertTriangle, className: "border-warning-mid bg-warning-light text-warning-base" },
  INFO: { icon: Info, className: "border-blue-200 bg-blue-50 text-blue-700" },
};

export function IntegrityClient({ issues }: { issues: GlIntegrityIssue[] }) {
  const router = useRouter();

  const errorCount = issues.filter((i) => i.severity === "ERROR").length;
  const warnCount = issues.filter((i) => i.severity === "WARNING").length;
  const infoCount = issues.filter((i) => i.severity === "INFO").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <div className="rounded-xl border border-stone-200 bg-white px-5 py-4 min-w-[140px]">
          <p className="text-xs text-stone-400">Total Issue</p>
          <p className="text-2xl font-bold text-stone-800">{issues.length}</p>
        </div>
        <div className="rounded-xl border border-danger-mid bg-danger-light px-5 py-4 min-w-[140px]">
          <p className="text-xs text-status-danger">Error</p>
          <p className="text-2xl font-bold text-danger-base">{errorCount}</p>
        </div>
        <div className="rounded-xl border border-warning-mid bg-warning-light px-5 py-4 min-w-[140px]">
          <p className="text-xs text-status-warning">Warning</p>
          <p className="text-2xl font-bold text-warning-base">{warnCount}</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 min-w-[140px]">
          <p className="text-xs text-blue-500">Info</p>
          <p className="text-2xl font-bold text-blue-600">{infoCount}</p>
        </div>
      </div>

      {issues.length === 0 && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <CheckCircle size={40} className="mx-auto mb-3 text-emerald-500" />
          <p className="text-sm font-semibold text-emerald-700">Semua jurnal balance dan konsisten</p>
          <p className="text-xs text-emerald-500 mt-1">Tidak ditemukan masalah integritas data</p>
        </div>
      )}

      <div className="space-y-3">
        {issues.map((issue, i) => {
          const cfg = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.INFO;
          const Icon = cfg.icon;
          return (
            <div key={i} className={`rounded-xl border p-4 ${cfg.className}`}>
              <div className="flex items-start gap-3">
                <Icon size={18} className="mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{issue.message}</p>
                  <p className="text-xs mt-1 opacity-80">{issue.detail}</p>
                  <div className="flex gap-2 mt-2">
                    {issue.entryCode && (
                      <span className="font-mono text-xs opacity-60">Entry: {issue.entryCode}</span>
                    )}
                    {issue.accountCode && (
                      <span className="font-mono text-xs opacity-60">Akun: {issue.accountCode}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
