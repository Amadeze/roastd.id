"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Monitor, Tablet, Smartphone, Eye, Save,
  ChevronLeft, Palette,
  Undo2, Redo2, Sparkles, RotateCcw, Loader2, ArrowLeft,
  Home, Store, FileText, Settings, Menu, Layers,
  Shield, AlertCircle, CheckCircle2, TrendingUp,
} from "lucide-react";
import { useCustomizerStore } from "@/features/portal-theme/client/store";
import { ThemePresetSelector } from "@/features/portal-theme/components/ThemePresetSelector";
import { SectionList } from "@/features/portal-theme/components/SectionList";
import { SectionSettings } from "@/features/portal-theme/components/SectionSettings";
import { GlobalColorsPanel } from "@/features/portal-theme/components/global/GlobalColors";
import { GlobalTypographyPanel } from "@/features/portal-theme/components/global/GlobalTypography";
import { InlinePreview } from "@/features/portal-theme/components/InlinePreview";
import { AddSectionDialog } from "@/features/portal-theme/components/AddSectionDialog";
import { loadPortalTheme } from "@/features/portal-theme/server/actions";
import { tenantStorefrontUrl } from "@/lib/tenant-host";
import { GlobalAnimationsPanel } from "@/features/portal-theme/components/global/GlobalAnimations";
import { GlobalSettingsPanel } from "@/features/portal-theme/components/global/GlobalSettings";
import {
  getSectionsForArea,
  isSectionArea,
  sectionTypeMatchesArea,
} from "@/features/portal-theme/registry";

type SidebarTab = "tema" | "header" | "beranda" | "katalog" | "konten" | "footer" | "pengaturan";

const TAB_CONFIG = [
  { id: "tema", label: "Tema", icon: Palette, description: "Presets, Colors, Typography" },
  { id: "header", label: "Header", icon: Menu, description: "Navigation & Brand" },
  { id: "beranda", label: "Beranda", icon: Home, description: "Hero, Bento, Marquee" },
  { id: "katalog", label: "Katalog", icon: Store, description: "Products & Collections" },
  { id: "konten", label: "Konten", icon: FileText, description: "Text, Media, Marketing" },
  { id: "footer", label: "Footer", icon: Layers, description: "Footer & System Info" },
  { id: "pengaturan", label: "Pengaturan", icon: Settings, description: "Animasi, SEO, dan integrasi" },
] as const;

interface ReadinessResult {
  score: number;
  checks: Array<{ id: string; label: string; passed: boolean; severity: string }>;
  canTransact: boolean;
  missingCritical: string[];
  missingWarning: string[];
}

