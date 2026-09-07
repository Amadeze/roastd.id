"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Upload, Download, ChevronLeft, ChevronRight, CheckCircle, AlertCircle, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

import type {
  LegacyStockRawRow,
  LegacyStockDryRunResult,
  OpeningStockResult,
  LegacyStockDryRunRow,
} from "@/lib/legacy-stock-importer/types";
import { parseUploadedFileAction, dryRunAction, applyOpeningStockAction } from "./actions";

type Step = 1 | 2 | 3 | 4 | 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(value);
}

function ActionBadge({ action }: { action: LegacyStockDryRunRow["action"] }) {
  const variants: Record<string, string> = {
    CREATE: "bg-emerald-50 text-emerald-800 border-emerald-200",
    MATCH: "bg-blue-50 text-blue-800 border-blue-200",
    ERROR: "bg-red-50 text-red-800 border-red-200",
  };
  const labels: Record<string, string> = {
    CREATE: "Siap Dibuat",
    MATCH: "Cocok",
    ERROR: "Butuh Diperbaiki",
  };
  return (
    <Badge className={cn("border", variants[action] ?? "")}>
      {labels[action] ?? action}
    </Badge>
  );
}

function DownloadTemplateButton() {
  const csvContent = "type,code,name,quantity,unitCost,category,baseUnit,lotNumber,receivedAt,expiryDate,supplierCode,notes\nGREEN_BEAN,GB-001,Kopi Gayo,25,12000,,,,,,,,\nROASTED_BEAN,RB-001,Rosin Gayo,20,18000,,,,,,,,\nFINISHED_GOODS,FG-001,Kopi Seduh,10,30000,,,,,,,,\nSUPPLY,SUP-001,Gula Pasir,50,5000,INGREDIENT,KG,,,,,\n";

  const handleDownload = () => {
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "template-legacy-stock.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="outline" size="sm" onClick={handleDownload} type="button">
      <Download className="mr-2 h-4 w-4" />
      Unduh Template
    </Button>
  );
}

interface StepIndicatorProps {
  step: Step;
}

