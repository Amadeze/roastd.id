"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { updateTenantSettings } from "../actions";
import { toast } from "sonner";
import { toastSafe } from "@/lib/toast";
import { Tenant } from "@prisma/client";
import { Save, ExternalLink, Upload, Phone, RotateCcw } from "lucide-react";
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
import { resetOnboarding } from "@/app/onboarding/actions";
import { tenantStorefrontUrl } from "@/lib/tenant-host";

// Helper type for tenant since Prisma Client might not have typed the new fields perfectly in this file's context if cached
type ExtendedTenant = Omit<Tenant, "midtransServerKey" | "artisanWebhookToken"> & {
  whatsappNumber?: string | null;
  aboutText?: string | null;
  catalogTitle?: string | null;
  catalogSubtitle?: string | null;
  footerText?: string | null;
  midtransClientKey?: string | null;
  midtransServerKeyConfigured: boolean;
  midtransIsProduction?: boolean;
  backgroundImageUrl?: string | null;
  contactEmail?: string | null;
  instagramHandle?: string | null;
  fontFamily?: string;
  themeMode?: string;
  borderRadius?: string;
  animationStyle?: string;
  animationDirection?: string;
  iconStyle?: string;
  problemStatement?: string | null;
  solutionStatement?: string | null;
  uspText?: string | null;
  features?: any | null;
  testimonials?: any | null;
  faqs?: any | null;
  setupCompletedAt?: Date | null;
  showOnLanding?: boolean;
  landingDisplayName?: string | null;
};

