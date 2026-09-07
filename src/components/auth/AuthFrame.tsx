"use client";

import Link from "next/link";
import { Coffee } from "lucide-react";
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { useHydratedReducedMotion } from "@/lib/use-reduced-motion";

export function AuthFrame({
  eyebrow,
  title,
  description,
  asideTitle,
  asideDescription,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  asideTitle: string;
  asideDescription: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const reduceMotion = useHydratedReducedMotion();
  const ease = [0.22, 1, 0.36, 1] as const;

  return (
    <main className="instrument-grid-dark relative min-h-[100dvh] overflow-hidden bg-[var(--obsidian)] p-3 text-white sm:p-5 lg:p-8">
      <a
        href="#main-auth-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-[var(--primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--primary-foreground)] focus:shadow-lg"
      >
        Lewati ke konten utama
      </a>
      {!reduceMotion ? (
        <motion.div
          data-testid="auth-ambient-scan"
          className="pointer-events-none absolute inset-y-0 w-40 bg-gradient-to-r from-transparent via-[var(--instrument)]/[0.045] to-transparent blur-xl"
          animate={{ x: ["-20vw", "115vw"] }}
          transition={{ duration: 8, repeat: Infinity, repeatDelay: 2, ease: "linear" }}
        />
      ) : null}

      <motion.div
        className="relative mx-auto grid min-h-[calc(100dvh-1.5rem)] max-w-[1180px] overflow-hidden rounded-[20px] border border-white/10 bg-[var(--obsidian-soft)] shadow-[0_32px_120px_rgba(0,0,0,.42)] sm:min-h-[calc(100dvh-2.5rem)] lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,.9fr)_minmax(440px,.65fr)]"
        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.992 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.68, ease }}
      >
        <aside className="relative hidden overflow-hidden border-r border-white/10 p-10 lg:flex lg:flex-col lg:justify-between">
          {!reduceMotion ? (
            <motion.div
              className="pointer-events-none absolute -left-28 top-1/3 size-72 rounded-full bg-[var(--stage-roasting)]/10 blur-[90px]"
              animate={{ y: [-18, 26, -18], scale: [0.96, 1.08, 0.96] }}
              transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : null}

          <div className="relative z-10">
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, x: -16 }}
              animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
              transition={{ duration: 0.58, delay: 0.12, ease }}
            >
              <Link href="/" className="inline-flex items-center gap-3">
                <span className="relative flex size-11 items-center justify-center rounded-[11px] bg-[var(--stage-roasting)] text-white">
                  <Coffee size={19} strokeWidth={2.2} />
                  <span className="absolute -right-1 -top-1 size-2 rounded-full bg-[var(--instrument)]" />
                </span>
                <span>
                  <span className="block text-lg font-black tracking-[-0.04em]">roastd.id</span>
                  <span className="block font-mono text-[8px] uppercase tracking-[0.2em] text-white/35">
                    Roastery operating system
                  </span>
                </span>
              </Link>
            </motion.div>

            <div className="mt-20 max-w-lg">
              <motion.p
                className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-[var(--instrument)]"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.52, delay: 0.2, ease }}
              >
                Material intelligence
              </motion.p>
              <h2 className="mt-4 overflow-hidden text-[clamp(2.25rem,4vw,3.6rem)] font-black leading-[0.95] tracking-[-0.052em]">
                <motion.span
                  className="block"
                  initial={reduceMotion ? false : { y: "108%", rotate: 1 }}
                  animate={reduceMotion ? undefined : { y: 0, rotate: 0 }}
                  transition={{ duration: 0.64, delay: 0.24, ease }}
                >
                  {asideTitle}
                </motion.span>
              </h2>
              <motion.p
                className="mt-6 max-w-md text-[15px] leading-7 text-white/50"
                initial={reduceMotion ? false : { opacity: 0, y: 14 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.58, delay: 0.36, ease }}
              >
                {asideDescription}
              </motion.p>
            </div>
          </div>

          <div className="relative z-10">
            <div className="grid grid-cols-5 gap-1" aria-hidden>
              {["var(--stage-inventory)", "var(--stage-roasting)", "var(--stage-production)", "var(--stage-sales)", "var(--stage-finance)"].map(
                (color, index) => (
                  <motion.span
                    key={color}
                    className="h-2 origin-left"
                    style={{ backgroundColor: color }}
                    initial={reduceMotion ? false : { scaleX: 0 }}
                    animate={reduceMotion ? undefined : { scaleX: 1 }}
                    transition={{ duration: 0.5, delay: 0.42 + index * 0.07, ease }}
                  />
                ),
              )}
            </div>
            <p className="mt-4 font-mono text-[8px] uppercase tracking-[0.18em] text-white/28">
              Pasokan · Roast · Produksi · Penjualan · Kas
            </p>
          </div>
        </aside>

        <motion.section
          id="main-auth-content"
          className="flex min-w-0 flex-col bg-[var(--surface)] text-[var(--ink)]"
          initial={reduceMotion ? false : { opacity: 0, x: 24 }}
          animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
          transition={{ duration: 0.62, delay: 0.16, ease }}
        >
          <div className="flex items-center justify-between border-b border-[var(--technical-line)] px-5 py-4 lg:hidden">
            <Link href="/" className="inline-flex items-center gap-2.5">
              <span className="relative flex size-9 items-center justify-center rounded-[9px] bg-[var(--stage-roasting)] text-white">
                <Coffee size={16} />
                <span className="absolute -right-1 -top-1 size-2 rounded-full bg-[var(--instrument)]" />
              </span>
              <span className="font-black tracking-[-0.035em]">roastd.id</span>
            </Link>
            <motion.span
              className="signal-dot"
              aria-label="Sistem online"
              animate={
                reduceMotion
                  ? undefined
                  : { boxShadow: ["0 0 0 var(--instrument)00", "0 0 16px var(--instrument)CC", "0 0 0 var(--instrument)00"] }
              }
              transition={{ duration: 1.8, repeat: Infinity }}
            />
          </div>

          <div className="flex flex-1 items-center px-5 py-8 sm:px-10 lg:px-12">
            <div className="mx-auto w-full max-w-md">
              <motion.p
                className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-primary"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.26, ease }}
              >
                {eyebrow}
              </motion.p>
              <motion.h1
                className="mt-3 text-[clamp(1.85rem,3.4vw,2.5rem)] font-black leading-[0.98] tracking-[-0.05em]"
                initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.56, delay: 0.3, ease }}
              >
                {title}
              </motion.h1>
              <motion.p
                className="mt-3 text-sm leading-6 text-muted-foreground"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.54, delay: 0.36, ease }}
              >
                {description}
              </motion.p>

              <motion.div
                className="mt-8"
                initial={reduceMotion ? false : { opacity: 0, y: 16 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.42, ease }}
              >
                {children}
              </motion.div>

              {footer ? (
                <motion.div
                  className="mt-8 border-t border-border pt-5 text-sm text-muted-foreground"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={reduceMotion ? undefined : { opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.52 }}
                >
                  {footer}
                </motion.div>
              ) : null}
            </div>
          </div>
        </motion.section>
      </motion.div>
    </main>
  );
}
