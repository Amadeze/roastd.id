"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Coffee,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  APP_NAV_SECTIONS,
  Sidebar,
  canAccessNavigation,
  getActiveNavigation,
  type AppNavLink,
} from "@/components/layout/Sidebar";
import { EntityPanelProvider, useEntityPanel } from "@/components/layout/entity-panel";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { logoutAction } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import type { PlanTier } from "@/lib/plans";

const ALL_NAV_ITEMS = APP_NAV_SECTIONS.flatMap((section) => section.items);
const MOBILE_PRIMARY_HREFS = ["/dashboard", "/inventory", "/kasir", "/roasting"];

// â”€â”€ Rail (ikon selalu bersama teks) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Rail({
  userRole,
  subscriptionTier,
}: {
  userRole: string;
  subscriptionTier: PlanTier;
}) {
  const pathname = usePathname();
  const visibleItems = ALL_NAV_ITEMS.filter((item) =>
    canAccessNavigation(item.href, userRole, subscriptionTier),
  );
  const activeItem = getActiveNavigation(pathname, visibleItems);

  return (
    <nav
      aria-label="Navigasi tahap"
      className="custom-scrollbar flex w-16 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-white/[0.06] bg-obsidian py-3"
    >
      <Link
        href="/dashboard"
        aria-label="Ke Hari ini"
        className="mb-2 flex size-9 items-center justify-center rounded-[10px] bg-[var(--stage-roasting)] text-white shadow-[0_0_24px_rgba(166,71,40,.35)]"
      >
        <Coffee size={17} />
      </Link>

      {visibleItems.map((item) => {
        const Icon = item.icon;
        const active = activeItem?.href === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={item.label}
            className={cn(
              "relative flex w-full flex-col items-center gap-0.5 rounded-lg py-1.5 transition-colors",
              active ? "text-[var(--stage-system-soft)]" : "text-white/45 hover:text-white/85",
            )}
          >
            {active ? (
              <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-r bg-[var(--stage-roasting)]" />
            ) : null}
            <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
            <span className="max-w-full truncate px-0.5 text-[8.5px] font-semibold leading-none">
              {item.shortLabel}
            </span>
          </Link>
        );
      })}

      <div className="mt-auto flex w-full flex-col items-center gap-1 pt-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          aria-label="Cari halaman (Ctrl K)"
          className="flex w-full flex-col items-center gap-0.5 rounded-lg py-1.5 text-white/45 transition-colors hover:text-white/85"
        >
          <Search size={16} />
          <span className="text-[8.5px] font-semibold leading-none">Cari</span>
        </button>
        <form action={logoutAction} className="w-full">
          <button
            type="submit"
            aria-label="Keluar dari workspace"
            title="Keluar"
            className="mx-auto flex w-full flex-col items-center gap-0.5 rounded-lg py-1.5 text-white/35 transition-colors hover:bg-[var(--stage-roasting)]/10 hover:text-[var(--stage-system-soft)]"
          >
            <LogOut size={15} />
            <span className="text-[8.5px] font-semibold leading-none">Keluar</span>
          </button>
        </form>
      </div>
    </nav>
  );
}

// â”€â”€ Panel konteks (kanan, xl ke atas) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Isi panel saat sebuah entri dipilih (Rantai Jejak, detail ringkas, dll). */
function PanelEntityBody() {
  const { entity, clear } = useEntityPanel();
  if (!entity) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <button
        type="button"
        onClick={clear}
        className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold text-ink-tertiary transition-colors hover:bg-surface-sunken hover:text-foreground"
      >
        â† Ringkasan
      </button>
      <div className="min-w-0">
        {entity.eyebrow ? (
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-copper">
            {entity.eyebrow}
          </p>
        ) : null}
        <p className="mt-0.5 truncate font-mono text-sm font-bold text-foreground">{entity.title}</p>
      </div>
      <div className="custom-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">{entity.content}</div>
    </div>
  );
}

