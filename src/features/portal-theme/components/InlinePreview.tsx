// =============================================================================
// INLINE PREVIEW — Renders the portal preview directly from Zustand store
// No iframe, no postMessage — instant updates as user edits
// =============================================================================

"use client";

import { useCustomizerStore } from "../client/store";
import { PortalThemeRenderer } from "./PortalThemeRenderer";
import { Tablet, Smartphone } from "lucide-react";

const VIEWPORT_SIZES = {
  desktop: { width: "100%", maxWidth: "100%", height: "calc(100vh - 56px)" },
  tablet: { width: "768px", maxWidth: "100%", height: "calc(100vh - 56px)" },
  mobile: { width: "375px", maxWidth: "100%", height: "calc(100vh - 56px)" },
};

interface InlinePreviewProps {
  products?: any[];
  offerings?: any[];
  subdomain: string;
}

export function InlinePreview({ products = [], offerings = [], subdomain }: InlinePreviewProps) {
  const workingDraft = useCustomizerStore((s) => s.workingDraft);
  const previewViewport = useCustomizerStore((s) => s.previewViewport);
  const size = VIEWPORT_SIZES[previewViewport];

  return (
    <div className="flex flex-col h-full bg-gray-200">
      {/* Viewport indicator */}
      {previewViewport !== "desktop" && (
        <div className="flex items-center justify-center gap-2 py-1.5 bg-gray-300 text-xs font-semibold text-gray-500">
          {previewViewport === "tablet" ? <Tablet size={12} /> : <Smartphone size={12} />}
          {previewViewport} — {size.width}
        </div>
      )}

      {/* Preview frame */}
      <div className="flex-1 flex justify-center overflow-auto p-1.5 sm:p-4">
        <div
          className="bg-white shadow-2xl rounded-xl overflow-hidden border border-gray-300 transition-all duration-300 w-full flex flex-col"
          style={{ width: size.width, maxWidth: size.maxWidth, height: size.height }}
        >
          {/* Browser chrome */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 border-b border-gray-200 shrink-0">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
            <div className="ml-3 flex-1 bg-white rounded-md px-3 py-1 text-xs text-gray-400 font-mono border border-gray-200 truncate">
              {subdomain ? `https://${subdomain}.roastd.id` : "Storefront belum tersedia"}
            </div>
          </div>

          {/* Live rendered portal */}
          <div className="overflow-auto flex-1" style={{ height: `calc(${size.height} - 36px)` }}>
            <PortalThemeRenderer config={workingDraft} isPreview products={products} offerings={offerings} />
          </div>
        </div>
      </div>
    </div>
  );
}
