"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Loader2 } from "lucide-react";

import { AuthFrame } from "@/components/auth/AuthFrame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPassword } from "./actions";

function ResetPasswordForm() {
  const token = useSearchParams().get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setMessage("Konfirmasi password tidak sama.");
      return;
    }
    setLoading(true);
    try {
      const result = await resetPassword(token, password);
      setSuccess(result.success);
      setMessage(result.message);
    } finally {
      setLoading(false);
    }
  }

  return (
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password baru</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={success}
            className="h-12 bg-white"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmation">Konfirmasi password</Label>
          <Input
            id="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            disabled={success}
            className="h-12 bg-white"
          />
        </div>
        {message && (
          <p
            role="status"
            className={success
              ? "border border-domain-inventory/25 bg-domain-inventory/8 px-4 py-3 text-sm text-domain-inventory"
              : "border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive"
            }
          >
            {message}
          </p>
        )}
        {!success && (
          <Button type="submit" disabled={loading || !token} className="h-12 w-full">
            {loading ? <Loader2 className="animate-spin" size={18} /> : "Perbarui password"}
          </Button>
        )}
      </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthFrame
      eyebrow="Keamanan akun"
      title="Tetapkan kunci akses baru."
            description="Gunakan minimal 8 karakter dengan satu huruf kapital dan satu angka."
      asideTitle="Identitas operasional, dijaga."
      asideDescription="Akses akun dipulihkan tanpa menghapus histori transaksi, roast profile, atau catatan audit."
      footer={(
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Kembali ke login
        </Link>
      )}
    >
      <Suspense fallback={<div className="text-sm text-muted-foreground">Menyiapkan formulir aman…</div>}>
        <ResetPasswordForm />
      </Suspense>
    </AuthFrame>
  );
}
