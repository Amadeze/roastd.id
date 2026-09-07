// =============================================================================
// CUSTOMIZER STORE — Zustand state for the theme customizer
// =============================================================================

import { create } from "zustand";
import type {
  PortalThemeConfig,
  PortalSection,
  PortalBlock,
  SectionTypographyOverride,
  SectionSpacing,
  SectionBackground,
  SectionDecoration,
  SectionAnimation,
  SectionLayout,
  ResponsiveVisibility,
  ConditionalDisplay,
  PortalColorTokens,
  PortalTypography,
  ThemeVariant,
  BrandKit,
} from "../types";
import { DEFAULT_PORTAL_THEME_CONFIG, DEFAULT_SECTION_SPACING, DEFAULT_SECTION_VISIBILITY, DEFAULT_SECTION_ANIMATION, DEFAULT_SECTION_LAYOUT, DEFAULT_SECTION_DECORATION } from "../defaults/default-config";
import { getSectionDefinition, resolveSectionType } from "../registry";
import { savePortalThemeDraft, publishPortalTheme } from "../server/actions";

function uid(): string {
  return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function blockUid(): string {
  return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface CustomizerStore {
  initialDraft: PortalThemeConfig;
  workingDraft: PortalThemeConfig;
  isDirty: boolean;
  selectedSectionId: string | null;
  activePanel: "sections" | "global" | "brand" | "animations" | "seo" | "integrations";
  previewViewport: "desktop" | "tablet" | "mobile";
  isSaving: boolean;
  isPublishing: boolean;
  validationErrors: Record<string, string>;
  undoStack: PortalThemeConfig[];
  redoStack: PortalThemeConfig[];

  // Init
  initialize: (config: PortalThemeConfig) => void;
  applyThemeConfig: (config: PortalThemeConfig) => void;

  // Section actions
  updateSectionSettings: (id: string, settings: Record<string, unknown>) => void;
  applySectionPreset: (sectionId: string, settings: Record<string, unknown>, blocks: PortalBlock[]) => void;
  addSection: (type: string) => void;
  removeSection: (id: string) => void;
  duplicateSection: (id: string) => void;
  toggleSectionVisibility: (id: string) => void;
  reorderSections: (fromIndex: number, toIndex: number) => void;

  // Block actions
  addBlock: (sectionId: string, blockType: string) => void;
  removeBlock: (sectionId: string, blockId: string) => void;
  updateBlockSettings: (sectionId: string, blockId: string, settings: Record<string, unknown>) => void;
  reorderBlocks: (sectionId: string, fromIndex: number, toIndex: number) => void;

  // Per-section styling
  updateSectionTypography: (id: string, typography: SectionTypographyOverride) => void;
  updateSectionSpacing: (id: string, spacing: SectionSpacing) => void;
  updateSectionBackground: (id: string, background: SectionBackground) => void;
  updateSectionDecoration: (id: string, decoration: SectionDecoration) => void;
  updateSectionAnimation: (id: string, animation: SectionAnimation) => void;
  updateSectionLayout: (id: string, layout: SectionLayout) => void;
  updateSectionVisibility: (id: string, visibility: ResponsiveVisibility) => void;
  updateSectionCustomCSS: (id: string, css: string) => void;
  updateSectionConditionalDisplay: (id: string, display: ConditionalDisplay) => void;

  // Global settings
  updateGlobalColors: (colors: Partial<PortalColorTokens>) => void;
  updateGlobalTypography: (typography: Partial<PortalTypography>) => void;
  updateGlobalLayout: (layout: Partial<PortalThemeConfig["globalSettings"]["layout"]>) => void;
  updateGlobalAnimations: (animations: Partial<PortalThemeConfig["globalSettings"]["animations"]>) => void;
  updateGlobalSEO: (seo: Partial<PortalThemeConfig["globalSettings"]["seo"]>) => void;
  updateGlobalIntegrations: (integrations: Partial<PortalThemeConfig["globalSettings"]["integrations"]>) => void;

  // Variant management
  addVariant: (variant: ThemeVariant) => void;
  removeVariant: (id: string) => void;
  updateVariant: (id: string, updates: Partial<ThemeVariant>) => void;
  setActiveVariant: (id: string) => void;

  // Brand kit
  updateBrandKit: (brandKit: Partial<BrandKit>) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;

  // Selection
  selectSection: (id: string | null) => void;
  setActivePanel: (panel: CustomizerStore["activePanel"]) => void;
  setPreviewViewport: (viewport: "desktop" | "tablet" | "mobile") => void;

  // Persistence
  saveDraft: () => Promise<void>;
  publish: () => Promise<void>;
  discardChanges: () => void;
}

export const useCustomizerStore = create<CustomizerStore>((set, get) => ({
  initialDraft: structuredClone(DEFAULT_PORTAL_THEME_CONFIG),
  workingDraft: structuredClone(DEFAULT_PORTAL_THEME_CONFIG),
  isDirty: false,
  selectedSectionId: null,
  activePanel: "sections",
  previewViewport: "desktop",
  isSaving: false,
  isPublishing: false,
  validationErrors: {},
  undoStack: [],
  redoStack: [],

  initialize: (config) => {
    set({
      initialDraft: structuredClone(config),
      workingDraft: structuredClone(config),
      isDirty: false,
      undoStack: [],
      redoStack: [],
    });
  },

  applyThemeConfig: (config) => {
    (get() as any)._pushUndo();
    set({ workingDraft: structuredClone(config), isDirty: true });
  },

  // ── Internal: push undo state ──────────────────────────────────────────
  _pushUndo: () => {
    const { workingDraft, undoStack } = get();
    set({
      undoStack: [...undoStack.slice(-49), structuredClone(workingDraft)],
      redoStack: [],
      isDirty: true,
    });
  },

  // ── Section Actions ────────────────────────────────────────────────────
  updateSectionSettings: (id, settings) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, settings: { ...s.settings, ...settings } } : s,
        ),
      },
    }));
  },

  applySectionPreset: (sectionId, settings, blocks) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === sectionId ? { ...s, settings: { ...s.settings, ...settings }, blocks } : s,
        ),
      },
    }));
  },

  addSection: (type) => {
    (get() as any)._pushUndo();
    const canonicalType = resolveSectionType(type);
    const def = getSectionDefinition(canonicalType);
    if (!def?.addable) return;

    const newSection: PortalSection = {
      id: uid(),
      type: canonicalType,
      enabled: true,
      settings: { ...def.defaultSettings },
      blocks: [],
      spacing: { ...DEFAULT_SECTION_SPACING },
      visibility: { ...DEFAULT_SECTION_VISIBILITY },
      animation: { ...DEFAULT_SECTION_ANIMATION },
      layout: { ...DEFAULT_SECTION_LAYOUT },
      decoration: { ...DEFAULT_SECTION_DECORATION },
    };
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: [...state.workingDraft.sections, newSection],
      },
      selectedSectionId: newSection.id,
    }));
  },

  removeSection: (id) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.filter((s) => s.id !== id),
      },
      selectedSectionId: state.selectedSectionId === id ? null : state.selectedSectionId,
    }));
  },

  duplicateSection: (id) => {
    (get() as any)._pushUndo();
    set((state) => {
      const idx = state.workingDraft.sections.findIndex((s) => s.id === id);
      if (idx === -1) return state;
      const original = state.workingDraft.sections[idx];
      const duplicate: PortalSection = {
        ...structuredClone(original),
        id: uid(),
        blocks: original.blocks.map((b) => ({ ...b, id: blockUid() })),
      };
      const sections = [...state.workingDraft.sections];
      sections.splice(idx + 1, 0, duplicate);
      return {
        workingDraft: { ...state.workingDraft, sections },
        selectedSectionId: duplicate.id,
      };
    });
  },

  toggleSectionVisibility: (id) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s,
        ),
      },
    }));
  },

  reorderSections: (fromIndex, toIndex) => {
    (get() as any)._pushUndo();
    set((state) => {
      const sections = [...state.workingDraft.sections];
      const [moved] = sections.splice(fromIndex, 1);
      sections.splice(toIndex, 0, moved);
      return { workingDraft: { ...state.workingDraft, sections } };
    });
  },

  // ── Block Actions ──────────────────────────────────────────────────────
  addBlock: (sectionId, blockType) => {
    (get() as any)._pushUndo();
    const { workingDraft } = get();
    const section = workingDraft.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const def = getSectionDefinition(section.type);
    const blockDef = def?.blockTypes?.find((b) => b.type === blockType);
    if (!blockDef) return;
    const newBlock: PortalBlock = {
      id: blockUid(),
      type: blockType,
      settings: { ...blockDef.defaultSettings },
      visible: true,
    };
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === sectionId ? { ...s, blocks: [...s.blocks, newBlock] } : s,
        ),
      },
    }));
  },

  removeBlock: (sectionId, blockId) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === sectionId
            ? { ...s, blocks: s.blocks.filter((b) => b.id !== blockId) }
            : s,
        ),
      },
    }));
  },

  updateBlockSettings: (sectionId, blockId, settings) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                blocks: s.blocks.map((b) =>
                  b.id === blockId ? { ...b, settings: { ...b.settings, ...settings } } : b,
                ),
              }
            : s,
        ),
      },
    }));
  },

  reorderBlocks: (sectionId, fromIndex, toIndex) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) => {
          if (s.id !== sectionId) return s;
          const blocks = [...s.blocks];
          const [moved] = blocks.splice(fromIndex, 1);
          blocks.splice(toIndex, 0, moved);
          return { ...s, blocks };
        }),
      },
    }));
  },

  // ── Per-Section Styling ────────────────────────────────────────────────
  updateSectionTypography: (id, typography) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, typography: { ...s.typography, ...typography } } : s,
        ),
      },
    }));
  },

  updateSectionSpacing: (id, spacing) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, spacing } : s,
        ),
      },
    }));
  },

  updateSectionBackground: (id, background) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, background } : s,
        ),
      },
    }));
  },

  updateSectionDecoration: (id, decoration) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, decoration } : s,
        ),
      },
    }));
  },

  updateSectionAnimation: (id, animation) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, animation } : s,
        ),
      },
    }));
  },

  updateSectionLayout: (id, layout) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, layout } : s,
        ),
      },
    }));
  },

  updateSectionVisibility: (id, visibility) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, visibility } : s,
        ),
      },
    }));
  },

  updateSectionCustomCSS: (id, css) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, customCSS: { css } } : s,
        ),
      },
    }));
  },

  updateSectionConditionalDisplay: (id, display) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        sections: state.workingDraft.sections.map((s) =>
          s.id === id ? { ...s, conditionalDisplay: display } : s,
        ),
      },
    }));
  },

  // ── Global Settings ────────────────────────────────────────────────────
  updateGlobalColors: (colors) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          colors: { ...state.workingDraft.globalSettings.colors, ...colors },
        },
      },
    }));
  },

  updateGlobalTypography: (typography) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          typography: { ...state.workingDraft.globalSettings.typography, ...typography },
        },
      },
    }));
  },

  updateGlobalLayout: (layout) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          layout: { ...state.workingDraft.globalSettings.layout, ...layout },
        },
      },
    }));
  },

  updateGlobalAnimations: (animations) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          animations: { ...state.workingDraft.globalSettings.animations, ...animations },
        },
      },
    }));
  },

  updateGlobalSEO: (seo) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          seo: { ...state.workingDraft.globalSettings.seo, ...seo },
        },
      },
    }));
  },

  updateGlobalIntegrations: (integrations) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          integrations: { ...state.workingDraft.globalSettings.integrations, ...integrations },
        },
      },
    }));
  },

  // ── Variants ───────────────────────────────────────────────────────────
  addVariant: (variant) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          variants: [...state.workingDraft.globalSettings.variants, variant],
        },
      },
    }));
  },

  removeVariant: (id) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          variants: state.workingDraft.globalSettings.variants.filter((v) => v.id !== id),
        },
      },
    }));
  },

  updateVariant: (id, updates) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          variants: state.workingDraft.globalSettings.variants.map((v) =>
            v.id === id ? { ...v, ...updates } : v,
          ),
        },
      },
    }));
  },

  setActiveVariant: (id) => {
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: { ...state.workingDraft.globalSettings, activeVariant: id },
      },
    }));
  },

  // ── Brand Kit ──────────────────────────────────────────────────────────
  updateBrandKit: (brandKit) => {
    (get() as any)._pushUndo();
    set((state) => ({
      workingDraft: {
        ...state.workingDraft,
        globalSettings: {
          ...state.workingDraft.globalSettings,
          brandKit: { ...state.workingDraft.globalSettings.brandKit, ...brandKit },
        },
      },
    }));
  },

  // ── Undo / Redo ────────────────────────────────────────────────────────
  undo: () => {
    const { undoStack, workingDraft, redoStack } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    set({
      workingDraft: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, structuredClone(workingDraft)],
      isDirty: true,
    });
  },

  redo: () => {
    const { redoStack, workingDraft, undoStack } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    set({
      workingDraft: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, structuredClone(workingDraft)],
      isDirty: true,
    });
  },

  // ── Selection ──────────────────────────────────────────────────────────
  selectSection: (id) => set({ selectedSectionId: id }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setPreviewViewport: (viewport) => set({ previewViewport: viewport }),

  // ── Persistence ────────────────────────────────────────────────────────
  saveDraft: async () => {
    set({ isSaving: true });
    try {
      const { workingDraft } = get();
      const result = await savePortalThemeDraft(workingDraft);
      if (!result.success) {
        // Error will be shown by the page component's handleSaveDraft toast
        return;
      }
      set({
        initialDraft: structuredClone(workingDraft),
        isDirty: false,
        undoStack: [],
        redoStack: [],
      });
    } catch (err) {
      console.error("[saveDraft]", err);
      // Error will be shown by the page component's handleSaveDraft toast
    } finally {
      set({ isSaving: false });
    }
  },

  publish: async () => {
    set({ isPublishing: true });
    try {
      const { workingDraft } = get();
      // Soft guard: check readiness, warn but do not block
      try {
        const res = await fetch("/api/tenant/readiness");
        if (res.ok) {
          const readiness = await res.json();
          if (readiness && readiness.canTransact === false && Array.isArray(readiness.missingCritical) && readiness.missingCritical.length > 0) {
            const msg = `Toko belum siap transaksi:\n- ${readiness.missingCritical.join("\n- ")}\n\nTetap publish? Toko tetap tayang publik, tapi pembeli akan melihat peringatan.`;
            if (typeof window !== "undefined" && !window.confirm(msg)) {
              return;
            }
          }
        }
      } catch {
        // ignore readiness fetch errors — do not block publish
      }
      const saveResult = await savePortalThemeDraft(workingDraft);
      if (!saveResult.success) return;
      await publishPortalTheme();
      set({
        initialDraft: structuredClone(workingDraft),
        isDirty: false,
        undoStack: [],
        redoStack: [],
      });
    } finally {
      set({ isPublishing: false });
    }
  },

  discardChanges: () => {
    const { initialDraft } = get();
    set({
      workingDraft: structuredClone(initialDraft),
      isDirty: false,
      undoStack: [],
      redoStack: [],
    });
  },
}));
