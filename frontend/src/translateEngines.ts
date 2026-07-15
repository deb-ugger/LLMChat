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
    id: "google",
    label: "谷歌翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi"],
    hint: "擅长：多语种互译，英中日韩欧语覆盖广，长文较稳。",
    defaultMaxChars: 1200,
    supportsChunk: true,
  },
  {
    id: "bing",
    label: "Bing 翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
    hint: "擅长：英中欧语，术语偏稳，适合技术文档。",
    defaultMaxChars: 3000,
    supportsChunk: true,
  },
  {
    id: "mymemory",
    label: "MyMemory（免 Key）",
    strongLangs: ["en", "zh", "fr", "de", "es", "it", "pt", "ru"],
    hint: "擅长：常见欧语与英中，免费额度有单次长度限制。",
    defaultMaxChars: 450,
    supportsChunk: true,
  },
  {
    id: "youdao",
    label: "有道翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "ru"],
    hint: "擅长：英中互译、考试/日常用语；日韩可用。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "baidu",
    label: "百度翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "ru", "pt", "es"],
    hint: "擅长：中文相关互译、中英口语与一般文档。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "sogou",
    label: "搜狗翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko"],
    hint: "擅长：中英互译、网络用语；小语种覆盖一般。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "niutrans",
    label: "小牛翻译（免 Key）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "ru", "es"],
    hint: "擅长：中英/多语机器翻译，偏书面语。",
    defaultMaxChars: 2000,
    supportsChunk: true,
  },
  {
    id: "llm",
    label: "大模型（使用上方 API）",
    strongLangs: ["en", "zh", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi", "auto"],
    hint: "擅长：语境理解与专业术语，依赖所选大模型能力，几乎不限长度。",
    defaultMaxChars: 0,
    supportsChunk: false,
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
  // Prefer no-key engines with high coverage slightly when tied
  if (engine.id === "google") score += 0.5;
  if (engine.id === "bing") score += 0.4;
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
