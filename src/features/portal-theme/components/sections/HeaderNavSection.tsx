"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShoppingBag, Menu, X, Coffee, Activity } from "lucide-react";
import { useModalFocus } from "@/hooks/useModalFocus";

interface HeaderNavProps {
  settings: Record<string, unknown>;
  onOpenCart?: () => void;
  cartItemCount?: number;
  isPreview?: boolean;
  sectionId?: string;
}

type NavLink = { label: string; href: string };

// Fallback hanya bila tenant belum mengatur navLinks. Hanya memuat anchor
// yang benar-benar dirender halaman (#catalog & #faq punya canonical anchors
// di PortalThemeRenderer) — tautan mati seperti "#about" tidak dipakai lagi.
const FALLBACK_NAV_LINKS: NavLink[] = [
  { label: "Koleksi", href: "#catalog" },
  { label: "FAQ", href: "#faq" },
];

function readConfiguredNavLinks(settings: Record<string, unknown>): NavLink[] {
  const raw = settings.navLinks;
  return Array.isArray(raw) ? (raw as NavLink[]) : FALLBACK_NAV_LINKS;
}

export function HeaderNavSection({ settings, onOpenCart, cartItemCount = 0, isPreview = false, sectionId }: HeaderNavProps) {
  const styleMode = (settings.styleMode as string) || "glass_pill";
  const logoText = (settings.logoText as string) || "Nama Toko";
  const tickerText = typeof settings.tickerText === "string" ? settings.tickerText : "";
  const ctaText = (settings.ctaText as string) || "Keranjang";
  
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);
  const mobileMenuRef = useModalFocus(mobileMenuOpen, closeMobileMenu);
  const mobileMenuId = `${sectionId || "portal"}-mobile-menu`;

  useEffect(() => {
    if (isPreview) return;
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isPreview]);

  const configuredNavLinks = readConfiguredNavLinks(settings);

  const [navLinks, setNavLinks] = useState<NavLink[]>(configuredNavLinks);

  useEffect(() => {
    // Re-filter setiap kali customizer mengubah navLinks, dan setelah paint
    // agar section yang ter-hydride belakangan tetap ditemukan. Tanpa ini
    // navigasi bisa membeku dengan daftar lama atau menaut ke anchor yang
    // tidak ada.
    const raf = requestAnimationFrame(() => {
      setNavLinks(configuredNavLinks.filter((link) => {
        if (!link || typeof link.href !== "string") return false;
        try {
          return !!(document.querySelector(link.href) || document.getElementById(link.href.replace("#", "")));
        } catch {
          // Selector tidak valid untuk querySelector — coba id polos saja.
          try {
            return !!document.getElementById(link.href.replace("#", ""));
          } catch {
            return false;
          }
        }
      }));
    });
    return () => cancelAnimationFrame(raf);
  }, [configuredNavLinks]);

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    setMobileMenuOpen(false);
    if (isPreview) return;
    const el = document.querySelector(href) || document.getElementById(href.replace("#", ""));
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  // ── 1. GLASS PILL (Floating Luxury Capsule) ──────────────────────────────────
  if (styleMode === "glass_pill") {
    return (
      <header className="sticky top-3 sm:top-5 z-50 px-3 sm:px-6 transition-all duration-300 pointer-events-none">
        <div className={`max-w-5xl mx-auto rounded-full transition-all duration-500 pointer-events-auto border px-4 sm:px-7 py-3 flex items-center justify-between shadow-2xl ${
          scrolled || isPreview 
            ? "bg-slate-950/85 backdrop-blur-2xl border-white/20 shadow-[0_10px_40px_rgba(0,0,0,0.5)]" 
            : "bg-slate-950/60 backdrop-blur-md border-white/10"
        }`}>
          {/* Brand Logo */}
          <a href="#" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--portal-accent,#D4A574)] to-amber-700 flex items-center justify-center text-black font-black text-xs shadow-md group-hover:scale-105 transition-transform">
              <Coffee size={16} className="stroke-[2.5]" />
            </div>
            <span className="font-black text-sm sm:text-base tracking-tight text-white font-mono">
              {logoText}
            </span>
          </a>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1 sm:gap-2">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider text-white/70 hover:text-white hover:bg-white/10 transition-all"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={onOpenCart}
              className="relative flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--portal-accent,#D4A574)] text-black font-extrabold text-xs tracking-wider uppercase hover:scale-105 active:scale-95 transition-all shadow-lg"
            >
              <ShoppingBag size={14} className="stroke-[2.5]" />
              <span className="hidden sm:inline">{ctaText}</span>
              {cartItemCount > 0 && (
                <span className="w-5 h-5 rounded-full bg-black text-white text-xs font-black flex items-center justify-center -mr-1">
                  {cartItemCount}
                </span>
              )}
            </button>

            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden w-9 h-9 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              aria-label="Buka menu"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
            >
              <Menu size={18} />
            </button>
          </div>
        </div>

        {/* Mobile Slide-Out Drawer */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <div className="fixed inset-0 z-50 pointer-events-auto md:hidden flex justify-end">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMobileMenuOpen(false)}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              />
              <motion.div
                ref={mobileMenuRef}
                id={mobileMenuId}
                role="dialog"
                aria-modal="true"
                aria-label={`Menu ${logoText}`}
                tabIndex={-1}
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 300 }}
                className="relative w-4/5 max-w-sm h-full bg-slate-950 border-l border-white/15 p-6 flex flex-col justify-between shadow-2xl overflow-y-auto"
              >
                <div>
                  <div className="flex items-center justify-between pb-6 border-b border-white/10">
                    <span className="font-black text-lg tracking-tight text-white font-mono">{logoText}</span>
                    <button onClick={closeMobileMenu} aria-label="Tutup menu" className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:text-white">
                      <X size={18} />
                    </button>
                  </div>
                  <div className="py-8 space-y-4">
                    {navLinks.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        onClick={(e) => handleNavClick(e, link.href)}
                        className="block text-xl font-black text-white/80 hover:text-[var(--portal-accent,#D4A574)] transition-colors py-2 border-b border-white/5"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                </div>
                <div className="space-y-4 pt-6 border-t border-white/10">
                  <button
                    onClick={() => { setMobileMenuOpen(false); if (onOpenCart) onOpenCart(); }}
                    className="w-full py-3.5 rounded-2xl bg-[var(--portal-accent,#D4A574)] text-black font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 shadow-xl"
                  >
                    <ShoppingBag size={18} />
                    <span>Lihat Keranjang ({cartItemCount})</span>
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </header>
    );
  }

  // ── 2. INDUSTRIAL TICKER (Brutalist Bar) ─────────────────────────────────────
  if (styleMode === "industrial_ticker") {
    return (
      <header className="sticky top-0 z-50 bg-black text-white border-b-2 border-white/30 transition-all shadow-xl font-mono">
        {/* Top Ticker */}
        {tickerText && (
          <div className="bg-[var(--portal-accent,#D4A574)] text-black text-[11px] font-black tracking-widest uppercase py-1.5 px-4 overflow-hidden border-b border-black">
            <div className="animate-pulse text-center line-clamp-1">
              ⚡ {tickerText} ⚡
            </div>
          </div>
        )}
        
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between">
          <a href="#" className="text-lg sm:text-2xl font-black tracking-tighter uppercase bg-white text-black px-3 py-1 hover:bg-[var(--portal-accent,#D4A574)] transition-colors">
            {logoText}
          </a>

          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="text-xs font-bold uppercase tracking-widest hover:text-[var(--portal-accent,#D4A574)] transition-colors py-1 border-b-2 border-transparent hover:border-[var(--portal-accent,#D4A574)]"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={onOpenCart}
              className="px-4 py-2 border-2 border-white bg-transparent hover:bg-white hover:text-black font-black text-xs uppercase tracking-wider transition-all flex items-center gap-2"
            >
              <ShoppingBag size={14} />
              <span>{ctaText} ({cartItemCount})</span>
            </button>
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Buka menu"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
              className="md:hidden p-2 border-2 border-white bg-transparent hover:bg-white hover:text-black transition-colors"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>

        {/* Brutalist Mobile Menu */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <div ref={mobileMenuRef} id={mobileMenuId} role="dialog" aria-modal="true" aria-label={`Menu ${logoText}`} tabIndex={-1} className="fixed inset-0 z-50 bg-black text-white p-6 flex flex-col justify-between font-mono md:hidden">
              <div>
                <div className="flex items-center justify-between pb-6 border-b-2 border-white">
                  <span className="text-xl font-black uppercase bg-white text-black px-3 py-1">{logoText}</span>
                  <button onClick={closeMobileMenu} aria-label="Tutup menu" className="p-2 border-2 border-white hover:bg-white hover:text-black">
                    <X size={20} />
                  </button>
                </div>
                <div className="py-8 space-y-6">
                  {navLinks.map((link, i) => (
                    <a
                      key={link.label}
                      href={link.href}
                      onClick={(e) => handleNavClick(e, link.href)}
                      className="block text-2xl font-black uppercase tracking-wider hover:text-[var(--portal-accent,#D4A574)]"
                    >
                      0{i+1}. // {link.label}
                    </a>
                  ))}
                </div>
              </div>
              <button
                onClick={() => { setMobileMenuOpen(false); if (onOpenCart) onOpenCart(); }}
                className="w-full py-4 bg-[var(--portal-accent,#D4A574)] text-black font-black text-base uppercase tracking-widest border-2 border-black shadow-lg flex items-center justify-center gap-2"
              >
                <ShoppingBag size={20} />
                <span>BUKA KERANJANG GROSIR ({cartItemCount})</span>
              </button>
            </div>
          )}
        </AnimatePresence>
      </header>
    );
  }

  // ── 3. LUXURY EDITORIAL (Boutique Serif & Gold Foil) ─────────────────────────
  if (styleMode === "luxury_editorial") {
    return (
      <header className="sticky top-0 z-50 bg-[#14110F]/95 backdrop-blur-xl border-b border-[var(--portal-accent,#D4A574)]/30 text-[#F5F0EB] transition-all shadow-2xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between">
          
          {/* Left Nav */}
          <nav className="hidden md:flex items-center gap-6 flex-1">
            {navLinks.slice(0, 2).map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="text-xs uppercase tracking-[0.25em] font-medium text-[#F5F0EB]/70 hover:text-[var(--portal-accent,#D4A574)] transition-colors"
                style={{ fontFamily: "Georgia, serif" }}
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Centered Brand */}
          <a href="#" className="text-xl sm:text-3xl font-bold tracking-wider text-center text-[var(--portal-accent,#D4A574)] px-4" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
            {logoText}
          </a>

          {/* Right Nav + Cart */}
          <div className="flex items-center justify-end gap-6 flex-1">
            <nav className="hidden md:flex items-center gap-6">
              {navLinks.slice(2).map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={(e) => handleNavClick(e, link.href)}
                  className="text-xs uppercase tracking-[0.25em] font-medium text-[#F5F0EB]/70 hover:text-[var(--portal-accent,#D4A574)] transition-colors"
                  style={{ fontFamily: "Georgia, serif" }}
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <button
              onClick={onOpenCart}
              className="flex items-center gap-2 px-4 py-2 rounded-none border border-[var(--portal-accent,#D4A574)]/50 bg-[var(--portal-accent,#D4A574)]/10 hover:bg-[var(--portal-accent,#D4A574)] hover:text-black transition-all text-xs uppercase tracking-widest font-semibold text-[var(--portal-accent,#D4A574)]"
            >
              <ShoppingBag size={14} />
              <span className="hidden sm:inline">Keranjang ({cartItemCount})</span>
              <span className="sm:hidden">({cartItemCount})</span>
            </button>

            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Buka menu"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
              className="md:hidden text-[var(--portal-accent,#D4A574)] p-1 hover:opacity-80"
            >
              <Menu size={22} />
            </button>
          </div>
        </div>

        {/* Editorial Mobile Menu */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <div ref={mobileMenuRef} id={mobileMenuId} role="dialog" aria-modal="true" aria-label={`Menu ${logoText}`} tabIndex={-1} className="fixed inset-0 z-50 bg-[#14110F] text-[#F5F0EB] p-8 flex flex-col justify-between md:hidden border-l border-[var(--portal-accent,#D4A574)]/30">
              <div>
                <div className="flex items-center justify-between pb-6 border-b border-[var(--portal-accent,#D4A574)]/20">
                  <span className="text-2xl font-bold text-[var(--portal-accent,#D4A574)]" style={{ fontFamily: "Georgia, serif" }}>{logoText}</span>
                  <button onClick={closeMobileMenu} aria-label="Tutup menu" className="text-[#F5F0EB]/70 hover:text-white">
                    <X size={24} />
                  </button>
                </div>
                <div className="py-10 space-y-6">
                  {navLinks.map((link) => (
                    <a
                      key={link.label}
                      href={link.href}
                      onClick={(e) => handleNavClick(e, link.href)}
                      className="block text-2xl tracking-[0.2em] uppercase text-[#F5F0EB]/90 hover:text-[var(--portal-accent,#D4A574)]"
                      style={{ fontFamily: "Georgia, serif" }}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
              <button
                onClick={() => { setMobileMenuOpen(false); if (onOpenCart) onOpenCart(); }}
                className="w-full py-4 bg-[var(--portal-accent,#D4A574)] text-black font-bold uppercase tracking-[0.2em] text-sm shadow-xl flex items-center justify-center gap-3"
              >
                <ShoppingBag size={18} />
                <span>Lihat Keranjang ({cartItemCount})</span>
              </button>
            </div>
          )}
        </AnimatePresence>
      </header>
    );
  }

  // ── 4. CYBER DOCK (OLED Telemetry Bar) ───────────────────────────────────────
  if (styleMode === "cyber_dock") {
    return (
      <header className="sticky top-0 z-50 bg-[#05070D]/95 backdrop-blur-2xl border-b border-[#00FF66]/30 text-[#00FF66] font-mono shadow-[0_4px_30px_rgba(0,255,102,0.15)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3 flex items-center justify-between text-xs">
          {/* Brand + Telemetry Status */}
          <div className="flex items-center gap-4">
            <a href="#" className="text-sm sm:text-base font-black tracking-wider uppercase text-white flex items-center gap-2 hover:text-[#00FF66] transition-colors">
              <Activity size={16} className="text-[#00FF66] animate-pulse" />
              <span>{logoText}</span>
            </a>
            <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded bg-[#00FF66]/10 border border-[#00FF66]/30 text-xs text-[#00FF66]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00FF66] animate-ping" />
              <span>NAVIGATION // ACTIVE</span>
            </div>
          </div>

          {/* Cyber Nav */}
          <nav className="hidden md:flex items-center gap-6">
            {navLinks.map((link, idx) => (
              <a
                key={link.label}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="text-[11px] font-bold uppercase tracking-widest text-white/70 hover:text-[#00FF66] transition-colors flex items-center gap-1.5"
              >
                <span className="text-[#00FF66]/50">0{idx+1}</span>
                <span>{link.label}</span>
              </a>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={onOpenCart}
              className="px-3.5 py-1.5 rounded bg-[#00FF66] text-black font-black text-[11px] uppercase tracking-wider hover:bg-white transition-colors flex items-center gap-2 shadow-[0_0_15px_rgba(0,255,102,0.4)]"
            >
              <ShoppingBag size={14} />
              <span>CART [{cartItemCount}]</span>
            </button>
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Buka menu"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
              className="md:hidden p-1.5 border border-[#00FF66]/40 text-[#00FF66] hover:bg-[#00FF66]/10 rounded"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>

        {/* Cyber Mobile Drawer */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <div ref={mobileMenuRef} id={mobileMenuId} role="dialog" aria-modal="true" aria-label={`Menu ${logoText}`} tabIndex={-1} className="fixed inset-0 z-50 bg-[#05070D] text-[#00FF66] p-6 flex flex-col justify-between font-mono md:hidden border-l border-[#00FF66]/30">
              <div>
                <div className="flex items-center justify-between pb-6 border-b border-[#00FF66]/20">
                  <span className="text-lg font-black uppercase text-white flex items-center gap-2">
                    <Activity size={18} className="text-[#00FF66] animate-pulse" />
                    {logoText}
                  </span>
                  <button onClick={closeMobileMenu} aria-label="Tutup menu" className="text-[#00FF66] p-1">
                    <X size={20} />
                  </button>
                </div>
                <div className="py-8 space-y-5">
                  <div className="px-3 py-2 rounded bg-[#00FF66]/10 border border-[#00FF66]/30 text-xs mb-6">
                    NAVIGATION INDEX
                  </div>
                  {navLinks.map((link, idx) => (
                    <a
                      key={link.label}
                      href={link.href}
                      onClick={(e) => handleNavClick(e, link.href)}
                      className="block text-lg font-black uppercase text-white/90 hover:text-[#00FF66]"
                    >
                      [0{idx+1}] {link.label}
                    </a>
                  ))}
                </div>
              </div>
              <button
                onClick={() => { setMobileMenuOpen(false); if (onOpenCart) onOpenCart(); }}
                className="w-full py-3.5 rounded bg-[#00FF66] text-black font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,255,102,0.6)]"
              >
                <ShoppingBag size={18} />
                <span>BUKA KERANJANG [{cartItemCount}]</span>
              </button>
            </div>
          )}
        </AnimatePresence>
      </header>
    );
  }

  // ── 5. SCANDI MINIMAL (Nordic Clean Botanical) ───────────────────────────────
  return (
    <header className="sticky top-0 z-50 bg-[#F5F3EF]/95 backdrop-blur-lg border-b border-[#E2DFD7] text-[#2C302E] font-sans transition-all shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between">
        <a href="#" className="text-lg sm:text-xl font-bold tracking-tight text-[#2C302E] font-serif">
          {logoText}
        </a>

        <nav className="hidden md:flex items-center gap-8">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              onClick={(e) => handleNavClick(e, link.href)}
              className="text-xs uppercase tracking-widest font-semibold text-[#5A605D] hover:text-[#1F2421] transition-colors py-1 relative group"
            >
              <span>{link.label}</span>
              <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-[#52796F] transition-all duration-300 group-hover:w-full" />
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <button
            onClick={onOpenCart}
            className="px-4 py-2 rounded-full bg-[#2C302E] text-[#F5F3EF] font-bold text-xs uppercase tracking-wider hover:bg-[#52796F] transition-all flex items-center gap-2 shadow-sm"
          >
            <ShoppingBag size={14} />
            <span>Cart ({cartItemCount})</span>
          </button>
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Buka menu"
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuId}
            className="md:hidden p-2 rounded-full hover:bg-black/5 text-[#2C302E]"
          >
            <Menu size={20} />
          </button>
        </div>
      </div>

      {/* Scandi Mobile Menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <div ref={mobileMenuRef} id={mobileMenuId} role="dialog" aria-modal="true" aria-label={`Menu ${logoText}`} tabIndex={-1} className="fixed inset-0 z-50 bg-[#F5F3EF] text-[#2C302E] p-8 flex flex-col justify-between md:hidden border-l border-[#E2DFD7]">
            <div>
              <div className="flex items-center justify-between pb-6 border-b border-[#E2DFD7]">
                <span className="text-xl font-bold font-serif">{logoText}</span>
                <button onClick={closeMobileMenu} aria-label="Tutup menu" className="p-2 hover:bg-black/5 rounded-full">
                  <X size={20} />
                </button>
              </div>
              <div className="py-10 space-y-6">
                {navLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    onClick={(e) => handleNavClick(e, link.href)}
                    className="block text-2xl font-semibold text-[#2C302E]/90 hover:text-[#52796F]"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
            <button
              onClick={() => { setMobileMenuOpen(false); if (onOpenCart) onOpenCart(); }}
              className="w-full py-4 rounded-full bg-[#2C302E] text-[#F5F3EF] font-bold text-sm uppercase tracking-wider shadow-lg flex items-center justify-center gap-2"
            >
              <ShoppingBag size={18} />
              <span>Lihat Keranjang ({cartItemCount})</span>
            </button>
          </div>
        )}
      </AnimatePresence>
    </header>
  );
}
