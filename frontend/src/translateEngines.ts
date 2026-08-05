import type { TranslateProvider } from "./api";

export type EngineCredentialField = {
  key: "appId" | "secret" | "apiKey" | "note";
  label: string;
  password?: boolean;
  placeholder?: string;
};

export type EngineInfo = {
  id: TranslateProvider;
  label: string;
  /** Languages this engine handles well (normalized prefixes / codes) */
  strongLangs: string[];
  hint: string;
  /** Hard char limit for a single request; 0 = soft / high */
  defaultMaxChars: number;
  supportsChunk: boolean;
  /** Official API credential fields (empty = free / no key UI) */
  credentialFields?: EngineCredentialField[];
};

export const TRANSLATE_ENGINES: EngineInfo[] = [
  {
    id: "bing",
    label: "Bing 翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
    hint: "推荐：英中/多语；走必应网页接口，国内一般可直连。",
    defaultMaxChars: 3000,
    supportsChunk: true,
    credentialFields: [
      {
        key: "note",
        label: "备注（可选）",
        placeholder: "仅本地备注，不影响翻译",
      },
    ],
  },
  {
    id: "google",
    label: "谷歌翻译（免 Key）",
    strongLangs: [
      "en",
      "zh",
      "ja",
      "ko",
      "fr",
      "de",
      "es",
      "ru",
      "pt",
      "it",
      "ar",
      "th",
      "vi",
    ],
    hint: "多语种互译。国内 WinHTTP 直连常超时，请在「网络代理」填 Clash 端口如 127.0.0.1:7890。",
    defaultMaxChars: 1200,
    supportsChunk: true,
    credentialFields: [
      {
        key: "note",
        label: "备注（可选）",
        placeholder: "国内请配置系统/自定义代理",
      },
    ],
  },
  {
    id: "mymemory",
    label: "MyMemory（免 Key）",
    strongLangs: ["en", "zh", "fr", "de", "es", "it", "pt", "ru"],
    hint: "有每日免费额度；超额后需换引擎。",
    defaultMaxChars: 450,
    supportsChunk: true,
    credentialFields: [
      {
        key: "note",
        label: "备注（可选）",
        placeholder: "仅本地备注",
      },
    ],
  },
  {
    id: "llm",
    label: "大模型（使用上方 API）",
    strongLangs: [
      "en",
      "zh",
      "ja",
      "ko",
      "fr",
      "de",
      "es",
      "ru",
      "pt",
      "it",
      "ar",
      "th",
      "vi",
      "auto",
    ],
    hint: "依赖所选大模型，适合长文与术语。",
    defaultMaxChars: 0,
    supportsChunk: false,
  },
  {
    id: "youdao",
    label: "有道翻译（需 Key）",
    strongLangs: ["en", "zh"],
    hint: "使用有道智云 App Key / App Secret。",
    defaultMaxChars: 2000,
    supportsChunk: true,
    credentialFields: [
      { key: "appId", label: "App Key", placeholder: "应用 ID" },
      {
        key: "secret",
        label: "App Secret",
        password: true,
        placeholder: "应用密钥",
      },
    ],
  },
  {
    id: "baidu",
    label: "百度翻译（需 Key）",
    strongLangs: ["en", "zh"],
    hint: "使用百度翻译开放平台 App ID / 密钥。",
    defaultMaxChars: 2000,
    supportsChunk: true,
    credentialFields: [
      { key: "appId", label: "App ID", placeholder: "APP ID" },
      {
        key: "secret",
        label: "密钥",
        password: true,
        placeholder: "密钥",
      },
    ],
  },
  {
    id: "sogou",
    label: "搜狗翻译（需 Key）",
    strongLangs: ["en", "zh"],
    hint: "使用搜狗开放平台 PID / Key。",
    defaultMaxChars: 2000,
    supportsChunk: true,
    credentialFields: [
      { key: "appId", label: "PID", placeholder: "应用 PID" },
      {
        key: "secret",
        label: "Key",
        password: true,
        placeholder: "应用 Key",
      },
    ],
  },
  {
    id: "niutrans",
    label: "小牛翻译（需 Key）",
    strongLangs: ["en", "zh"],
    hint: "使用小牛翻译 API Key。",
    defaultMaxChars: 2000,
    supportsChunk: true,
    credentialFields: [
      {
        key: "apiKey",
        label: "API Key",
        password: true,
        placeholder: "apikey",
      },
    ],
  },
];

