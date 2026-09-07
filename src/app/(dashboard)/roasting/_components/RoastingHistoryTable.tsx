"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { Search, Target, X, Flame } from "lucide-react";
import { toast } from "sonner";
import { toastSafe } from "@/lib/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { WorkflowState } from "@/components/ui/workflow-state";
import type { WorkflowTone } from "@/lib/workflow";
import { Button } from "@/components/ui/button";
import { NextAction } from "@/components/ui/next-action";
import { Input } from "@/components/ui/input";
import { formatKg, formatDate } from "@/lib/format";
import { VoidConfirmDialog } from "@/components/VoidConfirmDialog";
import {
  abortParentRoastingBatchAsScrap,
  voidParentRoastingBatch,
  completeParentRoastingBatch,
  searchRoastReferenceProfiles,
  setBatchReferenceProfile,
  splitBatchByCapacity,
  type ParentRoastingBatchRow,
  type RoastReferenceOption,
  type RoastingLocationOption,
} from "../actions";
import { RoastingDestinationField } from "./RoastingDestinationField";
import { EmptyState } from "@/components/shared/EmptyState";
import { EmptyState as ElegantEmptyState } from "@/components/ui/state";
import { Network } from "lucide-react";
import { useEntityPanel } from "@/components/layout/entity-panel";
import { BatchPanelContent } from "./BatchPanelContent";

// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Shrinkage badge
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function ShrinkageBadge({ percent }: { percent: number | null }) {
  if (percent === null) {
    return <span className="text-xs text-ink-tertiary font-medium">-</span>;
  }
  const label = `${percent.toFixed(1)}%`;
  const className =
    percent > 25
      ? "bg-red-50 text-red-600 border-red-200"
      : percent > 18
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-zinc-50 text-ink-secondary border-zinc-200";
  return (
    <Badge variant="outline" className={`font-mono text-[11px] ${className}`}>
      -{label}
    </Badge>
  );
}

// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Cupping badge
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function CuppingBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const colorClass = 
    score >= 85 ? "bg-purple-50 text-purple-700 border-purple-200" :
    score >= 80 ? "bg-blue-50 text-blue-700 border-blue-200" :
    "bg-zinc-50 text-ink-secondary border-zinc-200";

  return (
    <Badge variant="outline" className={`ml-1.5 font-mono text-[11px] ${colorClass}`} title="Cupping Score">
      {score.toFixed(1)}
    </Badge>
  );
}

function roastBatchStage(status: string): { label: string; tone: WorkflowTone } {
  if (status === "COMPLETED") return { label: "Selesai", tone: "success" };
  if (status === "PENDING") return { label: "Proses", tone: "warning" };
  if (status === "VOID") return { label: "Void", tone: "neutral" };
  return { label: status, tone: "neutral" };
}

// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Props
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

interface RoastingHistoryTableProps {
  batches: ParentRoastingBatchRow[];
  machineOptions: { id: string; name: string; capacityKg: number | null }[];
  locationOptions: RoastingLocationOption[];
  onStartRoasting?: () => void;
}

// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Component
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export function RoastingHistoryTable({ batches, machineOptions, locationOptions, onStartRoasting }: RoastingHistoryTableProps) {
  const { show } = useEntityPanel();
  const [voidTarget, setVoidTarget] = useState<ParentRoastingBatchRow | null>(null);
  const [scrapTarget, setScrapTarget] = useState<ParentRoastingBatchRow | null>(null);
  const [completeTarget, setCompleteTarget] = useState<ParentRoastingBatchRow | null>(null);
  const [splitTarget, setSplitTarget] = useState<ParentRoastingBatchRow | null>(null);
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [actualOutputKg, setActualOutputKg] = useState("");
  const [destinationLocationId, setDestinationLocationId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [referenceTarget, setReferenceTarget] = useState<ParentRoastingBatchRow | null>(null);
  const [referenceSearch, setReferenceSearch] = useState("");
  const [referenceOptions, setReferenceOptions] = useState<RoastReferenceOption[]>([]);
  const [referencePending, setReferencePending] = useState(false);
  const [referenceSaving, setReferenceSaving] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      const matchSearch =
        b.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
        b.inputProductName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        b.outputProductName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === "ALL" || b.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [batches, searchTerm, statusFilter]);

  useEffect(() => {
    if (!referenceTarget) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setReferencePending(true);
      const result = await searchRoastReferenceProfiles(referenceSearch);
      if (cancelled) return;
      setReferencePending(false);
      if (!result.success) {
        toastSafe.error(result.error);
        return;
      }
      setReferenceOptions(result.data);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [referenceSearch, referenceTarget]);

  const handleSetReference = async (referenceRoastId: string | null) => {
    if (!referenceTarget || referenceSaving) return;
    setReferenceSaving(true);
    const result = await setBatchReferenceProfile({
      batchId: referenceTarget.id,
      referenceRoastId,
    });
    setReferenceSaving(false);
    if (!result.success) {
      toastSafe.error(result.error);
      return;
    }
    toast.success(result.data.title
      ? `${result.data.title} menjadi kurva acuan ${referenceTarget.code}.`
      : `Kurva acuan ${referenceTarget.code} dihapus.`);
    setReferenceTarget(null);
    setReferenceSearch("");
  };

  const handleComplete = async () => {
    if (!completeTarget) return;
    const kg = parseFloat(actualOutputKg);
    if (isNaN(kg) || kg <= 0) {
      toast.error("Berat keluar harus lebih dari 0");
      return;
    }

    setIsSubmitting(true);
    const result = await completeParentRoastingBatch(
      completeTarget.id,
      kg,
      destinationLocationId || undefined,
    );
    setIsSubmitting(false);

    if (result.success) {
      if (result.outcome?.status === "REVIEW") {
        toast.warning(
          `Batch tersimpan. Susut ${result.outcome.lossPercent}% di luar rentang biasanya ${result.outcome.expectedMinPercent}-${result.outcome.expectedMaxPercent}%. Periksa timbangan atau catatan roast.`,
        );
      } else {
        toast.success("Laporan roasting selesai dan stok langsung diperbarui.");
      }
      setCompleteTarget(null);
      setActualOutputKg("");
      setDestinationLocationId("");
    } else {
      toastSafe.error(result.error);
    }
  };

  const handleSplit = async () => {
    if (!splitTarget || !selectedMachineId) return;

    setIsSubmitting(true);
    const result = await splitBatchByCapacity(splitTarget.id, selectedMachineId);
    setIsSubmitting(false);

    if (result.success) {
      toast.success(`Batch dibagi menjadi ${result.splits} batch.`);
      setShowSplitModal(false);
      setSplitTarget(null);
      setSelectedMachineId("");
    } else {
      toastSafe.error(result.error);
    }
  };

  return (
    <>
    <div className="mb-4 flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary" />
        <Input
          placeholder="Cari kode atau nama beans..."
          className="h-10 rounded-card pl-9"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className="h-10 rounded-card border border-input bg-card px-3 text-sm font-medium text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
      >
        <option value="ALL">Semua Status</option>
        <option value="COMPLETED">Selesai</option>
        <option value="PENDING">Proses</option>
        <option value="VOID">Void</option>
      </select>
    </div>

    <div className="hidden md:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-36">Kode Batch</TableHead>
            <TableHead>Green Bean</TableHead>
            <TableHead>Roasted Bean</TableHead>
            <TableHead className="text-right">Masuk</TableHead>
            <TableHead className="text-right">Keluar</TableHead>
            <TableHead className="text-center">Susut</TableHead>
            <TableHead>Tanggal</TableHead>
            <TableHead className="w-24 text-center">Status</TableHead>
            <TableHead>Acuan</TableHead>
            <TableHead className="w-16 text-center">Aksi</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredBatches.length === 0 ? (
            <EmptyState.TableEmptyState
  label="batch roasting"
  isFiltered={batches.length > 0}
  filteredLabel="Tidak ada batch roasting yang cocok."
  filteredDescription="Coba ubah filter atau pencarian."
  actionLabel="Mulai Roasting"
  actionIcon={<Flame size={12} />}
  onAction={onStartRoasting}
  colSpan={10}
/>
          ) : (
            filteredBatches.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs font-medium text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    <Link
                      href={`/roasting/batch/${b.id}`}
                      className="hover:text-copper hover:underline transition-colors"
                    >
                      {b.code}
                    </Link>
                    <button
                      type="button"
                      title="Lihat rantai jejak batch ini"
                      aria-label={`Rantai jejak ${b.code}`}
                      onClick={() =>
                        show({
                          key: `batch:${b.id}`,
                          eyebrow: "Rantai jejak",
                          title: b.code,
                          content: <BatchPanelContent batchId={b.id} />,
                        })
                      }
                      className="rounded-md p-0.5 text-ink-tertiary transition-colors hover:bg-surface-sunken hover:text-copper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <Network size={13} aria-hidden />
                    </button>
                  </span>
                </TableCell>
                <TableCell>
                  <p className="text-sm text-ink">{b.inputProductName}</p>
                </TableCell>
                <TableCell>
                  <p className="text-sm text-ink">{b.outputProductName}</p>
                </TableCell>
                <TableCell  className="text-right font-mono text-sm text-ink">
                  {formatKg(b.targetWeightKg)}
                </TableCell>
                <TableCell  className="text-right font-mono text-sm font-semibold text-ink">
                  {b.actualOutputKg ? formatKg(b.actualOutputKg) : "-"}
                </TableCell>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center">
                    <ShrinkageBadge percent={b.totalShrinkagePercent} />
                    <CuppingBadge score={b.cuppingScore ?? null} />
                  </div>
                </TableCell>
                <TableCell className="text-sm text-zinc-500">
                  {formatDate(b.createdAt)}
                </TableCell>
                <TableCell className="text-center">
                  <WorkflowState {...roastBatchStage(b.status)} />
                </TableCell>
                <TableCell>
                  {b.status === "PENDING" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 max-w-52 justify-start gap-1.5 px-2 text-xs text-copper"
                      onClick={() => {
                        setReferenceTarget(b);
                        setReferenceSearch("");
                      }}
                    >
                      <Target size={13} />
                      <span className="truncate">{b.referenceProfile?.title ?? "Atur kurva acuan"}</span>
                    </Button>
                  ) : (
                    <span className="block max-w-48 truncate text-xs text-zinc-500">
                      {b.referenceProfile?.title ?? "-"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  {b.status === "COMPLETED" && (
                    <>
                      <NextAction
                        label="Cup"
                        tone="roasting"
                        href={`/cupping?batchId=${b.id}`}
                        size="sm"
                        className="h-7 px-2"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1 h-7 px-2 text-xs text-red-500 hover:bg-red-50 hover:text-red-600 rounded-card"
                        onClick={() => setVoidTarget(b)}
                      >
                        Void
                      </Button>
                    </>
                  )}
                  {b.status === "PENDING" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-copper hover:bg-copper-soft hover:text-copper rounded-card"
                        onClick={() => {
                          setSplitTarget(b);
                          setShowSplitModal(true);
                        }}
                      >
                        Split
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-copper hover:bg-copper-soft hover:text-copper rounded-card"
                        onClick={() => {
                          setCompleteTarget(b);
                          // Auto-fill from linked roast data (sum all child batches)
                          const totalRoasted = b.childBatches
                            .filter((c) => c.roastedWeightGrams)
                            .reduce((sum, c) => sum + (c.roastedWeightGrams || 0), 0);
                          if (totalRoasted > 0) {
                            setActualOutputKg((totalRoasted / 1000).toFixed(2));
                          } else {
                            setActualOutputKg("");
                          }
                        }}
                      >
                        Selesaikan
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-red-500 hover:bg-red-50 hover:text-red-600 rounded-card"
                        onClick={() => setVoidTarget(b)}
                      >
                        {b.lifecycleStatus === "CHARGED" ? "Kembalikan" : "Batalkan"}
                      </Button>
                      {b.lifecycleStatus === "CHARGED" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-red-700 hover:bg-red-100 hover:text-red-800 rounded-card"
                          onClick={() => setScrapTarget(b)}
                        >
                          Scrap
                        </Button>
                      )}
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>

    <div className="md:hidden flex flex-col gap-3">
      {filteredBatches.length === 0 ? (
        <ElegantEmptyState
          title="Belum ada riwayat roasting"
          description="Mulai batch roasting pertama Anda."
        />
      ) : (
        filteredBatches.map((b) => (
          <div key={b.id} className="page-surface flex flex-col gap-2 p-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-bold text-ink">{b.outputProductName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Link
                    href={`/roasting/batch/${b.id}`}
                    className="font-mono text-xs font-semibold text-ink-secondary hover:text-copper hover:underline transition-colors"
                  >
                    {b.code}
                  </Link>
                  <span className="text-xs text-ink-tertiary">ΓÇó</span>
                  <span className="text-xs uppercase font-bold text-ink-tertiary">{b.inputProductName}</span>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm font-black text-ink">{b.actualOutputKg ? formatKg(b.actualOutputKg) : "-"}</p>
                <p className="font-mono text-xs font-bold text-ink-tertiary mt-0.5">Masuk: {formatKg(b.targetWeightKg)}</p>
              </div>
            </div>

            <div className="flex justify-between items-end mt-2 pt-2 border-t border-border">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <WorkflowState {...roastBatchStage(b.status)} />
                  <ShrinkageBadge percent={b.totalShrinkagePercent} />
                  <CuppingBadge score={b.cuppingScore ?? null} />
                </div>
                <span className="text-xs font-semibold text-ink-tertiary">{formatDate(b.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {b.status === "COMPLETED" && (
                  <>
                    <NextAction
                      label="Cup"
                      tone="roasting"
                      href={`/cupping?batchId=${b.id}`}
                      size="sm"
                      className="h-9 px-2.5 uppercase"
                    />
                    <Button size="sm" variant="ghost" onClick={() => setVoidTarget(b)} className="h-9 px-2.5 text-[11px] font-bold uppercase text-red-500 hover:bg-red-50 hover:text-red-600 rounded-card">
                      Void
                    </Button>
                  </>
                )}
                {b.status === "PENDING" && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => {
                      setCompleteTarget(b);
                      setDestinationLocationId(locationOptions[0]?.id ?? "");
                      const totalRoasted = b.childBatches
                        .filter((c) => c.roastedWeightGrams)
                        .reduce((sum, c) => sum + (c.roastedWeightGrams || 0), 0);
                      if (totalRoasted > 0) {
                        setActualOutputKg((totalRoasted / 1000).toFixed(2));
                      } else {
                        setActualOutputKg("");
                      }
                    }} className="h-9 px-2.5 text-[11px] font-bold uppercase text-copper hover:bg-copper-soft hover:text-copper rounded-card">
                      Validasi Sore
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setVoidTarget(b)} className="h-9 px-2.5 text-[11px] font-bold uppercase text-red-500 hover:bg-red-50 hover:text-red-600 rounded-card">
                      {b.lifecycleStatus === "CHARGED" ? "Kembalikan" : "Batalkan"}
                    </Button>
                    {b.lifecycleStatus === "CHARGED" && (
                      <Button size="sm" variant="ghost" onClick={() => setScrapTarget(b)} className="h-9 px-2.5 text-[11px] font-bold uppercase text-red-700 hover:bg-red-100 hover:text-red-800 rounded-card">
                        Scrap
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
            {b.status === "PENDING" && (
              <button
                type="button"
                className="flex items-center justify-between rounded-card bg-copper-soft px-3 py-2 text-left text-xs text-copper-strong"
                onClick={() => {
                  setReferenceTarget(b);
                  setReferenceSearch("");
                }}
              >
                <span className="flex items-center gap-1.5 font-semibold"><Target size={13} /> Kurva acuan</span>
                <span className="max-w-44 truncate">{b.referenceProfile?.title ?? "Atur dari web"}</span>
              </button>
            )}
          </div>
        ))
      )}
    </div>

    {referenceTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-xl overflow-hidden rounded-card border border-border bg-card shadow-elevation-card">
          <div className="flex items-start justify-between border-b border-border p-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-copper">Kurva acuan dari web</p>
              <h3 className="mt-1 text-lg font-bold text-ink">{referenceTarget.code}</h3>
              <p className="mt-1 text-xs text-ink-tertiary">
                Studio hanya membaca pilihan ini dan tidak dapat menggantinya.
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={referenceSaving}
              onClick={() => setReferenceTarget(null)}
              aria-label="Tutup"
            >
              <X size={16} />
            </Button>
          </div>

          <div className="p-5">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary" />
              <Input
                autoFocus
                value={referenceSearch}
                onChange={(event) => setReferenceSearch(event.target.value)}
                placeholder="Cari nama kurva roasting..."
                className="pl-9"
              />
            </div>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {referencePending ? (
                <p className="py-8 text-center text-sm text-ink-tertiary">Mencari kurva...</p>
              ) : referenceOptions.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-tertiary">Kurva tidak ditemukan.</p>
              ) : referenceOptions.map((profile) => {
                const incompatible = Boolean(referenceTarget.machineId && referenceTarget.machineId !== profile.machineId);
                return (
                  <button
                    key={profile.id}
                    type="button"
                    disabled={referenceSaving || incompatible}
                    onClick={() => void handleSetReference(profile.id)}
                    className="flex w-full items-center justify-between rounded-card border border-border px-4 py-3 text-left transition hover:border-copper/40 hover:bg-copper-soft disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm text-ink">{profile.title}</strong>
                      <small className="text-xs text-ink-tertiary">{profile.machineName}{profile.duration ? ` ┬╖ ${Math.round(profile.duration / 60)} menit` : ""}</small>
                    </span>
                    <span className="ml-3 shrink-0 text-xs font-semibold uppercase text-ink-tertiary">
                      {incompatible ? "Mesin berbeda" : profile.id === referenceTarget.referenceProfile?.id ? "Terpilih" : "Pilih"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border bg-surface-sunken px-5 py-4">
            <span className="text-xs text-ink-tertiary">
              {referenceTarget.machineName ? `Mesin: ${referenceTarget.machineName}` : "Mesin mengikuti profil pertama"}
            </span>
            {referenceTarget.referenceProfile && (
              <Button
                variant="ghost"
                size="sm"
                disabled={referenceSaving}
                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={() => void handleSetReference(null)}
              >
                Hapus kurva acuan
              </Button>
            )}
          </div>
        </div>
      </div>
    )}

    <VoidConfirmDialog
      open={!!voidTarget}
      onOpenChange={(v) => { if (!v) setVoidTarget(null); }}
      title={`Void Batch ${voidTarget?.code ?? ""}`}
      description={voidTarget?.status === "PENDING"
        ? "Green Bean akan dikembalikan dari Roasting WIP ke lokasi asal. Stok kanonis dan jurnal tidak berubah."
        : "Tindakan ini akan membalik mutasi stok Green Bean dan Roasted Bean. Tidak dapat dibatalkan."}
      onConfirm={async (reason) => {
        const result = await voidParentRoastingBatch(voidTarget!.id, reason);
        return result;
      }}
    />

    <VoidConfirmDialog
      open={!!scrapTarget}
      onOpenChange={(v) => { if (!v) setScrapTarget(null); }}
      title={`Catat Scrap ${scrapTarget?.code ?? ""}`}
      description="Gunakan hanya jika Green Bean yang sudah di-charge benar-benar hilang atau rusak. Stok kanonis akan berkurang dan jurnal penyesuaian akan dibuat."
      onConfirm={async (reason) => abortParentRoastingBatchAsScrap(scrapTarget!.id, reason)}
    />

    {completeTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
        <div className="rounded-card border border-border/60 bg-card/70 shadow-elevation-card backdrop-blur-md w-full max-w-sm overflow-hidden animate-in zoom-in-95">
          <div className="p-5">
            <h3 className="font-bold text-lg mb-1">Validasi Akhir Sesi</h3>
            <p className="text-xs text-ink-tertiary mb-4">Selesaikan {completeTarget.code} ({completeTarget.outputProductName}) dengan menginput berat akhir.</p>
            <p className="mb-4 rounded-card bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Setelah diselesaikan, stok roasted bean langsung diperbarui dan sesi tidak dapat dibatalkan.
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Berat Masuk (Kg)</label>
                <Input value={completeTarget.targetWeightKg} disabled className="bg-surface-sunken font-mono text-sm" />
              </div>
              <div>
                <label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Berat Keluar / Matang (Kg)</label>
                <Input
                  type="number"
                  autoFocus
                  placeholder="Contoh: 16.5"
                  value={actualOutputKg}
                  onChange={(e) => setActualOutputKg(e.target.value)}
                  className="font-mono text-sm font-bold border-copper/30 focus:border-copper"
                />
                {(() => {
                  const totalRoasted = completeTarget.childBatches
                    .filter((c) => c.roastedWeightGrams)
                    .reduce((sum, c) => sum + (c.roastedWeightGrams || 0), 0);
                  if (totalRoasted > 0) {
                    return (
                      <p className="text-xs text-copper mt-1">
                        Dari Artisan: {(totalRoasted / 1000).toFixed(2)} kg
                        ({completeTarget.childBatches.filter((c) => c.roastId).length} roast profile)
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
              <RoastingDestinationField
                value={destinationLocationId}
                onChange={setDestinationLocationId}
                options={locationOptions}
              />
            </div>
          </div>
          <div className="bg-surface-sunken p-4 border-t flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setCompleteTarget(null); setActualOutputKg(""); setDestinationLocationId(""); }}>Batal</Button>
            <Button className="bg-copper hover:bg-copper-strong text-white" disabled={isSubmitting} onClick={handleComplete}>
              {isSubmitting ? "Menyimpan..." : "Selesaikan Laporan"}
            </Button>
          </div>
        </div>
      </div>
    )}

    {showSplitModal && splitTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
        <div className="rounded-card border border-border/60 bg-card/70 shadow-elevation-card backdrop-blur-md w-full max-w-sm overflow-hidden animate-in zoom-in-95">
          <div className="p-5">
            <h3 className="font-bold text-lg mb-1">Split Batch</h3>
            <p className="text-xs text-ink-tertiary mb-4">
              Batch {splitTarget.code} ({splitTarget.targetWeightKg} kg) akan dibagi berdasarkan kapasitas mesin.
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Berat Masuk (Kg)</label>
                <Input value={splitTarget.targetWeightKg} disabled className="bg-surface-sunken font-mono text-sm" />
              </div>
              <div>
                <label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Pilih Mesin</label>
                <select
                  value={selectedMachineId}
                  onChange={(e) => setSelectedMachineId(e.target.value)}
                  className="w-full rounded-card border border-border bg-card px-3 py-2 text-sm font-mono"
                >
                  <option value="">-- Pilih Mesin --</option>
                  {machineOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.capacityKg ? `(${m.capacityKg} kg)` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="bg-surface-sunken p-4 border-t flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setShowSplitModal(false); setSplitTarget(null); setSelectedMachineId(""); }}>Batal</Button>
            <Button disabled={isSubmitting || !selectedMachineId} onClick={handleSplit}>
              {isSubmitting ? "Memproses..." : "Split Batch"}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