export default function PortalCustomizerPage() {
  const initialize = useCustomizerStore((s) => s.initialize);
  const previewViewport = useCustomizerStore((s) => s.previewViewport);
  const setPreviewViewport = useCustomizerStore((s) => s.setPreviewViewport);
  const selectedSectionId = useCustomizerStore((s) => s.selectedSectionId);
  const selectSection = useCustomizerStore((s) => s.selectSection);
  const isDirty = useCustomizerStore((s) => s.isDirty);
  const isSaving = useCustomizerStore((s) => s.isSaving);
  const isPublishing = useCustomizerStore((s) => s.isPublishing);
  const saveDraft = useCustomizerStore((s) => s.saveDraft);
  const publish = useCustomizerStore((s) => s.publish);
  const discardChanges = useCustomizerStore((s) => s.discardChanges);
  const undo = useCustomizerStore((s) => s.undo);
  const redo = useCustomizerStore((s) => s.redo);
  const undoStack = useCustomizerStore((s) => s.undoStack);
  const redoStack = useCustomizerStore((s) => s.redoStack);

  const [activeTab, setActiveTab] = useState<SidebarTab>("tema");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [products, setProducts] = useState<any[]>([]);
  const [offerings, setOfferings] = useState<any[]>([]);
  const [subdomain, setSubdomain] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"editor" | "preview">("editor");
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(true);

  // Guard unmount: fetch/promise yang selesai setelah komponen pergi tidak
  // boleh lagi memanggil setState (React warning + kebocoran update).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchReadiness = useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/readiness");
      if (res.ok) {
        const data = await res.json();
        if (isMountedRef.current) setReadiness(data);
      }
    } catch {
      // ignore
    } finally {
      if (isMountedRef.current) setReadinessLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReadiness();
  }, [fetchReadiness]);

  useEffect(() => {
    loadPortalTheme().then((res) => {
      if (!isMountedRef.current) return;
      if (res.success && res.data) {
        const data = res.data as { config?: any; portalTheme?: any; subdomain?: string };
        if (data.config) {
          initialize(data.config);
        }
        if (data.subdomain) {
          setSubdomain(data.subdomain);
        }
      }
      setLoaded(true);
    });

    fetch("/api/portal-theme/products")
      .then((r) => r.json())
      .then((d) => {
        if (!isMountedRef.current) return;
        if (d && d.products) setProducts(d.products);
        if (d && d.offerings) setOfferings(d.offerings);
      })
      .catch(() => {});
  }, [initialize]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      if (isMountedRef.current) setToast(null);
    }, 3500);
  };

  const handleSaveDraft = async () => {
    await saveDraft();
    showToast("Draft saved successfully!");
  };

  const handlePublish = async () => {
    await publish();
    showToast("🎉 Theme published to live portal!");
  };

  if (!loaded) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center bg-gray-950 text-white space-y-4" aria-busy="true" aria-label="Memuat portal customizer">
        <Loader2 size={32} className="animate-spin text-amber-500" />
        <p className="text-sm font-medium tracking-wide text-gray-400">Loading Customizer Studio...</p>
      </div>
    );
  }

  const getReadinessColor = (score: number) => {
    if (score >= 90) return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
    if (score >= 70) return "text-amber-400 bg-amber-500/10 border-amber-500/30";
    if (score >= 50) return "text-orange-400 bg-orange-500/10 border-orange-500/30";
    return "text-red-400 bg-red-500/10 border-red-500/30";
  };

  const getReadinessLabel = (score: number) => {
    if (score >= 90) return "Siap Jual";
    if (score >= 70) return "Hampir Siap";
    if (score >= 50) return "Perlu Perbaikan";
    return "Belum Siap";
  };

  const getReadinessIcon = (score: number) => {
    if (score >= 90) return <CheckCircle2 size={14} />;
    if (score >= 70) return <TrendingUp size={14} />;
    if (score >= 50) return <AlertCircle size={14} />;
    return <Shield size={14} />;
  };

  const getFilteredSections = () => {
    const workingDraft = useCustomizerStore.getState().workingDraft;
    if (!isSectionArea(activeTab)) return workingDraft.sections;
    return workingDraft.sections.filter((section) =>
      sectionTypeMatchesArea(section.type, activeTab),
    );
  };

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-950 font-sans text-white">
      {toast && (
        <div role="status" aria-live="polite" className="fixed top-20 right-6 z-50 animate-bounce flex items-center gap-2 rounded-xl bg-emerald-600/90 backdrop-blur-md px-4 py-3 text-sm font-semibold text-white shadow-2xl border border-emerald-400/30">
          <Sparkles size={16} />
          <span>{toast}</span>
        </div>
      )}

      <header className="z-20 flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-800 bg-gray-900/90 px-2 py-2 backdrop-blur sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link
            href="/settings"
            className="flex items-center gap-1.5 rounded-lg bg-gray-800/80 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-all"
          >
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Settings</span>
            <span className="sr-only sm:hidden">Kembali ke pengaturan</span>
          </Link>
          <div className="hidden h-4 w-px bg-gray-800 sm:block" />
          <div className="hidden items-center gap-2 sm:flex">
            <span className="font-bold text-white tracking-wide text-sm">Portal Customizer</span>
            <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-400">
              roastd.id Studio
            </span>
          </div>
        </div>

        <div className="hidden items-center rounded-xl border border-gray-800/80 bg-gray-950/80 p-1 shadow-inner sm:flex">
          {[
            { id: "desktop", icon: Monitor, label: "Desktop" },
            { id: "tablet", icon: Tablet, label: "Tablet" },
            { id: "mobile", icon: Smartphone, label: "Mobile" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setPreviewViewport(id as any)}
              title={label}
              aria-label={`Preview ${label}`}
              aria-pressed={previewViewport === id}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-all ${
                previewViewport === id
                  ? "bg-gray-800 text-amber-400 shadow-sm border border-gray-700/60"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Icon size={13} />
              <span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <div className="hidden items-center rounded-lg border border-gray-800 bg-gray-950/60 p-0.5 sm:flex">
            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              title="Undo"
              aria-label="Undo perubahan theme"
              className="p-1.5 rounded text-gray-400 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
            >
              <Undo2 size={15} />
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Redo"
              aria-label="Redo perubahan theme"
              className="p-1.5 rounded text-gray-400 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
            >
              <Redo2 size={15} />
            </button>
          </div>

          <div className="h-4 w-px bg-gray-800" />

          <div className="flex items-center gap-1.5 text-xs px-2">
            <span className={`h-2 w-2 rounded-full ${isDirty ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
            <span className="text-gray-400 text-[11px] font-medium hidden lg:inline">
              {isDirty ? "Unsaved changes" : "All saved"}
            </span>
          </div>

          {isDirty && (
            <button
              onClick={discardChanges}
              title="Revert to last saved state"
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <RotateCcw size={13} />
              <span className="hidden sm:inline">Discard</span>
            </button>
          )}

          {readiness && (
            <div
              className={`hidden sm:flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold border ${getReadinessColor(readiness.score)}`}
              title={`${readiness.missingCritical.length} critical, ${readiness.missingWarning.length} warning`}
            >
              {getReadinessIcon(readiness.score)}
              <span>{getReadinessLabel(readiness.score)}</span>
              <span className="font-mono">{readiness.score}</span>
            </div>
          )}
          {readiness && (
            <div className="sm:hidden">
              <div className="flex items-center gap-2 rounded-xl bg-gray-800 border border-gray-700 px-2 py-1 text-xs font-bold text-white">
                <span className={`h-2 w-2 rounded-full ${readiness.score >= 70 ? "bg-emerald-400" : readiness.score >= 50 ? "bg-amber-400" : "bg-red-400"}`} />
                {readiness.score}
              </div>
            </div>
          )}
          {readinessLoading && <Loader2 size={14} className="animate-spin text-gray-400" />}

          <button
            onClick={handleSaveDraft}
            disabled={isSaving || !isDirty}
            className="flex items-center gap-1.5 rounded-xl border border-gray-700 bg-gray-800 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin text-amber-400" /> : <Save size={14} />}
            <span>Save Draft</span>
          </button>

          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-1.5 text-xs font-bold text-gray-950 hover:from-amber-400 hover:to-amber-500 transition-all shadow-lg shadow-amber-500/20 active:scale-95 disabled:opacity-50"
          >
            {isPublishing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            <span>Publish Theme</span>
          </button>

          <a
            href={subdomain ? tenantStorefrontUrl(subdomain) : undefined}
            target="_blank"
            rel="noreferrer"
            title="View Live Portal in new tab"
            className="p-2 rounded-xl bg-gray-800/80 text-gray-300 hover:text-white hover:bg-gray-800 border border-gray-700/60 transition-all"
            aria-label="Lihat storefront live di tab baru"
            aria-disabled={!subdomain}
            tabIndex={subdomain ? 0 : -1}
          >
            <Eye size={15} />
          </a>
        </div>
        <div className="order-3 grid w-full grid-cols-2 gap-1 rounded-xl border border-gray-800 bg-gray-950/80 p-1 lg:hidden">
          <button type="button" onClick={() => setMobilePane("editor")} aria-pressed={mobilePane === "editor"} className={`rounded-lg px-3 py-2 text-xs font-semibold ${mobilePane === "editor" ? "bg-gray-800 text-amber-400" : "text-gray-400"}`}>Editor</button>
          <button type="button" onClick={() => setMobilePane("preview")} aria-pressed={mobilePane === "preview"} className={`rounded-lg px-3 py-2 text-xs font-semibold ${mobilePane === "preview" ? "bg-gray-800 text-amber-400" : "text-gray-400"}`}>Preview</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className={`${mobilePane === "editor" ? "flex" : "hidden"} z-10 w-full shrink-0 flex-col border-r border-gray-800 bg-gray-900 shadow-2xl lg:flex lg:w-[360px]`}>
          <div className="grid grid-cols-7 border-b border-gray-800 bg-gray-950/40 p-1 gap-0.5 shrink-0">
            {TAB_CONFIG.map(({ id, label, icon: Icon, description }) => (
              <button
                key={id}
                onClick={() => {
                  setActiveTab(id as SidebarTab);
                  if (id !== "tema") selectSection(null);
                }}
                title={description}
                aria-pressed={activeTab === id}
                className={`flex flex-col items-center justify-center gap-1 py-2 rounded-xl text-[10px] font-semibold transition-all ${
                  activeTab === id
                    ? "bg-gray-800 text-amber-400 shadow-sm border border-gray-700/50"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-900/60"
                }`}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Readiness — always visible above tabs content, soft guard */}
          {readiness && (
            <div className="border-b border-gray-800 bg-gray-950/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="relative h-12 w-12 shrink-0">
                    <svg width={48} height={48} className="-rotate-90">
                      <circle cx={24} cy={24} r={18} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={4} />
                      <circle
                        cx={24}
                        cy={24}
                        r={18}
                        fill="none"
                        stroke={readiness.score >= 90 ? "#10b981" : readiness.score >= 70 ? "#f59e0b" : readiness.score >= 50 ? "#f97316" : "#ef4444"}
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 18}
                        strokeDashoffset={2 * Math.PI * 18 - (readiness.score / 100) * 2 * Math.PI * 18}
                        style={{ transition: "stroke-dashoffset 0.6s ease" }}
                      />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-black text-white">{readiness.score}</span>
                  </div>
                  <div>
                    <p className={`text-xs font-bold ${readiness.score >= 90 ? "text-emerald-400" : readiness.score >= 70 ? "text-amber-400" : "text-red-400"}`}>{getReadinessLabel(readiness.score)}</p>
                    <p className="text-[11px] text-gray-400">{readiness.canTransact ? "Siap transaksi" : `${readiness.missingCritical.length} kritis belum siap`}</p>
                  </div>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${readiness.canTransact ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/15 text-amber-400 border border-amber-500/30"}`}>
                  {readiness.canTransact ? "GO" : "SOFT"}
                </span>
              </div>
              {!readiness.canTransact && readiness.missingCritical.length > 0 && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
                  Perlu: {readiness.missingCritical.join(" · ")}
                </p>
              )}
              {readiness.missingWarning.length > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  Saran: {readiness.missingWarning.slice(0, 3).join(" · ")}
                </p>
              )}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${readiness.score}%`, background: readiness.score >= 90 ? "#10b981" : readiness.score >= 70 ? "#f59e0b" : "#ef4444" }} />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto flex flex-col min-h-0 custom-scrollbar">
            {activeTab === "tema" && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="border-b border-gray-800 bg-gray-950/30 p-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <Palette size={16} className="text-amber-400" />
                    <div>
                      <p className="text-xs font-bold text-white">Tema Visual</p>
                      <p className="text-[10px] text-gray-400">Presets, Colors, Typography</p>
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto space-y-4 p-3">
                  <ThemePresetSelector />
                  <GlobalColorsPanel />
                  <GlobalTypographyPanel />
                </div>
              </div>
            )}

            {["header", "beranda", "katalog", "konten", "footer"].includes(activeTab) && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="border-b border-gray-800 bg-gray-950/30 p-3 shrink-0">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const tab = TAB_CONFIG.find((t) => t.id === activeTab);
                      return tab ? <tab.icon size={16} className="text-amber-400" /> : null;
                    })()}
                    <div>
                      <p className="text-xs font-bold text-white">{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Sections</p>
                      <p className="text-[10px] text-gray-400">
                        {getFilteredSections().length} section{getFilteredSections().length !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex-1 flex flex-col min-h-0">
                  {selectedSectionId ? (
                    <div className="flex flex-col h-full">
                      <div className="p-3 border-b border-gray-800 bg-gray-950/30 flex items-center justify-between shrink-0">
                        <button
                          onClick={() => selectSection(null)}
                          className="flex items-center gap-1 text-xs font-semibold text-amber-400 hover:text-amber-300 transition-colors"
                        >
                          <ChevronLeft size={16} />
                          <span>Kembali</span>
                        </button>
                        <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                          Editing
                        </span>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <SectionSettings />
                      </div>
                    </div>
                  ) : (
                    <SectionList
                      onAddSection={() => setShowAddDialog(true)}
                      filterTypes={isSectionArea(activeTab)
                        ? getSectionsForArea(activeTab).map((section) => section.type)
                        : []}
                    />
                  )}
                </div>
              </div>
            )}

            {activeTab === "pengaturan" && (
              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                <div className="border-b border-gray-800 bg-gray-950/30 p-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <Settings size={16} className="text-amber-400" />
                    <div>
                      <p className="text-xs font-bold text-white">Pengaturan Global</p>
                      <p className="text-[10px] text-gray-400">Animations, SEO, Integrations</p>
                    </div>
                  </div>
                </div>
                <GlobalAnimationsPanel />
                <GlobalSettingsPanel />
              </div>
            )}
          </div>

          <div className="hidden shrink-0 items-center justify-between border-t border-gray-800 bg-gray-950/50 p-3 text-[11px] text-gray-500 sm:flex">
            <span>Roastery Operating System</span>
            <span className="font-mono text-xs">v2.4 Block Engine</span>
          </div>
        </aside>

        <main className={`${mobilePane === "preview" ? "flex" : "hidden"} relative min-w-0 flex-1 flex-col overflow-hidden bg-gray-950 lg:flex`}>
          <InlinePreview products={products} offerings={offerings} subdomain={subdomain} />
        </main>
      </div>

      <AddSectionDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        area={isSectionArea(activeTab) ? activeTab : undefined}
      />
    </div>
  );
}
