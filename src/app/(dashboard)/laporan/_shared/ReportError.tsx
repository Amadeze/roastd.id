import { AlertTriangle, RefreshCw } from "lucide-react";

interface ReportErrorProps {
  message: string;
  onRetry?: () => void;
}

export function ReportError({ message, onRetry }: ReportErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-danger-mid bg-danger-light/60 px-6 py-10 text-center">
      <AlertTriangle className="h-8 w-8 text-status-danger" />
      <p className="max-w-md text-sm text-danger-base">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-lg bg-danger-base px-4 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110"
        >
          <RefreshCw size={14} />
          Coba lagi
        </button>
      ) : null}
    </div>
  );
}
