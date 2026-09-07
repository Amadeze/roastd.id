"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, Activity } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type WebhookLog = {
  id: string;
  createdAt: string;
  event: string;
  payload: string;
  status: string;
  response: string;
};

export function WebhookLogModal() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      fetch("/api/settings/webhook-logs")
        .then((res) => res.json())
        .then((data) => setLogs(data.logs || []))
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-xl font-bold text-xs transition-colors flex items-center gap-1.5 shrink-0">
        <Activity size={14} /> Log Webhook
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Riwayat Webhook Artisan</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>
        ) : logs.length === 0 ? (
          <div className="text-center p-8 text-slate-500">Belum ada riwayat webhook.</div>
        ) : (
          <div className="space-y-4">
            {logs.map((log) => (
              <div key={log.id} className="p-4 border rounded-lg text-sm bg-slate-50">
                <div className="flex justify-between mb-2">
                  <span className="font-bold">{log.event}</span>
                  <span className="text-slate-500">{format(new Date(log.createdAt), "dd MMM yyyy HH:mm:ss")}</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs font-semibold text-slate-500">Payload:</span>
                    <pre className="mt-1 bg-slate-800 text-slate-100 p-2 rounded text-xs overflow-x-auto">
                      {log.payload}
                    </pre>
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-slate-500">Response ({log.status}):</span>
                    <pre className="mt-1 bg-slate-800 text-slate-100 p-2 rounded text-xs overflow-x-auto">
                      {log.response}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
