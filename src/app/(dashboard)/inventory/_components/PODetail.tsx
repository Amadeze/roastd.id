"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { toastSafe } from "@/lib/toast";
import { formatRupiah, formatDate as formatDateUtil } from "@/lib/format";
import { getPODetail, cancelPOAction, sendPOAction } from "../po-actions";
import { ReceivePOForm } from "./ReceivePOForm";
import type { POStatus } from "@prisma/client";

// =============================================================================
// Types
// =============================================================================

type PODetailData = {
  id: string;
  code: string;
  status: POStatus;
  supplierName: string;
  expectedDate: string | null;
  estimatedShippingCost: number;
  totalEstimate: number;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  itemCount: number;
  notes: string | null;
  receivedShippingCost: number;
  remainingShippingEstimate: number;
  items: Array<{
    id: string;
    productName: string | null;
    packagingName: string | null;
    quantity: number;
    receivedQuantity: number;
    remainingQuantity: number;
    unitPrice: number;
    totalPrice: number;
    reorderPoint: number | null;
    currentStock: number | null;
  }>;
  purchases: Array<{
    id: string;
    code: string;
    receivedAt: string;
    shippingCost: number;
    totalCost: number;
  }>;
};

// =============================================================================
// Component
// =============================================================================

interface PODetailProps {
  poId: string;
  onClose: () => void;
  onUpdate: () => void;
}