export function SettingsClient({ tenant }: { tenant: ExtendedTenant }) {
  const portalPath = `/tenant/${tenant.subdomain}`;
  const [name, setName] = useState(tenant.name || "");
  const [timezone, setTimezone] = useState(tenant.timezone || "Asia/Jakarta");
  const [themeColor] = useState(tenant.themeColor || "amber");
  const [heroText] = useState(tenant.heroText || "");
  const [logoUrl, setLogoUrl] = useState(tenant.logoUrl || "");
  const [heroImageUrl, setHeroImageUrl] = useState(tenant.heroImageUrl || "");
  const [backgroundImageUrl, setBackgroundImageUrl] = useState(tenant.backgroundImageUrl || "");
  const [layoutStyle] = useState(tenant.layoutStyle || "modern");
  const [currentOrigin, setCurrentOrigin] = useState("http://localhost:3000");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setCurrentOrigin(window.location.origin);
    }
  }, []);
  const storefrontUrl = tenant.subdomain ? tenantStorefrontUrl(tenant.subdomain, currentOrigin) : portalPath;
  
  // Theme Engine
  const [fontFamily] = useState(tenant.fontFamily || "sans");
  const [themeMode] = useState(tenant.themeMode || "light");
  const [borderRadius] = useState(tenant.borderRadius || "md");
  const [animationStyle] = useState(tenant.animationStyle || "subtle");
  const [animationDirection] = useState(tenant.animationDirection || "up");
  const [iconStyle] = useState(tenant.iconStyle || "regular");
  
  // New Fields
  const [whatsappNumber, setWhatsappNumber] = useState(tenant.whatsappNumber || "");
  const [contactEmail, setContactEmail] = useState(tenant.contactEmail || "");
  const [instagramHandle, setInstagramHandle] = useState(tenant.instagramHandle || "");
  const [aboutText] = useState(tenant.aboutText || "");
  const [catalogTitle] = useState(tenant.catalogTitle || "");
  const [catalogSubtitle] = useState(tenant.catalogSubtitle || "");
  const [footerText] = useState(tenant.footerText || "");

  // Dynamic Landing Page Content
  const [problemStatement] = useState(tenant.problemStatement || "");
  const [solutionStatement] = useState(tenant.solutionStatement || "");
  const [uspText] = useState(tenant.uspText || "");
  const [features] = useState<any[]>(
    Array.isArray(tenant.features) ? tenant.features : []
  );
  const [testimonials] = useState<any[]>(
    Array.isArray(tenant.testimonials) ? tenant.testimonials : []
  );
  const [faqs] = useState<any[]>(
    Array.isArray(tenant.faqs) ? tenant.faqs : []
  );

  // Landing page social proof opt-in
  const [showOnLanding, setShowOnLanding] = useState(tenant.showOnLanding ?? false);
  const [landingDisplayName, setLandingDisplayName] = useState(tenant.landingDisplayName || "");

  // Payment Gateway
  const [midtransClientKey, setMidtransClientKey] = useState(tenant.midtransClientKey || "");
  const [midtransServerKey, setMidtransServerKey] = useState("");
  const [midtransIsProduction, setMidtransIsProduction] = useState(tenant.midtransIsProduction || false);
  const [isTestingMidtrans, setIsTestingMidtrans] = useState(false);

  // Tax (PPN) settings
  const [taxEnabled, setTaxEnabled] = useState(tenant.taxEnabled || false);
  const [defaultTaxRate, setDefaultTaxRate] = useState(Number(tenant.defaultTaxRate ?? 11));

  const [refreshKey, setRefreshKey] = useState(0);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [previewEnabled, setPreviewEnabled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const syncPreview = () => setPreviewEnabled(media.matches);
    syncPreview();
    media.addEventListener("change", syncPreview);
    return () => media.removeEventListener("change", syncPreview);
  }, []);

  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState<{ logo: boolean; hero: boolean; background: boolean }>({ logo: false, hero: false, background: false });

  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: "logo" | "hero" | "background") => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(prev => ({ ...prev, [type]: true }));
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.success) {
        if (type === "logo") setLogoUrl(data.url);
        if (type === "hero") setHeroImageUrl(data.url);
        if (type === "background") setBackgroundImageUrl(data.url);
        toast.success("Gambar berhasil diunggah.");
      } else {
        throw new Error(data.error);
      }
    } catch (error: any) {
      toastSafe.error("Upload failed: " + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [type]: false }));
    }
  };

  const testMidtrans = async () => {
    if (!midtransServerKey && !tenant.midtransServerKeyConfigured) {
      toast.error("Simpan Server Key terlebih dahulu.");
      return;
    }
    
    setIsTestingMidtrans(true);
    try {
      const res = await fetch("/api/settings/test-midtrans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverKey: midtransServerKey || undefined,
          isProduction: midtransIsProduction
        })
      });
      const data = await res.json();
      if (data.success) {
        toastSafe.success(data.message);
      } else {
        toastSafe.error(data.message);
      }
    } catch {
      toast.error("Koneksi ke Midtrans gagal.");
    } finally {
      setIsTestingMidtrans(false);
    }
  };

  async function handleSave() {
    setIsSaving(true);
    try {
      const result = await updateTenantSettings(tenant.id, {
        name,
        timezone,
        themeColor,
        heroText,
        logoUrl,
        heroImageUrl,
        layoutStyle,
        whatsappNumber,
        aboutText,
        catalogTitle,
        catalogSubtitle,
        footerText,
        midtransClientKey,
        ...(midtransServerKey ? { midtransServerKey } : {}),
        midtransIsProduction,
        backgroundImageUrl,
        contactEmail,
        instagramHandle,
        fontFamily,
        themeMode,
        borderRadius,
        animationStyle,
        animationDirection,
        iconStyle,
        problemStatement,
        solutionStatement,
        uspText,
        taxEnabled,
        defaultTaxRate,
        features: features.filter((feature) => feature.title?.trim() && feature.desc?.trim()),
        testimonials: testimonials.filter((item) => item.name?.trim() && item.text?.trim()),
        faqs: faqs.filter((item) => item.question?.trim() && item.answer?.trim()),
        showOnLanding,
        landingDisplayName,
      });
      if (!result.success) {
        toastSafe.error(result.error || "Gagal menyimpan pengaturan.");
        return;
      }
      toast.success("Pengaturan berhasil disimpan.");
      setRefreshKey(prev => prev + 1);
    } catch (error: any) {
      toastSafe.error("Failed to save settings: " + (error?.message || String(error)));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid min-h-0 grid-cols-1 gap-6 xl:h-[calc(100dvh-176px)] xl:grid-cols-2">
      {/* Left Column: Form */}
      <div className="space-y-6 pb-8 xl:overflow-y-auto xl:pr-2 custom-scrollbar">
      {/* Basic Settings */}
      <div className="glass-card-static p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Roastery Identity</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">Roastery Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">Operational Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
            >
              <option value="Asia/Jakarta">WIB Â· Asia/Jakarta</option>
              <option value="Asia/Makassar">WITA Â· Asia/Makassar</option>
              <option value="Asia/Jayapura">WIT Â· Asia/Jayapura</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">Dipakai untuk batas laporan harian, mingguan, dan bulanan.</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">Logo Image</label>
            <div className="flex items-center gap-4">
              {logoUrl && (
                <div className="w-16 h-16 rounded-xl overflow-hidden bg-white shadow-sm border border-slate-100 flex items-center justify-center">
                  <Image src={logoUrl} alt="Logo" width={64} height={64} className="h-full w-full object-contain" unoptimized />
                </div>
              )}
              <div className="flex-1">
                <input 
                  type="file" 
                  ref={logoInputRef} 
                  className="hidden" 
                  accept="image/*"
                  onChange={e => handleFileUpload(e, "logo")}
                />
                <button
                  onClick={() => logoInputRef.current?.click()}
                  disabled={isUploading.logo}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  <Upload size={16} />
                  {isUploading.logo ? "Uploading..." : "Upload Logo"}
                </button>
                <p className="text-xs text-slate-500 mt-2">Recommended: Square image, transparent PNG.</p>
              </div>
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
              <Phone size={14} className="text-emerald-600" /> WhatsApp Contact (For Orders)
            </label>
            <input
              type="text"
              value={whatsappNumber}
              onChange={e => setWhatsappNumber(e.target.value)}
              placeholder="e.g. 628123456789"
              className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
            />
            <p className="text-xs text-slate-500 mt-1">Gunakan kode negara (misal: 62) tanpa spasi atau +. Semua pesanan (checkout) tanpa payment gateway akan masuk ke nomor ini.</p>
          </div>

          {/* Landing Page Social Proof Opt-in */}
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-sm font-bold text-slate-800">Tampilkan di Landing Page roastd.id</p>
                <p className="mt-1 text-xs text-slate-500">
                  Logo roastery kamu akan ditampilkan di halaman utama roastd.id sebagai social proof.
                  Default: <strong>tidak ditampilkan</strong>. Logo yang digunakan adalah logo yang sudah diupload di atas.
                </p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center" aria-label="Toggle tampil di landing page">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={showOnLanding}
                  onChange={e => setShowOnLanding(e.target.checked)}
                />
                <div className="h-5 w-9 rounded-full bg-slate-200 peer-checked:bg-amber-500 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-amber-500 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
              </label>
            </div>
            {showOnLanding && (
              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nama tampil (opsional)</label>
                <input
                  type="text"
                  value={landingDisplayName}
                  onChange={e => setLandingDisplayName(e.target.value)}
                  placeholder={`Default: ${tenant.name}`}
                  maxLength={80}
                  className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
                />
                <p className="mt-1 text-xs text-slate-400">Kosongkan untuk memakai nama roastery.</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Contact Email</label>
              <input
                type="email"
                value={contactEmail}
                onChange={e => setContactEmail(e.target.value)}
                placeholder="hello@roastery.com"
                className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Instagram Handle</label>
              <div className="flex">
                <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-slate-200 bg-slate-50 text-slate-500 text-sm">@</span>
                <input
                  type="text"
                  value={instagramHandle}
                  onChange={e => setInstagramHandle(e.target.value)}
                  placeholder="roastery"
                  className="w-full rounded-r-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal & Saldo Awal — sekarang dikelola di Keuangan > Modal */}
      <div className="glass-card-static p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Modal Perusahaan</h2>
        <p className="text-sm text-slate-500 mb-3">
          Kelola setoran modal, tambahan modal, dan prive pemilik di halaman Keuangan.
        </p>
        <a
          href="/keuangan"
          className="inline-flex items-center gap-2 text-sm font-semibold text-amber-700 hover:text-amber-800 hover:underline"
        >
          <ExternalLink size={14} />
          Buka Manajemen Modal →
        </a>
      </div>

      {/* Tax (PPN) Settings */}
      <div className="glass-card-static p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-1">Pajak Penjualan (PPN)</h2>
        <p className="text-sm text-slate-500 mb-4">
          Atur pemungutan PPN pada nota penjualan (kasir, penjualan, dan portal B2B).
          Saat nonaktif, seksi pajak disembunyikan dari form dan tidak ada pajak yang dikenakan.
          Perubahan setting ini tidak mengubah nota yang sudah diterbitkan.
        </p>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={taxEnabled}
              onChange={(e) => setTaxEnabled(e.target.checked)}
              className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 h-4 w-4"
            />
            <span className="text-sm font-semibold text-slate-700">Aktifkan pemungutan PPN</span>
          </label>
          <div className={taxEnabled ? "" : "pointer-events-none opacity-50"}>
            <label className="block text-sm font-semibold text-slate-700 mb-1">Tarif PPN Default (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={defaultTaxRate}
              onChange={(e) => setDefaultTaxRate(Number(e.target.value) || 0)}
              className="w-32 rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
            />
            <p className="text-xs text-slate-500 mt-1">Dipakai saat jenis pajak "PPN" dipilih di form nota.</p>
          </div>
        </div>
      </div>

      {/* Payment Gateway */}
      <div className="glass-card-static p-6">
        <div className="flex items-center justify-between mb-6 border-b border-slate-100 pb-4">
          <h2 className="text-lg font-bold text-slate-800">Payment Gateway (Midtrans)</h2>
          <span className="bg-domain-inventory/10 px-2 py-1 text-xs font-semibold text-domain-inventory">Future ready</span>
        </div>
        
        <div className="space-y-4">
          <p className="text-sm text-slate-500 mb-4">
            Jika Midtrans Client Key dan Server Key dikosongkan, fitur keranjang B2B akan secara otomatis mengalihkan pesanan ke WhatsApp Anda. 
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Client Key</label>
              <input
                type="text"
                value={midtransClientKey}
                onChange={e => setMidtransClientKey(e.target.value)}
                placeholder="SB-Mid-client-..."
                className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Server Key (Rahasia)</label>
              <input
                type="password"
                value={midtransServerKey}
                onChange={e => setMidtransServerKey(e.target.value)}
                placeholder="SB-Mid-server-..."
                className="w-full rounded-xl border-slate-200 bg-white/50 px-4 py-2 text-sm focus:border-amber-500 focus:ring-amber-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={midtransIsProduction} 
                onChange={(e) => setMidtransIsProduction(e.target.checked)}
                className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              <span className="text-sm font-semibold text-slate-700">Production Mode</span>
            </label>

            <button 
              onClick={testMidtrans}
              disabled={isTestingMidtrans}
              className="ml-auto flex items-center gap-2 px-4 py-1.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
            >
              {isTestingMidtrans ? "Testing..." : "Test Connection"}
            </button>
          </div>
        </div>
      </div>

      {/* B2B Portal Customization (roastd.id Studio) */}
      <div className="rounded-card border border-border bg-card shadow-elevation-soft p-6 mt-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-bold text-slate-800">B2B Portal Customization</h2>
              <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wider text-amber-600">
                roastd.id Studio
              </span>
            </div>
            <p className="text-xs text-slate-500 max-w-xl">
              Kustomisasi tampilan, warna, font, teks, katalog produk, dan layout halaman B2B Portal Anda secara live interaktif menggunakan <strong className="text-slate-700">roastd.id Theme Studio</strong> (arsitektur modular setara Shopify).
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {tenant.subdomain && (
              <a 
                href={storefrontUrl}
                target="_blank" 
                rel="noreferrer"
                className="flex items-center gap-1.5 bg-domain-sales/8 px-4 py-2.5 text-xs font-semibold text-domain-sales transition-colors hover:bg-domain-sales/15 rounded-xl"
              >
                View Portal <ExternalLink size={14} />
              </a>
            )}
            <a 
              href="/settings/portal-customizer"
                className="flex items-center gap-2 bg-gradient-to-r from-copper to-copper-strong px-5 py-2.5 text-xs font-bold text-card rounded-card shadow-md transition-all hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]"
            >
              Buka roastd.id Theme Studio <ExternalLink size={14} />
            </a>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-4 pb-12">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 rounded-[9px] bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
        >
          <Save size={18} />
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      {tenant.setupCompletedAt && (
        <div className="col-span-1 xl:col-span-2 border-t border-red-100 pt-6">
          <div className="rounded-2xl border border-red-200 bg-red-50/80 p-5">
            <h3 className="text-sm font-bold text-red-900">Zona Berbahaya</h3>
            <p className="mt-1 text-xs text-red-700">
              Reset onboarding akan menghapus semua progres panduan awal dan mengembalikan Anda ke langkah pertama. Data operasional (supplier, produk, stok, resep, pelanggan) tidak akan dihapus.
            </p>
            <button
              type="button"
              onClick={() => setIsResetDialogOpen(true)}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-xs font-bold text-red-700 shadow-sm transition-colors hover:bg-red-50"
            >
              <RotateCcw size={14} />
              Ulangi Panduan Awal
            </button>
            <AlertDialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Yakin ingin mengulangi panduan awal?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Anda akan diarahkan ke /onboarding. Data operasional Anda (supplier, produk, stok, resep, pelanggan) tidak akan terhapus.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Batal</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 text-white hover:bg-red-700"
                    onClick={async () => {
                      const res = await resetOnboarding();
                      if (res.success) {
                        toast.success("Panduan awal direset. Mengalihkan...");
                        setTimeout(() => { window.location.href = "/onboarding"; }, 1000);
                      } else {
                        toastSafe.error("Gagal reset panduan awal.");
                      }
                    }}
                  >
                    Ya, Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
      </div>

      {/* Right Column: Live Preview */}
      <div className="hidden xl:flex flex-col bg-slate-100 rounded-3xl border-4 border-slate-200 shadow-xl overflow-hidden relative">
        {/* Browser Top Bar */}
        <div className="bg-slate-200 text-slate-500 py-2.5 px-4 text-xs font-mono flex items-center justify-center gap-2 relative border-b border-slate-300">
          <span className="absolute left-4 flex gap-2">
            <span className="w-3 h-3 rounded-full bg-red-400"></span>
            <span className="w-3 h-3 rounded-full bg-amber-400"></span>
            <span className="w-3 h-3 rounded-full bg-green-400"></span>
          </span>
          <span className="bg-white px-6 py-1 rounded-full shadow-sm flex items-center gap-2">
            <span className="text-slate-400">ðŸ”’</span>
            {storefrontUrl}
          </span>
        </div>
        
        {/* Iframe */}
        <div className="flex-1 bg-white relative">
          {previewEnabled ? (
            <iframe
              key={refreshKey}
              src={portalPath}
              loading="lazy"
              className="w-full h-full border-none"
              title="Live Preview"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