function ContextPanel({
  userRole,
  subscriptionTier,
  onClose,
}: {
  userRole: string;
  subscriptionTier: PlanTier;
  onClose: () => void;
}) {
  const { entity } = useEntityPanel();

  return (
    <aside
      aria-label="Panel konteks"
      className="hidden w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/70 bg-surface p-4 custom-scrollbar xl:flex"
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-[9px] font-bold uppercase tracking-[0.24em] text-copper">
          roastd.id
        </p>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-emerald-800">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          aktif
        </span>
      </div>

      {entity ? (
        <PanelEntityBody />
      ) : (
        <>
      <div className="rounded-card border border-border bg-card p-4 shadow-elevation-soft">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-tertiary">Workspace</p>
        <p className="mt-1 text-sm font-semibold capitalize text-foreground">{userRole.toLowerCase()}</p>
        <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-tertiary">
          {subscriptionTier}
        </p>
      </div>

      <Link
        href="/ai-insights"
        className="group rounded-card border border-primary/25 bg-gradient-to-br from-card to-[color-mix(in_srgb,var(--copper)_6%,transparent)] p-4 transition-colors hover:border-primary/50"
      >
        <p className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-copper">
          <Sparkles size={11} /> Tanya Roastd
        </p>
        <p className="mt-1.5 text-xs leading-5 text-ink-secondary">
          Tanya apa saja tentang data roastery Anda.
        </p>
      </Link>
        </>
      )}

      <button
        type="button"
        onClick={onClose}
        className="mx-auto mt-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-tertiary transition-colors hover:text-foreground"
      >
        <ChevronRight size={13} /> Sembunyikan panel
      </button>
    </aside>
  );
}

// â”€â”€ MobileDock (port dari shell lama) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MOBILE_TONES: Record<AppNavLink["tone"], Record<string, string>> = {
  system: { text: "dock-system-text", line: "dock-system-line", activeIcon: "dock-system-activeicon", prominent: "dock-system-prominent", inactiveIcon: "dock-system-inactive" },
  inventory: { text: "dock-inventory-text", line: "dock-inventory-line", activeIcon: "dock-inventory-activeicon", prominent: "dock-inventory-prominent", inactiveIcon: "dock-inventory-inactive" },
  warehouse: { text: "dock-warehouse-text", line: "dock-warehouse-line", activeIcon: "dock-warehouse-activeicon", prominent: "dock-warehouse-prominent", inactiveIcon: "dock-warehouse-inactive" },
  roasting: { text: "dock-roasting-text", line: "dock-roasting-line", activeIcon: "dock-roasting-activeicon", prominent: "dock-roasting-prominent", inactiveIcon: "dock-roasting-inactive" },
  production: { text: "dock-production-text", line: "dock-production-line", activeIcon: "dock-production-activeicon", prominent: "dock-production-prominent", inactiveIcon: "dock-production-inactive" },
  sales: { text: "dock-sales-text", line: "dock-sales-line", activeIcon: "dock-sales-activeicon", prominent: "dock-sales-prominent", inactiveIcon: "dock-sales-inactive" },
  finance: { text: "dock-finance-text", line: "dock-finance-line", activeIcon: "dock-finance-activeicon", prominent: "dock-finance-prominent", inactiveIcon: "dock-finance-inactive" },
  neutral: { text: "dock-neutral-text", line: "dock-neutral-line", activeIcon: "dock-neutral-activeicon", prominent: "dock-neutral-prominent", inactiveIcon: "dock-neutral-inactive" },
};

