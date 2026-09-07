"use client";

import { Coffee, Plus } from "lucide-react";
import { StorefrontImage } from "../StorefrontImage";

interface ProductHighlightProps {
  settings: Record<string, unknown>;
  typography?: any;
  products?: any[];
  onAddToCart?: (product: any) => void;
  isPreview?: boolean;
}

export function ProductHighlightSection({ settings, products = [], onAddToCart }: ProductHighlightProps) {
  const showPrice = settings.showPrice !== false;
  const showDescription = settings.showDescription !== false;
  const targetId = settings.productId as string;

  const product = products && products.length > 0
    ? (targetId ? products.find((p: any) => p.id === targetId) || products[0] : products[0])
    : null;

  return (
    <section className="w-full py-16 md:py-24" style={{ backgroundColor: "var(--portal-bg, #FAFAF8)" }}>
      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        <div className="flex flex-col gap-10 md:flex-row items-center">
          <div className="flex-1 w-full">
            <div
              className="aspect-square w-full rounded-2xl overflow-hidden relative flex items-center justify-center border shadow-md"
              style={{ backgroundColor: "var(--portal-surface-alt, #F5F3EF)", borderColor: "var(--portal-border-subtle, #F0F0F0)" }}
            >
              {product && product.imageUrl ? (
                <StorefrontImage src={product.imageUrl} alt={product.name} width={1000} height={1000} sizes="(max-width: 768px) 100vw, 50vw" className="w-full h-full object-cover" />
              ) : (
                <Coffee size={80} className="opacity-30" style={{ color: "var(--portal-accent, #D4A574)" }} />
              )}
            </div>
          </div>
          <div className="flex-1 w-full flex flex-col justify-center">
            {product?.roastLevel && (
              <span className="text-xs uppercase tracking-widest font-semibold mb-2 block" style={{ color: "var(--portal-accent, #D4A574)" }}>
                {product.roastLevel} • {product.origin || "Roast Spesialitas"}
              </span>
            )}
            <h2
              className="text-3xl md:text-4xl font-bold tracking-tight mb-4"
              style={{
                color: "var(--portal-text, #1A1A1A)",
                fontFamily: "var(--portal-font-heading)",
              }}
            >
              {product ? product.name : "Pilihan Unggulan"}
            </h2>
            {showPrice && product && (
              <div className="text-2xl font-bold mb-6" style={{ color: "var(--portal-primary, #D4A574)" }}>
                Rp {Number(product.price || 0).toLocaleString("id-ID")} <span className="text-sm font-normal text-gray-500">/ kg</span>
              </div>
            )}
            {showDescription && (
              <p className="text-sm md:text-base leading-relaxed mb-8" style={{ color: "var(--portal-text-muted, #6B7280)" }}>
                {product ? (product.description || "Disangrai dengan presisi untuk konsistensi. Aroma istimewa, body seimbang, dan clean finish yang dirancang untuk layanan grosir.") : "Detail produk akan ditampilkan secara dinamis dari inventaris aktif Anda."}
              </p>
            )}
            <div>
              <button
                onClick={() => product && onAddToCart && onAddToCart(product)}
                className="px-8 py-3.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-all shadow-md hover:shadow-lg active:scale-95"
                style={{
                  backgroundColor: "var(--portal-primary, #D4A574)",
                  color: "var(--portal-text-inverse, #fff)",
                }}
              >
                <Plus size={18} strokeWidth={2.5} />
                <span>Pesan Sekarang</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
