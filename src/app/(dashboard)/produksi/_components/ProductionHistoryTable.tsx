import { useState, useMemo } from "react";
import Link from "next/link";
import { Search, Factory } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatKg, formatRupiah } from "@/lib/format";
import { VoidConfirmDialog } from "@/components/VoidConfirmDialog";
import { voidProductionBatch } from "../actions";
import type { ProductionBatchRow } from "../actions";
import { EmptyState } from "@/components/shared/EmptyState";

interface ProductionHistoryTableProps {
  batches: ProductionBatchRow[];
  onStartProduction?: () => void;
}

export function ProductionHistoryTable({ batches, onStartProduction }: ProductionHistoryTableProps) {
  const [voidTarget, setVoidTarget] = useState<ProductionBatchRow | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      const matchSearch =
        b.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (b.recipeUsed && b.recipeUsed.toLowerCase().includes(searchTerm.toLowerCase())) ||
        b.outputProductName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === "ALL" || b.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [batches, searchTerm, statusFilter]);

  return (
    <>
    <div className="mb-4 flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
        <Input
          placeholder="Cari kode atau nama produk..."
          className="pl-9 h-10 bg-card/40 border-white/60 backdrop-blur-md rounded-xl focus-visible:ring-ink"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className="h-10 px-3 rounded-xl border border-white/60 bg-card/40 backdrop-blur-md text-sm font-medium text-ink outline-none focus:ring-2 focus:ring-ink"
      >
        <option value="ALL">Semua Status</option>
        <option value="COMPLETED">Selesai</option>
        <option value="PENDING">Proses</option>
        <option value="VOID">Void</option>
      </select>
    </div>

    <div className="hidden md:block overflow-hidden rounded-[1.25rem] border border-white/60 bg-card/30 backdrop-blur-xl shadow-lg shadow-border/30">
      <Table>
        <TableHeader>
          <TableRow className="bg-card/40 border-b border-white/50 backdrop-blur-md hover:bg-card/40">
            <TableHead className="w-36 text-xs font-bold uppercase tracking-widest text-ink-secondary">Kode Batch</TableHead>
            <TableHead className="text-xs font-bold uppercase tracking-widest text-ink-secondary">Bahan Masuk</TableHead>
            <TableHead className=" text-right text-xs font-bold uppercase tracking-widest text-ink-secondary">Jml Bahan</TableHead>
            <TableHead className="text-xs font-bold uppercase tracking-widest text-ink-secondary">Hasil Keluar</TableHead>
            <TableHead className=" text-right text-xs font-bold uppercase tracking-widest text-ink-secondary">Jml Hasil</TableHead>
            <TableHead className="text-right text-xs font-bold uppercase tracking-widest text-ink-secondary">HPP/Unit</TableHead>
            <TableHead className=" text-xs font-bold uppercase tracking-widest text-ink-secondary">Tanggal</TableHead>
            <TableHead className="w-24 text-center text-xs font-bold uppercase tracking-widest text-ink-secondary">Status</TableHead>
            <TableHead className="w-16 text-center text-xs font-bold uppercase tracking-widest text-ink-secondary">Aksi</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredBatches.length === 0 ? (
            <EmptyState.TableEmptyState
  label="batch produksi"
  isFiltered={batches.length > 0}
  filteredLabel="Tidak ada batch produksi yang cocok."
  filteredDescription="Coba ubah filter atau pencarian."
  actionLabel="Batch Baru"
  actionIcon={<Factory size={12} />}
  onAction={onStartProduction}
  colSpan={9}
/>
          ) : (
            filteredBatches.map((b) => (
              <TableRow key={b.id} className="hover:bg-card/40 transition-colors">
                <TableCell className="font-mono text-xs font-medium text-ink">
                  <Link href={`/produksi/batch/${b.id}`} className="font-bold text-ink hover:text-[var(--status-warning)] hover:underline">
                    {b.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <p className="text-sm font-medium text-ink">{b.recipeUsed ?? "Tanpa Resep"}</p>
                </TableCell>
                <TableCell  className="text-right font-mono text-sm text-ink">
                  {b.totalRbUsedKg} <span className="text-xs text-ink-secondary">kg</span>
                </TableCell>
                <TableCell>
                  <p className="text-sm font-medium text-ink">{b.outputProductName}</p>
                </TableCell>
                <TableCell  className="text-right font-mono text-sm font-semibold text-[var(--status-success)]">
                  {b.unitsProduced} <span className="text-xs text-[var(--status-success)]/60">pcs</span>
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold text-ink">
                  {formatRupiah(b.hppPerUnit)}
                </TableCell>
                <TableCell className="text-sm text-ink-secondary">
                  {formatDate(b.producedAt)}
                </TableCell>
                <TableCell className="text-center">
                  <StatusBadge status={b.status} />
                </TableCell>
                <TableCell className="text-center">
                  {b.status === "COMPLETED" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-[var(--status-danger)] hover:bg-[var(--status-danger)]/10 hover:text-[var(--status-danger)] rounded-lg"
                      onClick={() => setVoidTarget(b)}
                    >
                      Void
                    </Button>
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
        <div className="py-12 text-center rounded-[1.25rem] border border-white/60 bg-card/30 backdrop-blur-xl">
           <p className="text-sm font-medium text-ink-secondary">Belum ada riwayat produksi.</p>
        </div>
      ) : (
        filteredBatches.map((b) => (
          <div key={b.id} className="flex flex-col gap-2 rounded-[1.25rem] border border-white/60 bg-card/30 p-4 shadow-sm backdrop-blur-xl">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-bold text-ink">{b.outputProductName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Link href={`/produksi/batch/${b.id}`} className="font-mono text-xs font-bold text-ink hover:text-[var(--status-warning)] hover:underline">
                    {b.code}
                  </Link>
                  <span className="text-xs text-ink-secondary">•</span>
                  <span className="text-xs uppercase font-bold text-ink-secondary">{b.recipeUsed ?? "Bebas"}</span>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm font-black text-[var(--status-success)]">{b.unitsProduced} Unit</p>
                <p className="font-mono text-xs font-bold text-ink-secondary mt-0.5">Bahan: {formatKg(b.totalRbUsedKg)}</p>
                <p className="font-mono text-[11px] font-bold text-ink mt-0.5">HPP: {formatRupiah(b.hppPerUnit)}/pcs</p>
              </div>
            </div>
            
            <div className="flex justify-between items-end mt-2 pt-2 border-t border-white/40">
              <div className="flex flex-col gap-1">
                <StatusBadge status={b.status} />
                <span className="text-xs font-semibold text-ink-secondary">{formatDate(b.producedAt)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/produksi/batch/${b.id}`}
                  className="inline-flex h-7 items-center rounded-lg px-2.5 text-[11px] font-bold uppercase text-ink hover:bg-card/70"
                >
                  Detail
                </Link>
                {b.status === "COMPLETED" && (
                  <Button size="sm" variant="ghost" onClick={() => setVoidTarget(b)} className="h-7 px-2.5 text-[11px] font-bold uppercase text-[var(--status-danger)] hover:bg-[var(--status-danger)]/10 hover:text-[var(--status-danger)] rounded-lg">
                    Void
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>

    <VoidConfirmDialog
      open={!!voidTarget}
      onOpenChange={(v) => { if (!v) setVoidTarget(null); }}
      title={`Void Batch ${voidTarget?.code ?? ""}`}
      description="Tindakan ini akan membalik mutasi stok Roasted Bean (kembali) dan Produk Jadi (berkurang). Tidak dapat dibatalkan."
      onConfirm={async (reason) => {
        const result = await voidProductionBatch(voidTarget!.id, reason);
        return result;
      }}
    />
    </>
  );
}

