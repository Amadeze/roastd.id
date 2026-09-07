"use client";

import { motion } from "framer-motion";
import { Coffee, Plus, Star } from "lucide-react";
import { StorefrontImage } from "../StorefrontImage";

interface FeaturedCollectionProps {
  settings: Record<string, unknown>;
  typography?: any;
  products?: any[];
  onAddToCart?: (product: any) => void;
  isPreview?: boolean;
}

const GRID_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

export function FeaturedCollectionSection({ settings, typography, products = [], onAddToCart }: FeaturedCollectionProps) {
  const title = (settings.title as string) || "Produk Unggulan";
  const subtitle = (settings.subtitle as string) || "";
  const columns = (settings.columns as number) || 4;

  // Filter or slice top products
  const productIds = Array.isArray(settings.productIds) ? settings.productIds : [];
  let displayProducts = products && products.length > 0 ? products : null;
  if (displayProducts && productIds.length > 0) {
    const filtered = displayProducts.filter((p: any) => productIds.includes(p.id));
    if (filtered.length > 0) displayProducts = filtered;
  }
  if (displayProducts) {
    displayProducts = displayProducts.slice(0, columns);
  }

  return (
    <section className="w-full py-16 md:py-24" style={{ backgroundColor: "var(--portal-bg, #FAFAF8)" }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8">
        {title && (
          <h2
            className="mb-3 text-center text-3xl font-bold tracking-tight"
            style={{
              color: "var(--portal-text, #1A1A1A)",
              fontFamily: "var(--portal-font-heading)",
              fontWeight: "var(--portal-heading-weight, 700)",
              ...(typography?.font ? { fontFamily: typography.font } : {}),
            }}
          >
            {title}
          </h2>
        )}
        {subtitle && (
          <p className="mb-12 text-center text-sm md:text-base max-w-xl mx-auto" style={{ color: "var(--portal-text-muted, #6B7280)" }}>
            {subtitle}
          </p>
        )}

        {displayProducts ? (
          <div
            className={`grid gap-6 ${GRID_COLS[Math.min(columns, 4)] || GRID_COLS[4]}`}
          >
            {displayProducts.map((product: any, i: number) => (
              <motion.div
                key={product.id || i}
                whileHover={{ y: -6 }}
                transition={{ duration: 0.3 }}
                className="group flex flex-col rounded-2xl border overflow-hidden shadow-sm hover:shadow-lg bg-white transition-all"
                style={{
                  backgroundColor: "var(--portal-surface, #fff)",
                  borderColor: "var(--portal-border-subtle, #F0F0F0)",
                }}
              >
                <div
                  className="aspect-square relative flex items-center justify-center overflow-hidden"
                  style={{ backgroundColor: "var(--portal-surface-alt, #F5F3EF)" }}
                >
                  {product.imageUrl ? (
                    <StorefrontImage src={product.imageUrl} alt={product.name} width={800} height={800} sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                  ) : (
                    <Coffee size={40} className="opacity-30" style={{ color: "var(--portal-accent, #D4A574)" }} />
                  )}
                  <span className="absolute top-3 right-3 p-1.5 rounded-full bg-amber-500/10 text-amber-600 backdrop-blur-sm">
                    <Star size={14} fill="currentColor" />
                  </span>
                </div>
                <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-base line-clamp-1" style={{ color: "var(--portal-text, #1A1A1A)" }}>
                      {product.name}
                    </h3>
                    <p className="text-xs mt-1 font-bold" style={{ color: "var(--portal-primary, #D4A574)" }}>
                      Rp {Number(product.price || 0).toLocaleString("id-ID")} / kg
                    </p>
                  </div>
                  <button
                    onClick={() => onAddToCart && onAddToCart(product)}
                    className="w-full py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm active:scale-95"
                    style={{
                      backgroundColor: "var(--portal-primary, #D4A574)",
                      color: "var(--portal-text-inverse, #fff)",
                    }}
                  >
                    <Plus size={14} strokeWidth={2.5} />
                    <span>Pesan Sekarang</span>
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <div
            className={`grid gap-6 ${GRID_COLS[Math.min(columns, 4)] || GRID_COLS[4]}`}
          >
            {Array.from({ length: Math.min(columns, 4) }).map((_, i) => (
              <div key={i} className="rounded-2xl border p-4 aspect-square flex flex-col items-center justify-center text-center gap-2" style={{ borderColor: "var(--portal-border-subtle, #F0F0F0)" }}>
                <Coffee size={32} className="opacity-20" style={{ color: "var(--portal-accent, #D4A574)" }} />
                <span className="text-xs opacity-50" style={{ color: "var(--portal-text-muted)" }}>Produk belum tersedia</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
