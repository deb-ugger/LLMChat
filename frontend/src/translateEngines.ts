import type { TranslateProvider } from "./api";

export type EngineInfo = {
  id: TranslateProvider;
  label: string;
  /** Languages this engine handles well (normalized prefixes / codes) */
  strongLangs: string[];
  hint: string;
  /** Hard char limit for a single request; 0 = soft / high */
  defaultMaxChars: number;
  supportsChunk: boolean;
};

export const TRANSLATE_ENGINES: EngineInfo[] = [
  {
    id: "bing",
    label: "Bing 翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
    hint: "推荐：英中/多语；国内一般可直连。",
    defaultMaxChars: 3000,
    supportsChunk: true,
  },
  {
    id: "google",
    label: "谷歌翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi"],
    hint: "多语种互译。国内 WinHTTP 直连常超时，请在「网络代理」填 Clash 端口如 127.0.0.1:7890。",
    defaultMaxChars: 1200,
    supportsChunk: true,
  },
  {
    id: "mymemory",
    label: "MyMemory（免 Key）",
    strongLangs: ["en", "zh", "fr", "de", "es", "it", "pt", "ru"],
    hint: "有每日免费额度；超额后需换引擎。",
    defaultMaxChars: 450,
    supportsChunk: true,
  },
  {
    id: "llm",
    label: "大模型（使用上方 API）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi", "auto"],
    hint: "依赖所选大模型，适合长文与术语。",
    defaultMaxChars: 0,
    supportsChunk: false,
  },
  {
    id: "youdao",
    label: "有道翻译（接口已失效）",
    strongLangs: ["en", "zh"],
    hint: "免费网页接口已失效，请改用 Bing / 大模型。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "baidu",
    label: "百度翻译（接口已失效）",
    strongLangs: ["en", "zh"],
    hint: "免费接口需签名，已不可用，请改用 Bing / 大模型。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "sogou",
    label: "搜狗翻译（接口已失效）",
    strongLangs: ["en", "zh"],
    hint: "免费接口已不可用，请改用 Bing / 大模型。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "niutrans",
    label: "小牛翻译（需 Key）",
    strongLangs: ["en", "zh"],
    hint: "当前未配置 API Key，请改用 Bing / 大模型。",
    defaultMaxChars: 2000,
    supportsChunk: true,
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
  if (engine.strongLangs.includes(src) || (src === "auto" && engine.id === "llm")) {
    score += 2;
  }
  if (engine.strongLangs.includes(dst)) score += 2;
  if (src !== "auto" && dst !== "auto" && src !== dst) {
    if (engine.strongLangs.includes(src) && engine.strongLangs.includes(dst)) {
      score += 3;
    }
  }
  // Prefer working free engines
  if (engine.id === "bing") score += 1.0;
  if (engine.id === "llm") score += 0.5;
  if (engine.id === "google") score += 0.3;
  if (engine.id === "mymemory") score += 0.2;
  // Deprioritize broken free endpoints
  if (engine.id === "youdao" || engine.id === "baidu" || engine.id === "sogou" || engine.id === "niutrans") {
    score -= 5;
  }
  return score;
}

export function sortedEngines(source: string, target: string): EngineInfo[] {
  return [...TRANSLATE_ENGINES].sort(
    (a, b) => scoreEngine(b, source, target) - scoreEngine(a, source, target),
  );
}

export function getEngineInfo(id: string): EngineInfo | undefined {
  const p = id === "free" ? "mymemory" : id === "blind" ? "bing" : id;
  return TRANSLATE_ENGINES.find((e) => e.id === p);
}
