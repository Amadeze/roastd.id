import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Eyebrow — the signature mono uppercase label of the Material Intelligence system.
 * Use above titles and section headers. Tone defaults to tertiary ink; set `tone="accent"`
 * for the copper variant (use sparingly).
 */
type EyebrowTone = "neutral" | "accent" | "muted";

const toneClass: Record<EyebrowTone, string> = {
  neutral: "text-ink-secondary",
  accent: "text-copper",
  muted: "text-ink-tertiary",
};

export function Eyebrow({
  children,
  tone = "neutral",
  className,
  as: Tag = "p",
  id,
  htmlFor,
}: {
  children: React.ReactNode;
  tone?: EyebrowTone;
  className?: string;
  as?: React.ElementType;
  id?: string;
  htmlFor?: string;
}) {
  return (
    <Tag
      id={id}
      htmlFor={htmlFor}
      className={cn(
        "font-mono text-[11px] font-bold uppercase tracking-[0.14em]",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </Tag>
  );
}