function MobileDock({
  items,
  activeItem,
  moreActive,
  onOpenMore,
  pendingPaymentReviews,
}: {
  items: AppNavLink[];
  activeItem?: AppNavLink;
  moreActive: boolean;
  onOpenMore: () => void;
  pendingPaymentReviews: number;
}) {
  return (
    <nav
      className="grid h-[60px] shrink-0 border-t border-white/10 bg-obsidian px-1 pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(5,9,13,.18)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
      aria-label="Navigasi utama mobile"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = activeItem?.href === item.href;
        const prominent = item.href === "/kasir";
        const tone = MOBILE_TONES[item.tone];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-w-0 flex-col items-center justify-center gap-0.5 text-[8px] font-semibold transition",
              active ? tone.text : "text-white/45",
              prominent && "-mt-1.5",
            )}
          >
            {active ? <span className={cn("absolute top-0 h-[2px] w-9", tone.line)} /> : null}
            {prominent ? (
              <span
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-[10px] border-[2px] border-obsidian shadow-[0_6px_18px_rgba(0,0,0,.4)]",
                  active ? tone.prominent : `border-white/10 bg-[var(--chrome-accent)] ${tone.inactiveIcon}`,
                )}
              >
                <Icon size={16} strokeWidth={2.2} />
              </span>
            ) : (
              <span
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-[8px] border transition-colors",
                  active ? tone.activeIcon : "border-transparent text-white/40",
                )}
              >
                <Icon size={14} strokeWidth={active ? 2.2 : 1.7} />
              </span>
            )}
            <span className="max-w-full truncate px-1">{item.shortLabel}</span>
            {item.href === "/penjualan" && pendingPaymentReviews > 0 ? (
              <span className="absolute right-[20%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[8px] font-black text-white">
                {Math.min(pendingPaymentReviews, 99)}
              </span>
            ) : null}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        className={cn(
          "relative flex min-w-0 flex-col items-center justify-center gap-0.5 text-[8px] font-semibold transition",
          moreActive ? "text-[var(--chrome-instrument-soft)]" : "text-white/45",
        )}
        aria-label="Buka semua menu"
      >
        {moreActive ? (
          <span className="absolute top-0 h-[2px] w-8 bg-[var(--instrument)]" />
        ) : null}
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-[8px] border",
            moreActive ? "border-[var(--instrument)]/45 bg-[var(--instrument)]/15 text-[var(--instrument)]" : "border-transparent text-white/40",
          )}
        >
          <MoreHorizontal size={14} />
        </span>
        <span>Lainnya</span>
      </button>
    </nav>
  );
}

