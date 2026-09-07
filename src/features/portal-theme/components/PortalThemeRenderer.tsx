// =============================================================================
// PORTAL THEME RENDERER — Renders the full portal from a validated config
// =============================================================================

"use client";

import { useMemo } from "react";
import type { PortalThemeConfig, PortalSection } from "../types";
import { resolveSectionType } from "../registry";
import { sanitizeCSS } from "../server/css-sanitizer";
import { HeroBannerSection } from "./sections/HeroBannerSection";
import { RichTextSection } from "./sections/RichTextSection";
import { ImageWithTextSection } from "./sections/ImageWithTextSection";
import { CatalogGridSection } from "./sections/CatalogGridSection";
import { BenefitsSection } from "./sections/BenefitsSection";
import { TestimonialsSection } from "./sections/TestimonialsSection";
import { FaqSection } from "./sections/FaqSection";
import { ContactCtaSection } from "./sections/ContactCtaSection";
import { CountdownSection } from "./sections/CountdownSection";
import { NewsletterSection } from "./sections/NewsletterSection";
import { GallerySection } from "./sections/GallerySection";
import { VideoEmbedSection } from "./sections/VideoEmbedSection";
import { FeaturedCollectionSection } from "./sections/FeaturedCollectionSection";
import { ProductHighlightSection } from "./sections/ProductHighlightSection";
import { SocialProofSection } from "./sections/SocialProofSection";
import { BentoShowcaseSection } from "./sections/BentoShowcaseSection";
import { InteractiveFlavorSection } from "./sections/InteractiveFlavorSection";
import { CuppingArchiveSection } from "./sections/CuppingArchiveSection";
import { StickyNarrativeSection } from "./sections/StickyNarrativeSection";
import { WholesaleRadarSection } from "./sections/WholesaleRadarSection";
import { KineticMarqueeSection } from "./sections/KineticMarqueeSection";
import { HeaderNavSection } from "./sections/HeaderNavSection";
import { FooterNavSection } from "./sections/FooterNavSection";
import { AwardsStripSection } from "./sections/AwardsStripSection";
import { BrandTimelineSection } from "./sections/BrandTimelineSection";
import { SustainabilitySection } from "./sections/SustainabilitySection";
import { StorefrontImageProvider } from "./StorefrontImage";
import { MotionConfig } from "framer-motion";

// ── Section Component Map ───────────────────────────────────────────────────

const SECTION_COMPONENTS: Record<string, React.ComponentType<any>> = {
  hero_banner: HeroBannerSection,
  rich_text: RichTextSection,
  image_with_text: ImageWithTextSection,
  catalog_grid: CatalogGridSection,
  featured_collection: FeaturedCollectionSection,
  product_highlight: ProductHighlightSection,
  benefits: BenefitsSection,
  testimonials: TestimonialsSection,
  countdown: CountdownSection,
  social_proof: SocialProofSection,
  newsletter: NewsletterSection,
  contact_cta: ContactCtaSection,
  faq: FaqSection,
  gallery: GallerySection,
  video_embed: VideoEmbedSection,
  // Unlimited Creation Sections
  bento_showcase: BentoShowcaseSection,
  interactive_flavor: InteractiveFlavorSection,
  cupping_archive: CuppingArchiveSection,
  sticky_narrative: StickyNarrativeSection,
  roast_matrix: WholesaleRadarSection,
  marquee_kinetic: KineticMarqueeSection,
  header_nav: HeaderNavSection,
  footer_nav: FooterNavSection,
  // New Roastery Storytelling Sections
  awards_strip: AwardsStripSection,
  brand_timeline: BrandTimelineSection,
  sustainability: SustainabilitySection,
};

const CANONICAL_SECTION_ANCHORS: Record<string, string> = {
  catalog_grid: "catalog",
  faq: "faq",
  contact_cta: "contact",
  sticky_narrative: "narrative",
  interactive_flavor: "flavor",
  roast_matrix: "matrix",
};

// ── Font Loading ────────────────────────────────────────────────────────────

