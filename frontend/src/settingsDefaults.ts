import type { Settings, TranslateProvider } from "./api";
import {
  DEFAULT_MTOOL_PROMPT,
  DEFAULT_SUBTITLE_PROMPT,
  DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
  DEFAULT_TEXT_PROMPT,
} from "./textTranslate";
import {
  DEFAULT_LIT_PROMPT_GENERAL,
  resolveLiteraturePromptState,
  stringifyLiteraturePromptCatalog,
} from "./literaturePrompt";

export const defaultSettings: Settings = {
  apiUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o",
  messagePageSize: 30,
  proxyMode: "direct",
  httpProxy: "",
  translateProvider: "bing",
  translateSource: "en",
  translateTarget: "zh-CN",
  translateModel: "",
  translatePromptId: "general",
  translatePromptCatalog: "[]",
  translatePromptKind: "general",
  translatePrompt: DEFAULT_LIT_PROMPT_GENERAL,
  translateMaxLength: 0,
  translateAutoChunk: true,
  translateClearLineBreaks: true,
  translateContextParagraphs: 0,
  translateGlossary: "[]",
  ocrLang: "eng",
  ocrMode: "fast",
  imageOcrMode: "fast",
  ocrAutoTranslate: true,
  ocrTranslateProvider: "bing",
  ocrTranslateSource: "en",
  ocrTranslateTarget: "zh-CN",
  ocrTranslateModel: "",
  ocrTranslateMaxLength: 0,
  ocrTranslateAutoChunk: true,
  textTranslateSource: "en",
  textTranslateTarget: "zh-CN",
  textTranslateProvider: "llm",
  textTranslateModel: "",
  textTranslatePrompt: DEFAULT_TEXT_PROMPT,
  textPromptMtool: DEFAULT_MTOOL_PROMPT,
  textPromptSubtitle: DEFAULT_SUBTITLE_PROMPT,
  textPromptSubtitleRetime: DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
  textGlossary: "[]",
  textPreReplace: "[]",
  textPostReplace: "[]",
  textProjectsDir: "",
  translateEngineKeys: "{}",
};

export function ocrLangToTranslateSource(ocrLang: string): string {
  switch (ocrLang) {
    case "chi_sim":
      return "zh-CN";
    case "chi_tra":
      return "zh-TW";
    case "jpn":
      return "ja";
    case "kor":
      return "ko";
    default:
      return "en";
  }
}

export function normalizeProvider(p: string): TranslateProvider {
  if (p === "free") return "mymemory";
  if (p === "blind") return "bing";
  return (p || "bing") as TranslateProvider;
}

export function withDefaults(s: Settings): Settings {
  const lit = resolveLiteraturePromptState({
    catalogRaw: s.translatePromptCatalog, activeIdRaw: s.translatePromptId,
    legacyKind: s.translatePromptKind, legacyPrompt: s.translatePrompt,
  });
  return {
    ...defaultSettings,
    ...s,
    translateSource: s.translateSource || "en",
    translateTarget: s.translateTarget || "zh-CN",
    proxyMode: s.proxyMode || "direct",
    httpProxy: s.httpProxy || "",
    translateProvider: normalizeProvider(s.translateProvider),
    translateModel: s.translateModel || s.model || "",
    translatePromptId: lit.activeId,
    translatePromptCatalog: stringifyLiteraturePromptCatalog(lit.catalog),
    translatePromptKind: lit.activeId,
    translatePrompt: lit.prompt,
    translateMaxLength: s.translateMaxLength ?? 0,
    translateAutoChunk: s.translateAutoChunk ?? true,
    translateClearLineBreaks: s.translateClearLineBreaks ?? true,
    translateContextParagraphs: s.translateContextParagraphs ?? 0,
    translateGlossary: s.translateGlossary || "[]",
    ocrLang: s.ocrLang || "eng",
    ocrMode:
      s.ocrMode === "precise" || s.ocrMode === "english"
        ? s.ocrMode
        : "fast",
    imageOcrMode:
      s.imageOcrMode === "precise" ||
      s.imageOcrMode === "english" ||
      s.imageOcrMode === "manga"
        ? s.imageOcrMode
        : "fast",
    ocrAutoTranslate: s.ocrAutoTranslate ?? true,
    ocrTranslateProvider: normalizeProvider(
      s.ocrTranslateProvider || "bing",
    ),
    ocrTranslateSource:
      s.ocrTranslateSource || ocrLangToTranslateSource(s.ocrLang || "eng"),
    ocrTranslateTarget: s.ocrTranslateTarget || "zh-CN",
    ocrTranslateModel: s.ocrTranslateModel || s.model || "",
    ocrTranslateMaxLength: s.ocrTranslateMaxLength ?? 0,
    ocrTranslateAutoChunk: s.ocrTranslateAutoChunk ?? true,
    textTranslateSource: s.textTranslateSource || "en",
    textTranslateTarget: s.textTranslateTarget || "zh-CN",
    textTranslateProvider: normalizeProvider(
      s.textTranslateProvider || "llm",
    ),
    textTranslateModel: s.textTranslateModel || s.model || "",
    textTranslatePrompt: s.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
    textPromptMtool: s.textPromptMtool || DEFAULT_MTOOL_PROMPT,
    textPromptSubtitle: s.textPromptSubtitle || DEFAULT_SUBTITLE_PROMPT,
    textPromptSubtitleRetime:
      s.textPromptSubtitleRetime || DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
    textGlossary: s.textGlossary || "[]",
    textPreReplace: s.textPreReplace || "[]",
    textPostReplace: s.textPostReplace || "[]",
    textProjectsDir:
      s.textProjectsDir ||
      s.textProjectsDirResolved ||
      (s.dataDir ? `${s.dataDir}\\text-projects` : ""),
    translateEngineKeys: s.translateEngineKeys || "{}",
  };
}
