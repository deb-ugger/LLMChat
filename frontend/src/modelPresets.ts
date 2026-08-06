export type ModelPreset = {
  model: string;
  label: string;
  apiUrl: string;
  /** Visual group in settings (DeepSeek / OpenAI / …) */
  group: string;
};

export type ModelProfile = {
  apiUrl: string;
  apiKey: string;
};

/** Per-vendor credentials (shared by all models under the same group). */
export type VendorProfile = {
  apiUrl: string;
  apiKey: string;
};

export type VendorModelEntry = {
  model: string;
  label: string;
  /** api = from official refresh (not deletable); manual = user-added */
  source?: "api" | "manual";
};

/** Saved overrides from dataDir/vendor-models.json (via API). */
export type VendorModelsOverride = Record<string, VendorModelEntry[]>;

export const MODEL_PRESETS: ModelPreset[] = [
  {
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "gpt-4o",
    label: "GPT-4o",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-4o-mini",
    label: "GPT-4o mini",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-4-turbo",
    label: "GPT-4 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-3.5-turbo",
    label: "GPT-3.5 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    apiUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    group: "Google",
  },
  {
    model: "qwen-plus",
    label: "通义千问 Plus",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    group: "通义千问",
  },
  {
    model: "qwen-turbo",
    label: "通义千问 Turbo",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    group: "通义千问",
  },
];

export function groupModelPresets(
  presets: ModelPreset[] = MODEL_PRESETS,
): { group: string; models: ModelPreset[] }[] {
  const order: string[] = [];
  const map = new Map<string, ModelPreset[]>();
  for (const p of presets) {
    const g = p.group || "其他";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(p);
  }
  return order.map((group) => ({ group, models: map.get(group)! }));
}

/**
 * Merge built-in presets with per-vendor overrides.
 * A vendor with a non-empty override list uses that list entirely.
 */
export function effectivePresets(
  overrides: VendorModelsOverride = {},
): ModelPreset[] {
  const builtinGroups = groupModelPresets(MODEL_PRESETS);
  const out: ModelPreset[] = [];
  const seen = new Set<string>();

  for (const g of builtinGroups) {
    seen.add(g.group);
    const apiUrl = g.models[0]?.apiUrl || defaultApiUrlForVendor(g.group);
    const over = overrides[g.group];
    if (over && over.length > 0) {
      for (const m of over) {
        const id = (m.model || "").trim();
        if (!id) continue;
        const builtin = MODEL_PRESETS.find((p) => p.model === id);
        out.push({
          model: id,
          label: (m.label || "").trim() || builtin?.label || id,
          apiUrl,
          group: g.group,
        });
      }
    } else {
      out.push(...g.models);
    }
  }

  for (const [group, models] of Object.entries(overrides)) {
    if (seen.has(group) || !models?.length) continue;
    for (const m of models) {
      const id = (m.model || "").trim();
      if (!id) continue;
      out.push({
        model: id,
        label: (m.label || "").trim() || id,
        apiUrl: "",
        group,
      });
    }
  }
  return out;
}

export function effectiveGroupPresets(
  overrides: VendorModelsOverride = {},
): { group: string; models: ModelPreset[] }[] {
  return groupModelPresets(effectivePresets(overrides));
}

/** In-memory cache of dataDir vendor-models.json (kept in sync by Settings). */
let vendorModelsOverrideCache: VendorModelsOverride = {};

export function getVendorModelsOverrideCache(): VendorModelsOverride {
  return vendorModelsOverrideCache;
}

export function setVendorModelsOverrideCache(overrides: VendorModelsOverride) {
  vendorModelsOverrideCache = overrides || {};
}

export function currentEffectivePresets(): ModelPreset[] {
  return effectivePresets(vendorModelsOverrideCache);
}

export function presetForModel(
  model: string,
  presets: ModelPreset[] = currentEffectivePresets(),
): ModelPreset | undefined {
  return presets.find((p) => p.model === model);
}

export function vendorOfModel(
  model: string,
  presets: ModelPreset[] = currentEffectivePresets(),
): string | null {
  return presetForModel(model, presets)?.group ?? null;
}

export function defaultApiUrlForVendor(group: string): string {
  return MODEL_PRESETS.find((p) => p.group === group)?.apiUrl ?? "";
}

/**
 * Friendly labels for well-known model ids returned by vendor /v1/models.
 * Falls back to the id itself when unknown.
 */
export function labelForModelId(modelId: string, group?: string): string {
  const id = (modelId || "").trim();
  if (!id) return "";
  const fromBuiltin = MODEL_PRESETS.find(
    (p) => p.model === id && (!group || p.group === group),
  );
  if (fromBuiltin) return fromBuiltin.label;
  const known: Record<string, string> = {
    "deepseek-v4-flash": "DeepSeek V4 Flash",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek-chat": "DeepSeek Chat（旧别名）",
    "deepseek-reasoner": "DeepSeek Reasoner（旧别名）",
    "deepseek-v3": "DeepSeek V3（旧）",
  };
  return known[id] || id;
}

