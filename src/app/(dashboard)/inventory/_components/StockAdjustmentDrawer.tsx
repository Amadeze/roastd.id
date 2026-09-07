"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { toastSafe } from "@/lib/toast";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
// No Select imports needed
import { adjustStock } from "../actions";

const schema = z.object({
  type: z.enum(["IN", "OUT"]),
  targetId: z.string().min(1, "Pilih barang yang akan disesuaikan"),
  quantity: z.number().min(0.01, "Kuantitas minimal 0.01"),
  notes: z.string().min(3, "Berikan alasan penyesuaian (min. 3 karakter)"),
});

type FormValues = z.infer<typeof schema>;

export interface StockAdjustmentDrawerProps {
  id?: string;
  onSuccess?: () => void;
  onPendingChange?: (isPending: boolean) => void;
  items: Array<{
    id: string;
    label: string;
    type: "GREEN_BEAN" | "ROASTED_BEAN" | "FINISHED_GOODS" | "PACKAGING" | "SUPPLY";
    currentStock: number;
    unitLabel?: string;
  }>;
}

export function StockAdjustmentDrawer({
  id,
  onSuccess,
  onPendingChange,
  items,
}: StockAdjustmentDrawerProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: "OUT",
      targetId: "",
      notes: "",
    },
  });

  const selectedItem = items.find((i) => i.id === watch("targetId"));
  const isUnit = selectedItem?.type === "FINISHED_GOODS" || selectedItem?.type === "PACKAGING";
  const unitSuffix = selectedItem?.unitLabel ?? (isUnit ? "Unit" : "Kg");

  async function onSubmit(data: FormValues) {
    onPendingChange?.(true);

    try {
      const item = items.find(i => i.id === data.targetId);
      if (!item) throw new Error("Barang tidak valid");

      const res = await adjustStock({
        targetId: data.targetId,
        isPackaging: item.type === "PACKAGING",
        isSupply: item.type === "SUPPLY",
        type: data.type,
        quantity: data.quantity,
        notes: data.notes,
      });

      if (!res.success) {
        toastSafe.error(res.error || "Gagal menyimpan penyesuaian");
      } else {
        toast.success("Penyesuaian stok berhasil disimpan!");
        reset();
        onSuccess?.();
      }
    } catch (err: any) {
      toastSafe.error(err.message || "Gagal memproses form");
    } finally {
      onPendingChange?.(false);
    }
  }

  const glassInput = "bg-card/40 border-white/60 focus-visible:ring-ink focus-visible:border-transparent backdrop-blur-md";
  const glassCard = "rounded-[1rem] border border-white/60 bg-card/30 backdrop-blur-xl p-5 shadow-sm";

  return (
    <div className={glassCard}>
      <form id={id} onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* Type */}
        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Jenis Penyesuaian</Label>
          <select
            className={`w-full h-11 rounded-lg border px-3 text-sm transition-all appearance-none outline-none ${glassInput} ${errors.type ? "border-[var(--status-danger)]/30 ring-red-400" : ""}`}
            {...register("type")}
          >
            <option value="IN">+ Tambah Stok (IN)</option>
            <option value="OUT">- Kurangi Stok (OUT)</option>
          </select>
          {errors.type && <p className="text-sm text-[var(--status-danger)]">{errors.type.message}</p>}
        </div>

        {/* Target Item */}
        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Barang</Label>
          <select
            className={`w-full h-11 rounded-lg border px-3 text-sm transition-all appearance-none outline-none ${glassInput} ${errors.targetId ? "border-[var(--status-danger)]/30 ring-red-400" : ""}`}
            {...register("targetId")}
          >
            <option value="">-- Pilih barang... --</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} (Stok: {item.currentStock} {item.unitLabel ?? (item.type === "FINISHED_GOODS" || item.type === "PACKAGING" ? "Unit" : "Kg")})
              </option>
            ))}
          </select>
          {errors.targetId && <p className="text-sm text-[var(--status-danger)]">{errors.targetId.message}</p>}
        </div>

        {/* Quantity */}
        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Kuantitas ({unitSuffix})</Label>
          <Input 
            type="number" 
            step="any" 
            min="0" 
            className={`h-11 font-mono ${glassInput}`}
            placeholder="0" 
            {...register("quantity", { valueAsNumber: true })} 
          />
          {errors.quantity && <p className="text-sm text-[var(--status-danger)]">{errors.quantity.message}</p>}
        </div>

        {/* Notes */}
        <div className="space-y-2">
          <Label className="text-xs uppercase font-bold tracking-wider text-ink-tertiary">Alasan (Catatan)</Label>
          <Textarea 
            placeholder="Misal: Tumpah saat ditimbang, rusak, atau salah input sebelumnya..." 
            className={`resize-none ${glassInput}`}
            {...register("notes")} 
          />
          {errors.notes && <p className="text-sm text-[var(--status-danger)]">{errors.notes.message}</p>}
        </div>
      </form>
    </div>
  );
}
