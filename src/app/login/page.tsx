"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loginAction } from "./actions";
import { Eye, EyeOff, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { motion } from "framer-motion";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { Eyebrow } from "@/components/ui/eyebrow";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedFrom = searchParams.get("from");
  const from =
    requestedFrom?.startsWith("/") && !requestedFrom.startsWith("//")
      ? requestedFrom
      : "/dashboard";
  const urlError = searchParams.get("error");
  const verified = searchParams.get("verified") === "1";
  const initialError = urlError === "AccountNotFound" 
    ? "Akun belum terdaftar. Silakan register terlebih dahulu." 
    : urlError === "OAuthError" 
    ? "Gagal login dengan Google." 
    : urlError === "GoogleEmailNotVerified"
    ? "Email Google belum terverifikasi."
    : urlError === "GoogleAccountConflict"
    ? "Akun Google sudah tertaut ke pengguna lain. Hubungi administrator."
    : urlError === "EmailRegisteredUsePassword"
    ? "Email ini terdaftar dengan password. Silakan masuk menggunakan email dan password."
    : urlError === "AccountDisabled"
    ? "Akun dinonaktifkan. Hubungi administrator."
    : urlError === "InvalidState" 
    ? "Sesi login tidak valid, coba lagi."
    : "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [notice, setNotice] = useState(verified ? "Email terverifikasi. Silakan masuk." : "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setNeedsVerification(false);
    setLoading(true);
    try {
      const result = await loginAction(email, password);
      if (!result.success) {
        setError(result.error);
        setNeedsVerification(result.code === "EmailNotVerified");
        return;
      }
      if (result.role === "SUPERADMIN") {
        router.push("/superadmin");
      } else {
        router.push(from);
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Eyebrow tone="neutral" as="label" htmlFor="email" className="block">Email</Eyebrow>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="admin@roasteryos.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 w-full rounded-[10px] border border-input bg-card px-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Eyebrow tone="neutral" as="label" htmlFor="password" className="block">Password</Eyebrow>
          <Link href="/forgot-password" className="text-xs font-semibold text-primary transition-colors hover:text-primary/75">
            Lupa password?
          </Link>
        </div>
        <div className="relative">
          <input
            id="password"
            type={showPass ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12 w-full rounded-[10px] border border-input bg-card pl-4 pr-11 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/20"
            required
          />
          <button
            type="button"
            onClick={() => setShowPass(!showPass)}
            aria-label={showPass ? "Sembunyikan password" : "Tampilkan password"}
            aria-pressed={showPass}
            className="absolute right-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-[10px] border border-green-600/20 bg-green-600/8 px-4 py-3">
          <CheckCircle2 size={16} className="shrink-0 text-green-600" />
          <p className="text-sm text-green-700">{notice}</p>
        </div>
      )}

      {error && (
        <motion.div 
          initial={{ opacity: 0, y: -10 }} 
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-2 rounded-[10px] border border-destructive/20 bg-destructive/8 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0 text-red-500" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
          {needsVerification ? (
            <Link
              href={`/verify-email?email=${encodeURIComponent(email)}`}
              className="pl-6 text-sm font-semibold text-primary hover:text-primary/75"
            >
              Kirim ulang tautan verifikasi
            </Link>
          ) : null}
        </motion.div>
      )}

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        type="submit"
        disabled={loading}
        className="mt-2 flex h-12 w-full items-center justify-center rounded-[10px] bg-primary font-bold text-primary-foreground shadow-[0_12px_28px_-18px_rgba(91,32,17,.7)] transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          "Sign In"
        )}
      </motion.button>

      <div className="relative my-2">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Atau</span>
        </div>
      </div>

      <a
        href={`/api/auth/google?from=${encodeURIComponent(from)}`}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-input bg-background font-bold text-foreground shadow-sm transition-colors hover:bg-muted"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          <path d="M1 1h22v22H1z" fill="none" />
        </svg>
        Sign in dengan Google
      </a>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthFrame
      eyebrow="Workspace access"
      title="Kembali ke alur operasi."
      description="Masuk menggunakan akun workspace yang telah dibuat oleh owner roastery."
      asideTitle="Satu alur, dari karung sampai kas."
      asideDescription="Keputusan harian tidak hidup di spreadsheet terpisah. Pasokan, roasting, produksi, penjualan, dan arus uang saling terhubung."
      footer={
        <p>
          Belum memiliki workspace?{" "}
          <Link href="/register" className="font-semibold text-primary hover:text-primary/75">
            Mulai setup roastery
          </Link>
        </p>
      }
    >
      <Suspense fallback={<div className="py-4 text-sm text-muted-foreground">Memuat akses…</div>}>
        <LoginForm />
      </Suspense>
    </AuthFrame>
  );
}