function normLang(code: string): string {
  const c = code.trim().toLowerCase();
  if (!c || c === "auto") return "auto";
  if (c.startsWith("zh")) return "zh";
  return c.split("-")[0] || c;
}

/** Higher score = better match for current language pair; sort descending. */
export function scoreEngine(
  engine: EngineInfo,
  source: string,
  target: string,
): number {
  const src = normLang(source);
  const dst = normLang(target);
  let score = 0;
  if (
    engine.strongLangs.includes(src) ||
    (src === "auto" && engine.id === "llm")
  ) {
    score += 2;
  }
  if (engine.strongLangs.includes(dst)) score += 2;
  if (src !== "auto" && dst !== "auto" && src !== dst) {
    if (engine.strongLangs.includes(src) && engine.strongLangs.includes(dst)) {
      score += 3;
    }
  }
  if (engine.id === "bing") score += 1.0;
  if (engine.id === "llm") score += 0.5;
  if (engine.id === "google") score += 0.3;
  if (engine.id === "mymemory") score += 0.2;
  if (
    engine.id === "youdao" ||
    engine.id === "baidu" ||
    engine.id === "sogou" ||
    engine.id === "niutrans"
  ) {
    score -= 1;
  }
  return score;
}

export function sortedEngines(source: string, target: string): EngineInfo[] {
  return [...TRANSLATE_ENGINES].sort(
    (a, b) => scoreEngine(b, source, target) - scoreEngine(a, source, target),
  );
}

/** Online engines only (excludes LLM). */
export function classicEngines(list: EngineInfo[] = TRANSLATE_ENGINES): EngineInfo[] {
  return list.filter((e) => e.id !== "llm" && e.id !== "free");
}

export function getEngineInfo(id: string): EngineInfo | undefined {
  const p = id === "free" ? "mymemory" : id === "blind" ? "bing" : id;
  return TRANSLATE_ENGINES.find((e) => e.id === p);
}

export type EngineKeysMap = Record<
  string,
  Partial<Record<"appId" | "secret" | "apiKey" | "note", string>>
>;

export function parseEngineKeys(raw: string | undefined | null): EngineKeysMap {
  if (!raw || !raw.trim()) return {};
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    return j as EngineKeysMap;
  } catch {
    return {};
  }
}

export function stringifyEngineKeys(map: EngineKeysMap): string {
  return JSON.stringify(map ?? {});
}

/** True when the engine needs App Key / Secret / API Key (note-only = free). */
export function engineRequiresKey(engine: EngineInfo): boolean {
  return !!engine.credentialFields?.some((f) => f.key !== "note");
}

export function engineHasCredentials(
  map: EngineKeysMap,
  id: string,
): boolean {
  const e = getEngineInfo(id);
  if (!e?.credentialFields?.length) return false;
  const row = map[id] || {};
  return e.credentialFields
    .filter((f) => f.key !== "note")
    .every((f) => !!(row[f.key] || "").trim());
}

/** Ready = free/no-key, or key engines with credentials filled. */
export function engineReady(map: EngineKeysMap, id: string): boolean {
  const e = getEngineInfo(id);
  if (!e) return false;
  if (!engineRequiresKey(e)) return true;
  return engineHasCredentials(map, id);
}

export function engineConfigStatusLabel(
  map: EngineKeysMap,
  id: string,
): "无需配置" | "已配置" | "未配置" {
  const e = getEngineInfo(id);
  if (!e || !engineRequiresKey(e)) return "无需配置";
  return engineHasCredentials(map, id) ? "已配置" : "未配置";
}

/**
 * Classic engines sorted for pickers: ready (free / configured) first,
 * then language suitability.
 */
export function sortedClassicEngines(
  source: string,
  target: string,
  keys: EngineKeysMap = {},
): EngineInfo[] {
  return classicEngines(TRANSLATE_ENGINES).sort((a, b) => {
    const ra = engineReady(keys, a.id) ? 1 : 0;
    const rb = engineReady(keys, b.id) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return scoreEngine(b, source, target) - scoreEngine(a, source, target);
  });
}
