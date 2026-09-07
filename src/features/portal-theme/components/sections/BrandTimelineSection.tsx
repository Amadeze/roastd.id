"use client";

import Image from "next/image";
import { MapPin, Calendar } from "lucide-react";
import type { PortalSection } from "../../types";

interface TimelineBlock {
  id: string;
  type: "narrative_step";
  visible: boolean;
  settings: {
    title: string;
    subtitle: string;
    content: string;
    imageUrl: string | null;
    icon: string;
    tag: string;
    year: string;
    location: string;
  };
}

export function BrandTimelineSection({ section }: { section: PortalSection }) {
  if (!section.enabled) return null;

  const settings = section.settings as {
    title?: string;
    subtitle?: string;
    layout?: "vertical" | "horizontal";
    showYears?: boolean;
  };

  const blocks = (section.blocks as TimelineBlock[] ?? []).filter((b) => b.visible && b.type === "narrative_step");

  if (blocks.length === 0 && !settings.title) return null;

  const isVertical = settings.layout !== "horizontal";

  const renderBlock = (block: TimelineBlock, index: number) => {
    return (
      <div key={block.id} className="relative pl-16">
        <div className="absolute left-6 -top-1 flex h-10 w-10 items-center justify-center rounded-full border-2 bg-[var(--portal-bg)]" style={{ borderColor: "var(--portal-accent)" }}>
          <span className="text-xs font-mono font-bold" style={{ color: "var(--portal-accent)" }}>
            {index + 1}
          </span>
        </div>
        <div className="relative rounded-2xl p-6 sm:p-8" style={{
          backgroundColor: "var(--portal-surface)",
          border: "1px solid var(--portal-border)",
        }}>
          {block.settings.tag && (
            <span className="mb-2 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{
              backgroundColor: "var(--portal-accent)",
              color: "var(--portal-text-inverse)",
            }}>
            {block.settings.tag}
            </span>
          )}
          {block.settings.year && settings.showYears !== false && (
            <div className="mb-2 flex items-center gap-2 text-sm font-bold" style={{ color: "var(--portal-accent)" }}>
              <Calendar size={14} />
              {block.settings.year}
            </div>
          )}
          {block.settings.location && (
            <div className="mb-3 flex items-center gap-1.5 text-sm" style={{ color: "var(--portal-text-muted)" }}>
              <MapPin size={14} />
              {block.settings.location}
            </div>
          )}
          {block.settings.title && (
            <h3 className="text-xl font-bold tracking-tight mb-2" style={{ fontFamily: "var(--portal-font-heading)", color: "var(--portal-text)" }}>
              {block.settings.title}
            </h3>
          )}
          {block.settings.subtitle && (
            <p className="mb-3 text-base" style={{ color: "var(--portal-text-muted)" }}>
              {block.settings.subtitle}
            </p>
          )}
          {block.settings.content && (
            <p className="leading-7" style={{ color: "var(--portal-text)" }}>
              {block.settings.content}
            </p>
          )}
          {block.settings.imageUrl && (
            <div className="mt-6 overflow-hidden rounded-xl">
              <Image
                src={block.settings.imageUrl}
                alt={block.settings.title || "Timeline image"}
                width={1600}
                height={900}
                className="h-auto w-full"
                loading="lazy"
                unoptimized
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderHorizontalBlock = (block: TimelineBlock, index: number) => {
    return (
      <div key={block.id} className="flex w-80 flex-col flex-shrink-0">
        <div className="flex flex-col items-center">
          <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: "var(--portal-accent)" }}>
            <span className="text-sm font-mono font-bold text-white">{index + 1}</span>
          </div>
          {block.settings.year && settings.showYears !== false && (
            <div className="mb-2 text-center text-sm font-bold" style={{ color: "var(--portal-accent)" }}>
              {block.settings.year}
            </div>
          )}
          {block.settings.tag && (
            <span className="mb-3 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{
              backgroundColor: "var(--portal-accent)",
              color: "var(--portal-text-inverse)",
            }}>
            {block.settings.tag}
            </span>
          )}
          <div className="flex-1" style={{ minWidth: "280px" }}>
            {block.settings.title && (
              <h3 className="mb-2 text-lg font-bold" style={{ fontFamily: "var(--portal-font-heading)", color: "var(--portal-text)" }}>
                {block.settings.title}
              </h3>
            )}
            {block.settings.subtitle && (
              <p className="mb-3 text-sm" style={{ color: "var(--portal-text-muted)" }}>
                {block.settings.subtitle}
              </p>
            )}
            {block.settings.content && (
              <p className="text-sm leading-6" style={{ color: "var(--portal-text)" }}>
                {block.settings.content}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <section
      className="w-full py-16 sm:py-24"
      style={{
        paddingTop: section.spacing?.paddingTop ?? 64,
        paddingBottom: section.spacing?.paddingBottom ?? 64,
        paddingLeft: section.spacing?.paddingLeft ?? 24,
        paddingRight: section.spacing?.paddingRight ?? 24,
      }}
      data-section-type="brand_timeline"
    >
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-14">
        {(settings.title || settings.subtitle) && (
          <div className="mx-auto mb-12 max-w-2xl text-center">
            {settings.title && (
              <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-4" style={{ fontFamily: "var(--portal-font-heading)" }}>
                {settings.title}
              </h2>
            )}
            {settings.subtitle && (
              <p className="text-base leading-7" style={{ color: "var(--portal-text-muted)" }}>
                {settings.subtitle}
              </p>
            )}
          </div>
        )}

        {isVertical ? (
          <div className="relative max-w-3xl mx-auto">
            <div className="absolute left-6 top-0 bottom-0 w-0.5" style={{ background: "linear-gradient(to bottom, var(--portal-accent), transparent)" }} />
            <div className="space-y-12 relative">
              {blocks.map(renderBlock)}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto pb-4">
            <div className="flex min-w-max gap-8 px-4">
              {blocks.map(renderHorizontalBlock)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}