// â”€â”€ Shell utama â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function AppShellV2({
  children,
  userRole,
  subscriptionTier,
  pendingPaymentReviews,
  lowStockCount = 0,
  unfulfilledOrders = 0,
}: {
  children: React.ReactNode;
  userRole: string;
  subscriptionTier: PlanTier;
  pendingPaymentReviews: number;
  lowStockCount?: number;
  unfulfilledOrders?: number;
}) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const pathname = usePathname();

  useEffect(() => setIsMobileMenuOpen(false), [pathname]);
  useEffect(() => {
    const saved = window.localStorage.getItem("ros-context-panel");
    if (saved === "closed") setPanelOpen(false);
  }, []);
  const togglePanel = () => {
    setPanelOpen((v) => {
      window.localStorage.setItem("ros-context-panel", v ? "closed" : "open");
      return !v;
    });
  };

  const visibleItems = ALL_NAV_ITEMS.filter((item) =>
    canAccessNavigation(item.href, userRole, subscriptionTier),
  );
  const activeItem = getActiveNavigation(pathname, visibleItems);
  const activeSection =
    APP_NAV_SECTIONS.find((s) => s.items.some((i) => i.href === activeItem?.href)) ?? null;

  const primaryHrefs =
    userRole === "CASHIER"
      ? ["/dashboard", "/kasir", "/penjualan", "/inventory"]
      : userRole === "OPERATOR"
        ? ["/dashboard", "/inventory", "/roasting", "/produksi"]
        : userRole === "FINANCE"
          ? ["/dashboard", "/keuangan", "/laporan/keuangan", "/inventory"]
          : ["/dashboard", "/inventory", "/kasir", "/roasting"];
  const mobileItems = primaryHrefs
    .map((href) => visibleItems.find((item) => item.href === href))
    .filter((item): item is AppNavLink => Boolean(item));
  const mobileDockItems = mobileItems.slice(0, 4);
  const moreActive = Boolean(activeItem && !mobileDockItems.some((i) => i.href === activeItem.href));

  return (
    <EntityPanelProvider>
    <div className="ros-workspace flex h-[100dvh] w-full overflow-hidden bg-obsidian">
      {isMobileMenuOpen ? (
        <button
          type="button"
          aria-label="Tutup menu"
          className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      ) : null}

      {/* Drawer menu mobile */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] md:hidden",
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-[110%]",
        )}
      >
        <div className="relative h-full shadow-[24px_0_80px_rgba(0,0,0,.34)]">
          <Sidebar
            userRole={userRole}
            subscriptionTier={subscriptionTier}
            pendingPaymentReviews={pendingPaymentReviews}
            lowStockCount={lowStockCount}
            unfulfilledOrders={unfulfilledOrders}
            forceExpanded
          />
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(false)}
            className="absolute right-3 top-5 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/55 transition hover:text-white"
            aria-label="Tutup menu"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Rail desktop */}
      <div className="hidden md:flex">
        <Rail userRole={userRole} subscriptionTier={subscriptionTier} />
      </div>

      {/* Kolom utama */}
      <main id="main-dashboard-content" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <a
          href="#main-dashboard-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-14 focus:left-4 focus:z-50 focus:rounded-md focus:bg-[var(--primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--primary-foreground)] focus:shadow-lg"
        >
          Lewati ke konten utama
        </a>
        {/* Strip atas tipis */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-surface/80 px-4 backdrop-blur-sm sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(true)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-ink-secondary md:hidden"
              aria-label="Buka menu"
            >
              <Menu size={15} />
            </button>
            <p className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-ink-tertiary">
              {activeSection ? `${activeSection.label} / ${activeItem?.label ?? ""}` : "roastd.id"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium text-ink-tertiary transition-colors hover:border-primary/40 hover:text-foreground"
              aria-label="Cari halaman (Ctrl K)"
            >
              <Search size={12} />
              <span className="hidden sm:inline">Cariâ€¦</span>
              <kbd className="rounded border border-border px-1 font-mono text-[9px]">âŒ˜K</kbd>
            </button>
            <button
              type="button"
              onClick={togglePanel}
              aria-label={panelOpen ? "Sembunyikan panel konteks" : "Tampilkan panel konteks"}
              className="hidden h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-ink-tertiary transition-colors hover:text-foreground xl:flex"
            >
              {panelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </header>

        <div className="dashboard-canvas custom-scrollbar relative z-0 min-h-0 flex-1 overflow-y-auto">
          <Breadcrumbs />
          <div className="flex h-full w-full flex-col">{children}</div>
        </div>

        <MobileDock
          items={mobileDockItems}
          activeItem={activeItem}
          moreActive={moreActive}
          onOpenMore={() => setIsMobileMenuOpen(true)}
          pendingPaymentReviews={pendingPaymentReviews}
        />
      </main>

      {/* Panel konteks */}
      {panelOpen ? (
        <>
          <ContextPanel userRole={userRole} subscriptionTier={subscriptionTier} onClose={togglePanel} />
          <button
            type="button"
            onClick={togglePanel}
            aria-label="Tampilkan panel konteks"
            className="absolute right-3 top-16 z-30 hidden h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-ink-tertiary shadow-elevation-soft transition-colors hover:text-foreground xl:hidden"
          >
            <PanelRightOpen size={15} />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={togglePanel}
          aria-label="Tampilkan panel konteks"
          className="absolute right-3 top-16 z-30 hidden h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-ink-tertiary shadow-elevation-soft transition-colors hover:text-foreground xl:flex"
        >
          <ChevronLeft size={15} />
        </button>
      )}

      <CommandPalette userRole={userRole} subscriptionTier={subscriptionTier} />
    </div>
    </EntityPanelProvider>
  );
}
