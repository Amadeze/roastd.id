export const dynamic = "force-dynamic";

import nextDynamic from "next/dynamic";
import type { Metadata } from "next";
import { fetchLandingSocialProof } from "./_actions/landing-social-proof";

const BASE_URL = "https://roastd.id";

const LandingClient = nextDynamic(
  () => import("./LandingClient").then((m) => ({ default: m.LandingClient })),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[#05090D]">
        <div className="mx-auto max-w-[1180px] px-3 sm:px-5 lg:p-8">
          <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-8 lg:grid-cols-2">
            <div className="flex flex-col justify-center space-y-6 py-12">
              <div className="h-4 w-48 animate-pulse rounded bg-white/10" />
              <div className="space-y-4">
                <div className="h-12 w-full max-w-md animate-pulse rounded bg-white/10" />
                <div className="h-12 w-full max-w-sm animate-pulse rounded bg-white/10" />
              </div>
              <div className="h-12 w-48 animate-pulse rounded bg-white/10" />
            </div>
            <div className="hidden items-center justify-center lg:flex">
              <div className="h-[400px] w-full max-w-[560px] animate-pulse rounded-2xl bg-white/5" />
            </div>
          </div>
        </div>
      </div>
    ),
  },
);

export const metadata: Metadata = {
  title: "roastd.id — Roastery Operating System + Studio",
  description:
    "Berhenti gabungin Excel, Artisan, dan nota manual setiap akhir shift. Satu alur dari lot green bean → roasting → produksi → penjualan → HPP & laporan untuk coffee roastery.",
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: "roastd.id — Roastery Operating System",
    description:
      "Satu roast menggerakkan stok, HPP, produksi, dan laporan dalam alur operasional yang sama.",
    type: "website",
    locale: "id_ID",
    url: BASE_URL,
    siteName: "roastd.id",
    images: [
      {
        url: `${BASE_URL}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: "roastd.id — Roastery Operating System. Roasting selesai. Operasional ikut bergerak.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "roastd.id — Roastery Operating System",
    description:
      "Satu roast menggerakkan stok, HPP, produksi, dan laporan. Coba gratis 21 hari.",
    images: [`${BASE_URL}/opengraph-image`],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "roastd.id",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web, Windows",
  description:
    "Sistem operasional multi-tenant untuk coffee roastery — menghubungkan lot green bean, roasting, produksi, penjualan, HPP, dan laporan dalam satu alur.",
  url: BASE_URL,
  inLanguage: "id",
  offers: {
    "@type": "Offer",
    price: "355000",
    priceCurrency: "IDR",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: "355000",
      priceCurrency: "IDR",
      unitText: "bulan",
    },
  },
  featureList: [
    "Lot & inventory ledger (FEFO)",
    "Roasting batch & profile matching",
    "Roastd Studio (.alog)",
    "Produksi & HPP otomatis",
    "Penjualan & kasir offline-aware",
    "Keuangan (piutang, hutang, jurnal)",
    "Daily Brief & laporan keputusan",
    "Tenant isolation & role-based access",
  ],
};

export default async function LandingPage() {
  const socialProof = await fetchLandingSocialProof();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingClient socialProof={socialProof} />
    </>
  );
}