export function PODetail({ poId, onClose, onUpdate }: PODetailProps) {
  const [detail, setDetail] = useState<PODetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [showReceiveForm, setShowReceiveForm] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPODetail(poId);
      setDetail(data);
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleCancel = async () => {
    const result = await cancelPOAction(poId);
    if (result.success) {
      toast.success("PO berhasil dibatalkan.");
      onUpdate();
      loadDetail();
    } else {
      toastSafe.error(result.error || "Gagal membatalkan PO.");
    }
  };

  const handleSend = async () => {
    setActionPending(true);
    try {
      const result = await sendPOAction(poId);
      if (!result.success) {
        toastSafe.error(result.error);
        return;
      }
      toast.success("PO dikirim ke supplier dan masuk antrean penerimaan.");
      onUpdate();
      await loadDetail();
    } finally {
      setActionPending(false);
    }
  };

  const handleReceiveSuccess = () => {
    setShowReceiveForm(false);
    onUpdate();
    loadDetail();
  };

  const formatDate = (date: string | null) => {
    if (!date) return "-";
    return formatDateUtil(date);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-ink-tertiary">Memuat detail PO...</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-ink-tertiary">PO tidak ditemukan.</p>
      </div>
    );
  }

  const canReceive = detail.status === "SENT" || detail.status === "PARTIAL";
  const canSend = detail.status === "DRAFT";
  const canCancel = detail.status === "DRAFT" || detail.status === "SENT";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-ink">{detail.code}</h3>
          <p className="text-xs text-ink-tertiary">Supplier: {detail.supplierName}</p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      {/* Info */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-ink-tertiary">Tanggal Dibuat:</span>
          <span className="ml-2 font-medium">{formatDate(detail.createdAt)}</span>
        </div>
        <div>
          <span className="text-ink-tertiary">Perkiraan Datang:</span>
          <span className="ml-2 font-medium">{formatDate(detail.expectedDate)}</span>
        </div>
        {detail.sentAt && (
          <div>
            <span className="text-ink-tertiary">Dikirim:</span>
            <span className="ml-2 font-medium">{formatDate(detail.sentAt)}</span>
          </div>
        )}
        {detail.receivedAt && (
          <div>
            <span className="text-ink-tertiary">Diterima:</span>
            <span className="ml-2 font-medium">{formatDate(detail.receivedAt)}</span>
          </div>
        )}
      </div>

      {detail.notes && (
        <div className="text-xs">
          <span className="text-ink-tertiary">Catatan:</span>
          <span className="ml-2">{detail.notes}</span>
        </div>
      )}

      {/* Items Table */}
      <div className="overflow-hidden rounded-xl border border-white/60 bg-card/30">
        <Table>
          <TableHeader>
            <TableRow className="bg-card/40">
              <TableHead className="text-xs font-bold uppercase">Item</TableHead>
              <TableHead className="text-xs font-bold uppercase text-right">Qty</TableHead>
              <TableHead className="text-xs font-bold uppercase text-right">Harga</TableHead>
              <TableHead className="text-xs font-bold uppercase text-right">Subtotal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="text-xs font-medium">
                  {item.productName || item.packagingName}
                </TableCell>
                <TableCell className="text-xs text-right">{item.quantity}</TableCell>
                <TableCell className="text-xs text-right">{formatRupiah(item.unitPrice)}</TableCell>
                <TableCell className="text-xs text-right font-bold">{formatRupiah(item.totalPrice)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Total */}
      <div className="space-y-0.5 text-right">
        <p className="text-[11px] text-ink-tertiary">
          Termasuk estimasi ongkir {formatRupiah(detail.estimatedShippingCost)}
        </p>
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs font-bold text-ink-tertiary">Total Estimasi:</span>
          <span className="text-lg font-black text-ink">{formatRupiah(detail.totalEstimate)}</span>
        </div>
      </div>

      {/* Purchase History */}
      {detail.purchases.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-bold text-ink">Riwayat Penerimaan</h4>
          <div className="overflow-hidden rounded-xl border border-white/60 bg-card/30">
            <Table>
              <TableHeader>
                <TableRow className="bg-card/40">
                  <TableHead className="text-xs font-bold uppercase">Kode</TableHead>
                  <TableHead className="text-xs font-bold uppercase">Tanggal</TableHead>
                  <TableHead className="text-xs font-bold uppercase text-right">Ongkir</TableHead>
                  <TableHead className="text-xs font-bold uppercase text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.purchases.map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell className="text-xs font-medium">{purchase.code}</TableCell>
                    <TableCell className="text-xs">{formatDate(purchase.receivedAt)}</TableCell>
                    <TableCell className="text-xs text-right">{formatRupiah(purchase.shippingCost)}</TableCell>
                    <TableCell className="text-xs text-right font-bold">{formatRupiah(purchase.totalCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        <Link
          href="/keuangan?tab=pembelian"
          className="mr-auto text-xs font-semibold text-ink transition hover:text-ink hover:underline"
        >
          Bayar ke supplier (hutang) →
        </Link>
        <Button variant="outline" onClick={onClose} className="bg-card/40 border-white/60">
          Tutup
        </Button>
        {canCancel && (
          <>
            <Button 
              variant="outline" 
              className="text-[var(--status-danger)] border-[var(--status-danger)]/30 hover:bg-[var(--status-danger)]/10 hover:text-[var(--status-danger)]"
              onClick={() => setIsCancelDialogOpen(true)}
              disabled={actionPending}
            >
              Batalkan
            </Button>
            <AlertDialog open={isCancelDialogOpen} onOpenChange={setIsCancelDialogOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Batalkan PO ini?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Purchase order yang dibatalkan tidak dapat dipulihkan.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Kembali</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 text-white hover:bg-red-700"
                    onClick={() => {
                      handleCancel();
                      setIsCancelDialogOpen(false);
                    }}
                  >
                    Ya, Batalkan
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
        {canSend && (
          <Button onClick={handleSend} disabled={actionPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
            {actionPending ? "Mengirim..." : "Kirim ke Supplier"}
          </Button>
        )}
        {canReceive && (
          <Button onClick={() => setShowReceiveForm(true)} className="bg-domain-inventory text-white hover:bg-domain-inventory/90">
            Tandai Diterima
          </Button>
        )}
      </div>

      {/* Receive Form Modal */}
      {showReceiveForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-bold mb-4">Form Penerimaan Barang</h3>
            <ReceivePOForm
              poId={poId}
              items={detail.items}
              estimatedShippingCost={detail.remainingShippingEstimate}
              onSuccess={handleReceiveSuccess}
              onCancel={() => setShowReceiveForm(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