function getGoogleFontsUrl(config: PortalThemeConfig): string {
  const fonts = new Set<string>();
  fonts.add(config.globalSettings.typography.headingFont);
  fonts.add(config.globalSettings.typography.bodyFont);

  const families = Array.from(fonts)
    .map((f) => `family=${f.replace(/ /g, "+")}:wght@300;400;500;600;700;800;900`)
    .join("&");

  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

// ── CSS Variable Generation ─────────────────────────────────────────────────

function generateCSSVariables(
  config: PortalThemeConfig,
): string {
  const { globalSettings } = config;
  const { colors, typography, layout, animations } = globalSettings;

  return `
    .portal-root {
      --portal-primary: ${colors.primary};
      --portal-secondary: ${colors.secondary};
      --portal-accent: ${colors.accent};
      --portal-bg: ${colors.background};
      --portal-surface: ${colors.surface};
      --portal-surface-alt: ${colors.surfaceAlt};
      --portal-text: ${colors.text};
      --portal-text-muted: ${colors.textMuted};
      --portal-text-inverse: ${colors.textInverse};
      --portal-border: ${colors.border};
      --portal-border-subtle: ${colors.borderSubtle};
      --portal-error: ${colors.error};
      --portal-success: ${colors.success};
      --portal-warning: ${colors.warning};
      --portal-info: ${colors.info};

      --portal-font-heading: ${typography.headingFont}, sans-serif;
      --portal-font-body: ${typography.bodyFont}, sans-serif;
      --portal-font-size: ${typography.baseFontSize}px;
      --portal-line-height: ${typography.lineHeight};
      --portal-letter-spacing: ${typography.letterSpacing}em;
      --portal-heading-weight: ${typography.headingWeight};
      --portal-body-weight: ${typography.bodyWeight};

      --portal-content-width: ${layout.contentWidth}px;
      --portal-section-gap: ${layout.sectionGap}px;
      --portal-page-padding: ${layout.pagePadding}px;
      --portal-radius: ${layout.borderRadius}px;

      --portal-anim-duration: ${animations.globalDuration}ms;
      --portal-anim-easing: ${animations.globalEasing};
    }

    .portal-root[data-motion-reduced="true"] *,
    .portal-root[data-motion-reduced="true"] *::before,
    .portal-root[data-motion-reduced="true"] *::after {
      animation-duration: 0.01ms;
      animation-iteration-count: 1;
      scroll-behavior: auto;
      transition-duration: 0.01ms;
    }

    @media (prefers-reduced-motion: reduce) {
      .portal-root *, .portal-root *::before, .portal-root *::after {
        animation-duration: 0.01ms;
        animation-iteration-count: 1;
        scroll-behavior: auto;
        transition-duration: 0.01ms;
      }
    }
  `;
}

// ── Section Spacing Styles ──────────────────────────────────────────────────

function getSpacingStyle(section: PortalSection): React.CSSProperties {
  if (!section.spacing) return {};
  const { paddingTop, paddingRight, paddingBottom, paddingLeft, marginTop, marginBottom } = section.spacing;
  return {
    paddingTop: `${paddingTop}px`,
    paddingRight: `${paddingRight}px`,
    paddingBottom: `${paddingBottom}px`,
    paddingLeft: `${paddingLeft}px`,
    marginTop: `${marginTop}px`,
    marginBottom: `${marginBottom}px`,
  };
}

// ── Section Background Styles ───────────────────────────────────────────────

function getBackgroundStyle(section: PortalSection): React.CSSProperties {
  if (!section.background) return {};
  const bg = section.background;
  const style: React.CSSProperties = {};

  switch (bg.type) {
    case "color":
      style.backgroundColor = bg.color || "transparent";
      break;
    case "image":
      style.backgroundImage = `url(${bg.imageUrl})`;
      style.backgroundPosition = bg.imagePosition || "center";
      style.backgroundSize = bg.imageSize || "cover";
      style.backgroundRepeat = bg.imageRepeat || "no-repeat";
      break;
    case "gradient":
      if (bg.gradient) {
        const stops = bg.gradient.stops
          .map((s) => `${s.color} ${s.position}%`)
          .join(", ");
        style.backgroundImage = `${bg.gradient.type}-gradient(${bg.gradient.angle}deg, ${stops})`;
      }
      break;
  }

  if (bg.opacity !== undefined && bg.opacity < 100) {
    style.opacity = bg.opacity / 100;
  }

  return style;
}

// ── Section Decoration Styles ───────────────────────────────────────────────

function getDecorationStyle(section: PortalSection): React.CSSProperties {
  if (!section.decoration) return {};
  const d = section.decoration;
  const style: React.CSSProperties = {
    borderRadius: `${d.borderRadius}px`,
    borderWidth: `${d.borderWidth}px`,
    borderColor: d.borderColor,
    borderStyle: d.borderStyle,
  };

  if (d.shadow !== "none" && d.shadow !== "custom") {
    const shadows: Record<string, string> = {
      sm: "0 1px 3px rgba(0,0,0,0.1)",
      md: "0 4px 12px rgba(0,0,0,0.1)",
      lg: "0 8px 30px rgba(0,0,0,0.12)",
      xl: "0 20px 60px rgba(0,0,0,0.15)",
    };
    style.boxShadow = shadows[d.shadow] || "none";
  } else if (d.shadow === "custom" && d.customShadow) {
    style.boxShadow = d.customShadow;
  }

  return style;
}

// ── Animation Styles ────────────────────────────────────────────────────────

function getAnimationStyle(section: PortalSection): React.CSSProperties {
  if (!section.animation || section.animation.scrollTrigger === "none") return {};
  return {
    transition: `all ${section.animation.duration}ms ${section.animation.easing}`,
  };
}

// ── Width Classes ───────────────────────────────────────────────────────────

function getWidthClass(width: string | undefined): string {
  switch (width) {
    case "full": return "w-full";
    case "wide": return "max-w-7xl mx-auto";
    case "normal": return "max-w-5xl mx-auto";
    case "narrow": return "max-w-3xl mx-auto";
    default: return "max-w-7xl mx-auto";
  }
}

// ── Error Boundary ──────────────────────────────────────────────────────────

import { Component, type ReactNode } from "react";

class SectionErrorBoundary extends Component<
  { children: ReactNode; sectionType: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; sectionType: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="py-8 text-center text-sm text-gray-400">
          Bagian &quot;{this.props.sectionType}&quot; gagal dimuat.
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Unknown Section Fallback ────────────────────────────────────────────────

function UnknownSectionFallback({ type }: { type: string }) {
  return (
    <div className="py-8 text-center text-sm text-gray-400">
      Jenis bagian tidak dikenali: {type}
    </div>
  );
}

// ── Main Renderer ───────────────────────────────────────────────────────────

interface PortalThemeRendererProps {
  config: PortalThemeConfig;
  children?: ReactNode;
  isPreview?: boolean;
  products?: any[];
  offerings?: any[];
  cuppingSessions?: any[];
  onAddToCart?: (product: any) => void;
  onAddOfferingToCart?: (...args: any[]) => void;
  onOpenCart?: () => void;
  cartItemCount?: number;
}

import { DEFAULT_PORTAL_THEME_CONFIG } from "../defaults/default-config";

export function PortalThemeRenderer({ config, children, isPreview = false, products = [], offerings = [], cuppingSessions = [], onAddToCart, onAddOfferingToCart, onOpenCart, cartItemCount = 0 }: PortalThemeRendererProps) {
  // Defensive: ensure config is always valid
  const safeConfig = config && config.globalSettings && config.sections ? config : DEFAULT_PORTAL_THEME_CONFIG;
  
  const cssVars = useMemo(() => generateCSSVariables(safeConfig), [safeConfig]);
  const fontsUrl = useMemo(() => getGoogleFontsUrl(safeConfig), [safeConfig]);

  const sortedSections = useMemo(() => {
    return safeConfig.sections
      .filter((s) => s.enabled)
      .filter((s) => {
        if (!s.visibility) return true;
        return true;
      });
  }, [safeConfig.sections]);

  return (
    <div
      className="portal-root min-h-screen overflow-x-hidden"
      data-motion-reduced={safeConfig.globalSettings.animations.reduceMotion}
      style={{
        backgroundColor: "var(--portal-bg)",
        color: "var(--portal-text)",
        fontFamily: "var(--portal-font-body)",
        fontSize: "var(--portal-font-size)",
        lineHeight: "var(--portal-line-height)",
      }}
    >
      <style>{cssVars}</style>

      {isPreview && (
        <div role="status" aria-live="polite" className="sticky top-0 z-50 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs font-semibold text-amber-900 backdrop-blur">
          Preview — Anda melihat draft. Publish untuk tayang ke publik. Checkout dinonaktifkan di mode ini.
        </div>
      )}

      {/* Google Fonts */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href={fontsUrl} rel="stylesheet" />

      {/* Per-section custom CSS */}
      {safeConfig.sections.map((section) => {
        if (!section.customCSS?.css) return null;
        const sanitized = sanitizeCSS(section.customCSS.css);
        if (!sanitized.ok) return null;
        return (
          <style key={`css-${section.id}`}>
            {`#${section.id} { ${sanitized.css} }`}
          </style>
        );
      })}

      <MotionConfig reducedMotion={safeConfig.globalSettings.animations.reduceMotion ? "always" : "user"}>
      <StorefrontImageProvider settings={safeConfig.globalSettings.seo}>
      {/* Sections */}
      {sortedSections.map((section) => {
        const canonicalType = resolveSectionType(section.type);
        const Component = SECTION_COMPONENTS[canonicalType];
        if (!Component) {
          return (
            <SectionErrorBoundary key={section.id} sectionType={section.type}>
              <UnknownSectionFallback type={section.type} />
            </SectionErrorBoundary>
          );
        }

        return (
          <SectionErrorBoundary key={section.id} sectionType={section.type}>
            <section
              id={section.id}
              data-section-type={canonicalType}
              className={getWidthClass(section.layout?.width)}
              style={{
                ...getSpacingStyle(section),
                ...getBackgroundStyle(section),
                ...getDecorationStyle(section),
                ...getAnimationStyle(section),
              }}
            >
              {CANONICAL_SECTION_ANCHORS[canonicalType] &&
              CANONICAL_SECTION_ANCHORS[canonicalType] !== section.id ? (
                <span
                  id={CANONICAL_SECTION_ANCHORS[canonicalType]}
                  className="block scroll-mt-24"
                  aria-hidden="true"
                />
              ) : null}
              <Component
                settings={section.settings}
                blocks={section.blocks}
                typography={section.typography}
                layout={section.layout}
                sectionId={section.id}
                isPreview={isPreview}
                products={products}
                offerings={offerings}
                cuppingSessions={cuppingSessions}
                onAddToCart={onAddToCart}
                onAddOfferingToCart={onAddOfferingToCart}
                onOpenCart={onOpenCart}
                cartItemCount={cartItemCount}
              />
            </section>
          </SectionErrorBoundary>
        );
      })}
      {children}
      </StorefrontImageProvider>
      </MotionConfig>
    </div>
  );
}