function StepIndicator({ step }: StepIndicatorProps) {
  const steps: { num: Step; label: string }[] = [
    { num: 1, label: "Upload File" },
    { num: 2, label: "Pratinjau & Validasi" },
    { num: 3, label: "Konfirmasi" },
    { num: 4, label: "Proses Import" },
    { num: 5, label: "Hasil" },
  ];

  return (
    <nav aria-label="Progress" className="mb-6">
      <ol role="list" className="flex items-center justify-center gap-2 sm:gap-4">
        {steps.map((s) => (
          <li key={s.num} className="flex items-center">
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors",
                step >= s.num
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-stone-300 text-stone-500",
              )}
            >
              {s.num}
            </div>
            <span className="ml-2 hidden text-xs font-medium sm:inline">{s.label}</span>
            {s.num < 5 && (
              <ChevronRight className="mx-2 h-4 w-4 text-stone-300" />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function LegacyImportWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [operationKey, setOperationKey] = useState<string>(() => `OPEN-IMP-${crypto.randomUUID().slice(0, 8)}`);

  // Step 1 state
  const [file, setFile] = useState<File | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);

  // Step 2/3 state
  const [rawRows, setRawRows] = useState<LegacyStockRawRow[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [dryRun, setDryRun] = useState<LegacyStockDryRunResult | null>(null);
  const [isDryRunning, setIsDryRunning] = useState(false);

  // Step 4/5 state
  const [isApplying, setIsApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<OpeningStockResult | null>(null);

  const canProceedToStep2 = file !== null && fileErrors.length === 0 && rawRows.length > 0;
  const hasErrors = (dryRun?.summary.errorCount ?? 0) > 0;
  const canApply = dryRun !== null && !hasErrors;

  // Step 1: Parse file on client-side
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setFileErrors([]);
    setRawRows([]);
    setDryRun(null);
    setApplyResult(null);

    if (!selected.name.toLowerCase().match(/\.(csv|xlsx)$/)) {
      setFileErrors(["Format file tidak didukung. Gunakan .csv atau .xlsx"]);
      return;
    }

    if (selected.size > 5 * 1024 * 1024) {
      setFileErrors([`Ukuran file ${formatBytes(selected.size)} melebihi batas 5 MB`]);
      return;
    }

    setIsParsing(true);
    try {
      const formData = new FormData();
      formData.append("file", selected);
      const result = await parseUploadedFileAction(formData);
      if (result.errors.length > 0) {
        setFileErrors(result.errors);
      } else {
        setFileErrors([]);
      }
      setRawRows(result.rawRows);
    } catch (err: any) {
      setFileErrors([err.message ?? "Gagal mem-parse file."]);
    } finally {
      setIsParsing(false);
    }
  };

  // Step 2: Dry run on mount after parse
  const runDryRun = useCallback(async () => {
    if (rawRows.length === 0) return;
    setIsDryRunning(true);
    try {
      const result = await dryRunAction(rawRows);
      setDryRun(result);
    } catch (err: any) {
      toast.error("Gagal menjalankan validasi", { description: err.message });
    } finally {
      setIsDryRunning(false);
    }
  }, [rawRows]);

  useEffect(() => {
    if (step >= 2 && rawRows.length > 0 && !dryRun) {
      runDryRun();
    }
  }, [step, rawRows, dryRun, runDryRun]);

  // Step 4: Apply
  const handleApply = async () => {
    if (!canApply) return;
    setIsApplying(true);
    try {
      const result = await applyOpeningStockAction(rawRows, operationKey);
      setApplyResult(result);
      setStep(5);
    } catch (err: any) {
      toast.error("Impor belum dapat diterapkan", { description: err.message });
    } finally {
      setIsApplying(false);
    }
  };

  // Reset wizard
  const handleNewImport = () => {
    setStep(1);
    setFile(null);
    setFileErrors([]);
    setRawRows([]);
    setDryRun(null);
    setApplyResult(null);
    setOperationKey(`OPEN-IMP-${crypto.randomUUID().slice(0, 8)}`);
    router.refresh();
  };

  return (
    <div className="w-full max-w-5xl space-y-6">
      <StepIndicator step={step} />

      {step === 1 && (
        <Step1Upload
          file={file}
          fileErrors={fileErrors}
          onFileChange={handleFileChange}
          isParsing={isParsing}
          onNext={() => setStep(2)}
          canProceed={canProceedToStep2}
        />
      )}

      {step === 2 && (isDryRunning || !dryRun) && (
        <div className="py-12 text-center">
          <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-stone-400" />
          <p className="text-sm text-stone-600">Memvalidasi data stok awal...</p>
        </div>
      )}

      {step === 2 && dryRun && !isDryRunning && (
        <Step2Preview
          dryRun={dryRun}
          fileName={file?.name ?? ""}
          rowCount={rawRows.length}
          onNext={() => setStep(3)}
          onBack={() => setStep(1)}
        />
      )}

      {step === 3 && dryRun && (
        <Step3Confirm
          dryRun={dryRun}
          operationKey={operationKey}
          onApply={handleApply}
          isApplying={isApplying}
          onBack={() => setStep(2)}
          canApply={canApply}
          hasErrors={hasErrors}
        />
      )}

      {step === 5 && applyResult && (
        <Step5Result
          result={applyResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  );
}

function Step1Upload({
  file,
  fileErrors,
  onFileChange,
  isParsing,
  onNext,
  canProceed,
}: {
  file: File | null;
  fileErrors: string[];
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isParsing: boolean;
  onNext: () => void;
  canProceed: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-stone-900">Upload File Stok Awal</h2>
          <p className="mt-1 text-sm text-stone-600">
            Upload stok awal dari Excel atau CSV. Maksimal 5 MB, 5.000 baris.
          </p>
        </div>
        <DownloadTemplateButton />
      </div>

      <div
        className={cn(
          "relative flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors",
          file ? "border-primary bg-stone-50" : "border-stone-300 hover:border-stone-400",
        )}
      >
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={onFileChange}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
        <Upload className="mb-2 h-8 w-8 text-stone-400" />
        {isParsing ? (
          <div className="flex items-center gap-2 text-sm text-stone-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Mem-parse file...
          </div>
        ) : file ? (
          <div className="text-center">
            <p className="text-sm font-medium text-stone-900">{file.name}</p>
            <p className="text-xs text-stone-500">{formatBytes(file.size)}</p>
          </div>
        ) : (
          <p className="text-sm text-stone-600">Klik untuk pilih file atau drag & drop</p>
        )}
      </div>

      {fileErrors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <ul className="space-y-1 text-sm text-red-800">
            {fileErrors.map((err, i) => (
              <li key={i} className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {file && (
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onNext} disabled={isParsing || !canProceed}>
            Lanjut ke Validasi
          </Button>
        </div>
      )}
    </div>
  );
}

function Step2Preview({
  dryRun,
  fileName,
  rowCount,
  onNext,
  onBack,
}: {
  dryRun: LegacyStockDryRunResult;
  fileName: string;
  rowCount: number;
  onNext: () => void;
  onBack: () => void;
}) {
  const { summary } = dryRun;
  const hasErrors = summary.errorCount > 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-stone-900">Pratinjau &amp; Validasi</h2>
        <p className="text-sm text-stone-600">
          File: <span className="font-medium">{fileName}</span> · {rowCount} baris
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Total Baris" value={String(summary.totalRows)} tone="default" />
        <SummaryCard label="Siap Dibuat" value={String(summary.createCount)} tone="success" />
        <SummaryCard label="Cocok Existing" value={String(summary.matchCount)} tone="info" />
        <SummaryCard label="Error" value={String(summary.errorCount)} tone={hasErrors ? "error" : "default"} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="text-xs">
          <thead className="bg-stone-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-stone-700">#</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Type</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Code</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Name</th>
              <th className="px-3 py-2 text-right font-medium text-stone-700">Qty</th>
              <th className="px-3 py-2 text-right font-medium text-stone-700">Unit Cost</th>
              <th className="px-3 py-2 text-center font-medium text-stone-700">Aksi</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Catatan</th>
            </tr>
          </thead>
          <tbody>
            {dryRun.rows.map((row) => (
              <tr key={row.rowNumber} className="border-t border-stone-100">
                <td className="px-3 py-2">{row.rowNumber}</td>
                <td className="px-3 py-2">{row.type}</td>
                <td className="px-3 py-2 font-mono">{row.code}</td>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2 text-right">{row.quantity}</td>
                <td className="px-3 py-2 text-right">{row.unitCost}</td>
                <td className="px-3 py-2 text-center">
                  <ActionBadge action={row.action} />
                </td>
                <td className="px-3 py-2">
                  {row.errors.map((e) => e.message).join("; ")}
                  {row.warnings.map((w) => w.message).join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-2 h-4 w-4" />
          Kembali
        </Button>
        <Button size="sm" onClick={onNext} disabled={hasErrors}>
          Lanjut ke Konfirmasi
        </Button>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: "default" | "success" | "info" | "error" }) {
  const toneClasses = {
    default: "border-stone-200 bg-stone-50 text-stone-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    info: "border-blue-200 bg-blue-50 text-blue-900",
    error: "border-red-200 bg-red-50 text-red-900",
  };
  return (
    <div className={cn("rounded-lg border p-3 text-center", toneClasses[tone])}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}

function Step3Confirm({
  dryRun,
  operationKey,
  onApply,
  isApplying,
  onBack,
  canApply,
  hasErrors,
}: {
  dryRun: LegacyStockDryRunResult;
  operationKey: string;
  onApply: () => void;
  isApplying: boolean;
  onBack: () => void;
  canApply: boolean;
  hasErrors: boolean;
}) {
  const { summary } = dryRun;
  const totalOpeningValue = summary.createCount > 0
    ? dryRun.rows
        .filter((r) => r.action === "CREATE")
        .reduce((sum, r) => sum + r.quantity * r.unitCost, 0)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-stone-900">Konfirmasi Import</h2>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
          <p className="text-sm text-amber-800">
            Import stok awal akan membuat transaksi persediaan dan tidak boleh dijalankan dua kali untuk data yang sama.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Total Baris" value={String(summary.totalRows)} tone="default" />
        <SummaryCard label="Master Baru" value={String(summary.createCount)} tone="success" />
        <SummaryCard label="Master Existing" value={String(summary.matchCount)} tone="info" />
        <SummaryCard label="Estimasi Nilai" value={formatCurrency(totalOpeningValue)} tone="default" />
      </div>

      <div className="rounded-lg border border-stone-200">
        <table className="text-xs">
          <thead className="bg-stone-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Code</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Name</th>
              <th className="px-3 py-2 text-left font-medium text-stone-700">Type</th>
              <th className="px-3 py-2 text-center font-medium text-stone-700">Aksi</th>
              <th className="px-3 py-2 text-right font-medium text-stone-700">Nilai</th>
            </tr>
          </thead>
          <tbody>
            {dryRun.rows.map((row) => (
              <tr key={row.rowNumber} className="border-t border-stone-100">
                <td className="px-3 py-2 font-mono">{row.code}</td>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2">{row.type}</td>
                <td className="px-3 py-2 text-center">
                  <ActionBadge action={row.action} />
                </td>
                <td className="px-3 py-2 text-right">
                  {formatCurrency(row.quantity * row.unitCost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-stone-500">
        Operation Key: <code className="font-mono">{operationKey}</code>
      </p>

      {hasErrors && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            Terdapat {summary.errorCount} baris dengan error. Import tidak dapat dilanjutkan.
          </p>
        </div>
      )}

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack} disabled={isApplying}>
          <ChevronLeft className="mr-2 h-4 w-4" />
          Kembali
        </Button>
        <Button
          size="sm"
          onClick={onApply}
          disabled={isApplying || !canApply}
        >
          {isApplying ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Memproses...
            </>
          ) : (
            "Konfirmasi & Import"
          )}
        </Button>
      </div>
    </div>
  );
}

function Step5Result({ result, onNewImport }: { result: OpeningStockResult; onNewImport: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="flex justify-center">
        <CheckCircle className="h-16 w-16 text-emerald-500" />
      </div>

      <div>
        <h2 className="text-xl font-bold text-stone-900">Import Berhasil</h2>
        <p className="mt-2 text-sm text-stone-600">
          {result.totalRows} baris diproses, {result.createdMasters} master dibuat, {result.matchedMasters} dicocokkan.
        </p>
      </div>

      <div className="mx-auto grid max-w-3xl gap-3 sm:grid-cols-3">
        <SummaryCard label="Master Dibuat" value={String(result.createdMasters)} tone="success" />
        <SummaryCard label="Master Dicocokkan" value={String(result.matchedMasters)} tone="info" />
        <SummaryCard label="Lot Dibuat" value={String(result.lotsCreated)} tone="default" />
        <SummaryCard label="Mutasi Persediaan" value={String(result.ledgerEntriesCreated)} tone="default" />
        <SummaryCard label="Total Nilai" value={formatCurrency(result.totalOpeningValue)} tone="default" />
      </div>

      {result.errors.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-left">
          <p className="text-sm font-medium text-amber-800 mb-2">Catatan:</p>
          <ul className="space-y-1 text-sm text-amber-800">
            {result.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-center gap-3">
        <Button onClick={() => window.location.assign("/inventory")}>
          Lihat Persediaan
        </Button>
        <Button variant="outline" onClick={onNewImport}>
          Import File Lain
        </Button>
      </div>
    </div>
  );
}
