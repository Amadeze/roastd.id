"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { registerTenant, registerTenantWithGoogle } from "./actions";
import { Loader2, Store, AtSign, Key, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { motion } from "framer-motion";
import { AuthFrame } from "@/components/auth/AuthFrame";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlError = searchParams.get("error");
  const initialError = urlError === "AccountNotFound" 
    ? "Akun belum terdaftar. Anda tidak bisa login dengan Google tanpa akun, silakan buat workspace terlebih dahulu." 
    : "";
  const isGoogleMode = searchParams.get("mode") === "google";

  const [roasteryName, setRoasteryName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isGoogleMode) {
      if (!roasteryName || !subdomain) {
        setError("Nama Roastery dan Subdomain wajib diisi");
        return;
      }
    } else {
      if (!roasteryName || !subdomain || !email || !password) {
        setError("Semua kolom wajib diisi.");
        return;
      }
    }
    setError("");
    setLoading(true);

    try {
      const result = isGoogleMode 
        ? await registerTenantWithGoogle({ roasteryName, subdomain })
        : await registerTenant({
            roasteryName,
            subdomain,
            email,
            password,
          });
          
      if (!result.success) {
        setError(result.error || "Pendaftaran gagal. Periksa kembali data Anda dan coba lagi.");
        return;
      }
      if ("checkEmail" in result && result.checkEmail) {
        // Pendaftaran sukses tapi login menunggu verifikasi email.
        router.push(`/verify-email?sent=1&email=${encodeURIComponent(email)}`);
        return;
      }
      router.push("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan yang tidak terduga. Silakan coba lagi.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor="roastery-name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Nama Roastery</label>
        <div className="relative">
          <input
            id="roastery-name"
            type="text"
            placeholder="e.g. Senja Roastery"
            value={roasteryName}
            onChange={(e) => {
              setRoasteryName(e.target.value);
              if (!subdomain || subdomain === roasteryName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")) {
                setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
              }
            }}
            className="h-12 w-full rounded-[10px] border border-input bg-card pl-10 pr-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/20"
            required
          />
          <Store className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="portal-subdomain" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Portal Subdomain</label>
        <div className="flex overflow-hidden rounded-[10px] border border-input bg-card transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <div className="border-r border-border bg-muted/55 py-3 pl-4 pr-2 text-sm font-medium text-muted-foreground">
            https://
          </div>
          <input
            id="portal-subdomain"
            type="text"
            placeholder="senja"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            className="h-12 min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/65"
            required
          />
          <div className="hidden border-l border-border bg-muted/55 py-3 pl-2 pr-4 text-sm font-medium text-muted-foreground sm:block">
            .roastd.id
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Portal B2B khusus untuk roastery Anda.</p>
      </div>

      {!isGoogleMode && (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor="work-email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email kerja</label>
            <div className="relative">
              <input
                id="work-email"
                type="email"
                autoComplete="email"
                placeholder="admin@senjaroastery.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 w-full rounded-[10px] border border-input bg-card pl-10 pr-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/20"
                required={!isGoogleMode}
              />
              <AtSign className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="new-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</label>
            <div className="relative">
              <input
                id="new-password"
                type={showPass ? "text" : "password"}
                autoComplete="new-password"
                minLength={8}
                aria-describedby="password-requirements"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full rounded-[10px] border border-input bg-card pl-10 pr-11 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/65 focus:border-primary focus:ring-2 focus:ring-primary/20"
                required={!isGoogleMode}
              />
              <Key className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
            <p id="password-requirements" className="text-[11px] text-muted-foreground">
              Minimal 8 karakter, dengan satu huruf besar dan satu angka.
            </p>
          </div>
        </>
      )}

      {error && (
        <motion.div 
          initial={{ opacity: 0, y: -10 }} 
          animate={{ opacity: 1, y: 0 }}
          className="rounded-[10px] border border-destructive/20 bg-destructive/8 p-3 text-center text-sm text-destructive"
        >
          {error}
        </motion.div>
      )}

      <div className="pt-2">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={loading}
          className="flex h-12 w-full items-center justify-center rounded-[10px] bg-primary font-bold text-primary-foreground shadow-[0_12px_28px_-18px_rgba(91,32,17,.7)] transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Mulai 21 Hari Gratis"}
        </motion.button>
      </div>

      {!isGoogleMode ? (
        <>
          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">Atau</span>
            </div>
          </div>

          <a
            href="/api/auth/google"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-input bg-background font-bold text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              <path d="M1 1h22v22H1z" fill="none" />
            </svg>
            Daftar dengan Google
          </a>
        </>
      ) : (
        <div className="text-center pt-2">
          <Link href="/register" className="text-xs font-semibold text-muted-foreground hover:text-foreground">
            Batal dan daftar dengan Email
          </Link>
        </div>
      )}
    </form>
  );
}

export default function RegisterPage() {
  return (
    <AuthFrame
      eyebrow="Buat workspace"
      title="Mulai dari struktur yang benar."
      description="Siapkan identitas roastery dan akun owner. Alur operasional dapat dilengkapi setelah masuk."
      asideTitle="Bangun jejak operasi sejak batch pertama."
      asideDescription="Workspace baru menghubungkan pembelian, bahan, roast, produk, pesanan, dan pembayaran tanpa memaksa tim mengulang input."
      footer={
        <p>
          Sudah punya akun?{" "}
          <Link href="/login" className="font-semibold text-primary hover:text-primary/75">
            Masuk ke workspace
          </Link>
        </p>
      }
    >
      <Suspense fallback={<div className="py-10 text-sm text-muted-foreground">Menyiapkan formulir…</div>}>
        <RegisterForm />
      </Suspense>
    </AuthFrame>
  );
}
