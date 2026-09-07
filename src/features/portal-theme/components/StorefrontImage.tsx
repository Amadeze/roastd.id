"use client";

import Image from "next/image";
import { createContext, useContext, type ImgHTMLAttributes, type ReactNode } from "react";

type StorefrontImageSettings = {
  lazyLoadImages: boolean;
  preloadCritical: boolean;
};

const StorefrontImageContext = createContext<StorefrontImageSettings>({
  lazyLoadImages: true,
  preloadCritical: false,
});

export function StorefrontImageProvider({
  settings,
  children,
}: {
  settings: StorefrontImageSettings;
  children?: ReactNode;
}) {
  return (
    <StorefrontImageContext.Provider value={settings}>
      {children}
    </StorefrontImageContext.Provider>
  );
}

export function canOptimizeStorefrontImage(src: string) {
  if (src.startsWith("/")) return true;
  try {
    const { protocol, hostname } = new URL(src);
    return protocol === "https:" && (
      hostname === "images.unsplash.com" || hostname.endsWith(".supabase.co")
    );
  } catch {
    return false;
  }
}

type StorefrontImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height" | "loading"
> & {
  src: string;
  alt: string;
  width: number;
  height: number;
  sizes: string;
  critical?: boolean;
};

export function StorefrontImage({
  src,
  alt,
  width,
  height,
  sizes,
  critical = false,
  ...props
}: StorefrontImageProps) {
  const settings = useContext(StorefrontImageContext);
  const preload = critical && settings.preloadCritical;
  const loading = critical || !settings.lazyLoadImages ? "eager" : "lazy";

  if (canOptimizeStorefrontImage(src)) {
    return (
      <Image
        {...props}
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        loading={preload ? undefined : loading}
        preload={preload}
        fetchPriority={critical ? "high" : undefined}
      />
    );
  }

  // Compatibility fallback for previously persisted external merchant URLs.
  // New uploads use same-origin or Supabase paths and receive Next optimization.
  return (
    <Image
      {...props}
      src={src}
      alt={alt}
      width={width}
      height={height}
      sizes={sizes}
      loading={loading}
      decoding="async"
      unoptimized
      fetchPriority={critical ? "high" : undefined}
    />
  );
}