const LEGACY_PROFILES_KEY = "llmchat-model-profiles";
const VENDOR_PROFILES_KEY = "llmchat-vendor-profiles";

function parseProfilesObject(raw: string | null): Record<string, ModelProfile> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelProfile>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Migrate old per-model profiles into per-vendor profiles (once). */
export function migrateVendorProfilesFromLegacy(
  legacy: Record<string, ModelProfile>,
): Record<string, VendorProfile> {
  const vendors: Record<string, VendorProfile> = {};
  for (const g of groupModelPresets()) {
    let best: VendorProfile | null = null;
    for (const m of g.models) {
      const row = legacy[m.model];
      if (!row) continue;
      const hasKey = !!(row.apiKey || "").trim();
      const hasUrl = !!(row.apiUrl || "").trim();
      if (!hasKey && !hasUrl) continue;
      if (!best || (hasKey && !(best.apiKey || "").trim())) {
        best = {
          apiUrl: (row.apiUrl || "").trim() || g.models[0].apiUrl,
          apiKey: row.apiKey || "",
        };
      }
    }
    if (best) vendors[g.group] = best;
  }
  return vendors;
}

export function loadVendorProfiles(): Record<string, VendorProfile> {
  try {
    const raw = localStorage.getItem(VENDOR_PROFILES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, VendorProfile>;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // fall through to migrate
  }
  const legacy = parseProfilesObject(localStorage.getItem(LEGACY_PROFILES_KEY));
  const migrated = migrateVendorProfilesFromLegacy(legacy);
  if (Object.keys(migrated).length > 0) {
    saveVendorProfiles(migrated);
  }
  return migrated;
}

export function saveVendorProfiles(profiles: Record<string, VendorProfile>) {
  try {
    localStorage.setItem(VENDOR_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

/** Local / custom model credentials (not part of a preset vendor). */
export function loadLocalModelProfiles(): Record<string, ModelProfile> {
  const all = parseProfilesObject(localStorage.getItem(LEGACY_PROFILES_KEY));
  const presetIds = new Set(MODEL_PRESETS.map((p) => p.model));
  const out: Record<string, ModelProfile> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!presetIds.has(k)) out[k] = v;
  }
  return out;
}

export function saveLocalModelProfiles(profiles: Record<string, ModelProfile>) {
  try {
    localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

/** @deprecated Prefer loadVendorProfiles + loadLocalModelProfiles */
export function loadModelProfiles(): Record<string, ModelProfile> {
  return loadLocalModelProfiles();
}

/** @deprecated Prefer saveLocalModelProfiles */
export function saveModelProfiles(profiles: Record<string, ModelProfile>) {
  saveLocalModelProfiles(profiles);
}

export function resolveModelApi(
  model: string,
  localProfiles: Record<string, ModelProfile>,
  vendorProfiles?: Record<string, VendorProfile>,
  presets: ModelPreset[] = currentEffectivePresets(),
): ModelProfile {
  const preset = presetForModel(model, presets);
  if (preset) {
    const vendors = vendorProfiles ?? loadVendorProfiles();
    const v = vendors[preset.group];
    return {
      apiUrl: (v?.apiUrl || "").trim() || preset.apiUrl,
      apiKey: v?.apiKey ?? "",
    };
  }
  const saved = localProfiles[model];
  if (saved) {
    return {
      apiUrl: saved.apiUrl ?? "",
      apiKey: saved.apiKey ?? "",
    };
  }
  return { apiUrl: "", apiKey: "" };
}

/** Resolve LLM credentials for a feature model (falls back to chat model). */
export function resolveFeatureLlm(
  settings: {
    model: string;
    apiUrl: string;
    apiKey: string;
  },
  featureModel: string | undefined,
  localProfiles?: Record<string, ModelProfile>,
  vendorProfiles?: Record<string, VendorProfile>,
  presets: ModelPreset[] = currentEffectivePresets(),
): { model: string; apiUrl: string; apiKey: string } {
  const model = (featureModel || "").trim() || settings.model;
  if (model === settings.model) {
    return {
      model,
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
    };
  }
  const locals = localProfiles || loadLocalModelProfiles();
  const vendors = vendorProfiles || loadVendorProfiles();
  const localsWithCurrent = { ...locals };
  const chatVendor = vendorOfModel(settings.model, presets);
  const vendorsWithCurrent = { ...vendors };
  if (chatVendor) {
    vendorsWithCurrent[chatVendor] = {
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
    };
  } else if (settings.model) {
    localsWithCurrent[settings.model] = {
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
    };
  }
  const resolved = resolveModelApi(
    model,
    localsWithCurrent,
    vendorsWithCurrent,
    presets,
  );
  return { model, apiUrl: resolved.apiUrl, apiKey: resolved.apiKey };
}
