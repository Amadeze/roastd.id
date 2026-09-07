"use client";

import { TrendingUp, Users, Award, Coffee } from "lucide-react";

const ICON_MAP: Record<string, React.ComponentType<any>> = {
  TrendingUp, Users, Award, Coffee,
};

interface SocialProofProps {
  settings: Record<string, unknown>;
  blocks: any[];
  typography?: any;
}

export function SocialProofSection({ blocks }: SocialProofProps) {
  const visibleBlocks = blocks.filter((b) => b.type === "stat" && b.visible !== false);

  if (visibleBlocks.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-center gap-6 sm:gap-12">
      {visibleBlocks.map((block) => {
        const IconComp = ICON_MAP[block.settings.icon as string] || TrendingUp;
        return (
          <div key={block.id} className="text-center">
            <IconComp size={32} className="mx-auto mb-2" style={{ color: "var(--portal-primary)" }} />
            <div className="text-3xl font-bold" style={{ color: "var(--portal-text)" }}>
              {block.settings.value as string}
            </div>
            <div className="text-sm" style={{ color: "var(--portal-text-muted)" }}>
              {block.settings.label as string}
            </div>
          </div>
        );
      })}
    </div>
  );
}
