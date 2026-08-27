import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  lookupDictionary,
  type DictionaryEntry,
  type OcrMode,
  type OcrModelStatus,
} from "../api";
import { toFriendlyError } from "../friendlyError";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import {
  DEFAULT_LIT_PROMPT_GENERAL,
  GENERAL_PROMPT_ID,
  resolveLiteraturePromptState,
  type LiteraturePromptEntry,
} from "../literaturePrompt";
import { parseJsonArray, type GlossaryEntry } from "../textTranslate";
import type { DocKind, LocalDocFile } from "../localDocFile";
import { LiteraturePromptPanel } from "./LiteraturePromptPanel";
import { EpubPane } from "./EpubPane";
import { PdfPane } from "./PdfPane";
import { TranslatePanel } from "./TranslatePanel";
import { LangCombobox } from "./LangCombobox";
import { normalizeOcrMode, OCR_MODE_LABELS } from "../ocr/paddleOcr";

const WORD_RE = /^[A-Za-z][A-Za-z'-]*$/;
const LIT_DOC_KIND_KEY = "llmchat-lit-doc-kind";
const LITERATURE_OCR_MODES: Array<{
  id: OcrMode;
  description: string;
}> = [
  { id: "fast", description: "内置模型，适合日常中英日文档" },
  { id: "precise", description: "复杂排版、小字和表格识别" },
  { id: "english", description: "英文论文与技术文档优化" },
];

function loadDocKind(): DocKind {
  try {
    const v = localStorage.getItem(LIT_DOC_KIND_KEY);
    if (v === "epub" || v === "pdf") return v;
  } catch {
    /* ignore */
  }
  return "pdf";
}

/** Normalize PDF selection text, optionally preserving code-sensitive line breaks. */
function normalizePdfSelectionText(
  text: string,
  clearLineBreaks = true,
): string {
  const normalized = text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  if (!clearLineBreaks) {
    return normalized.replace(/^\n+|\n+$/g, "");
  }
  return normalized
    .replace(/-\s*[\r\n]+/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
}

/** Pull a single English word from selection / query (strip punctuation). */
function extractEnglishWord(text: string): string | null {
  const cleaned = normalizePdfSelectionText(text);
  if (!cleaned) return null;
  const stripped = cleaned
    .replace(/^[“”"'‘’(（\[【<«]+/, "")
    .replace(/[”"'‘’)）\]】>»,.!?;:…]+$/u, "")
    .trim();
  if (WORD_RE.test(stripped)) return stripped;
  const tokens = cleaned.match(/[A-Za-z][A-Za-z'-]*/g);
  if (tokens && tokens.length === 1 && WORD_RE.test(tokens[0])) {
    return tokens[0];
  }
  return null;
}

type LitSegment = { source: string; translation: string };

function buildLitContext(
  history: LitSegment[],
  current: string,
  n: number,
): LitSegment[] {
  if (n <= 0) return [];
  const prior = history.filter((s) => s.source !== current);
  return prior.slice(-n);
}

function upsertLitSegment(
  history: LitSegment[],
  source: string,
  translation: string,
): LitSegment[] {
  const idx = history.findIndex((s) => s.source === source);
  if (idx >= 0) {
    const next = [...history];
    next[idx] = { source, translation };
    return next;
  }
  return [...history, { source, translation }];
}

type Props = {
  visible: boolean;
  translateProvider: string;
  translateSource?: string;
  translateTarget?: string;
  translateMaxLength?: number;
  translateAutoChunk?: boolean;
  translateClearLineBreaks?: boolean;
  translateContextParagraphs?: number;
  translateGlossary?: string;
  translatePromptCatalog?: string;
  translatePromptId?: string;
  translatePromptKind?: string;
  translatePrompt?: string;
  model: string;
  ocrMode?: string;
  apiUrl?: string;
  apiKey?: string;
  onOpenImageOcr?: (file: File) => void;
  onOcrModeChange?: (mode: OcrMode) => void | Promise<void>;
  onTranslateSourceChange?: (source: string) => void | Promise<void>;
  onTranslateTargetChange?: (target: string) => void | Promise<void>;
  onPromptCatalogChange?: (next: {
    catalog: LiteraturePromptEntry[];
    activeId: string;
    prompt: string;
  }) => void | Promise<void>;
};

export function LiteratureView({
  visible,
  translateProvider,
  translateSource = "en",
  translateTarget = "zh-CN",
  translateMaxLength = 0,
  translateAutoChunk = true,
  translateClearLineBreaks = true,
  translateContextParagraphs = 0,
  translateGlossary = "[]",
  translatePromptCatalog = "",
  translatePromptId = "",
  translatePromptKind = "general",
  translatePrompt = "",
  model,
  ocrMode = "fast",
  apiUrl = "",
  apiKey = "",
  onOpenImageOcr,
  onOcrModeChange,
  onTranslateSourceChange,
  onTranslateTargetChange,
  onPromptCatalogChange,
}: Props) {
  const [source, setSource] = useState("");
  const [translation, setTranslation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [languageSaved, setLanguageSaved] = useState(false);
  const languageSavedTimerRef = useRef<number | null>(null);
  const [dict, setDict] = useState<DictionaryEntry | null>(null);
  const [dictHint, setDictHint] = useState<string | null>(null);
  const [dictLoading, setDictLoading] = useState(false);
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
  const [ocrModeMenuOpen, setOcrModeMenuOpen] = useState(false);
  const [ocrModelStatus, setOcrModelStatus] = useState<OcrModelStatus | null>(null);
  const [ocrModeBusy, setOcrModeBusy] = useState<OcrMode | null>(null);
  const [ocrModeError, setOcrModeError] = useState<string | null>(null);
  const ocrModeMenuRef = useRef<HTMLDivElement | null>(null);
  const ocrProgressPollRef = useRef<number | null>(null);
  const [docKind, setDocKind] = useState<DocKind>(loadDocKind);
  const [pdfSeed, setPdfSeed] = useState<LocalDocFile | null>(null);
  const [pdfSeedPage, setPdfSeedPage] = useState<number | null>(null);
  const [epubSeed, setEpubSeed] = useState<LocalDocFile | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LIT_DOC_KIND_KEY, docKind);
    } catch {
      /* ignore */
    }
  }, [docKind]);

  const onOpenFromPdf = useCallback((_kind: "epub", doc: LocalDocFile) => {
    setEpubSeed(doc);
    setDocKind("epub");
  }, []);

  const onOpenFromEpub = useCallback(
    (_kind: "pdf", doc: LocalDocFile, pageNumber?: number) => {
      setPdfSeed(doc);
      setPdfSeedPage(
        typeof pageNumber === "number" && pageNumber > 0
          ? Math.floor(pageNumber)
          : null,
      );
      setDocKind("pdf");
    },
    [],
  );

  const resolved = useMemo(
    () =>
      resolveLiteraturePromptState({
        catalogRaw: translatePromptCatalog,
        activeIdRaw: translatePromptId,
        legacyKind: translatePromptKind,
        legacyPrompt: translatePrompt,
      }),
    [
      translatePromptCatalog,
      translatePromptId,
      translatePromptKind,
      translatePrompt,
    ],
  );

  const [catalog, setCatalog] = useState(resolved.catalog);
  const [activeId, setActiveId] = useState(resolved.activeId);
  const activeIdRef = useRef(resolved.activeId);
  const activePromptRef = useRef(
    resolved.activeId === GENERAL_PROMPT_ID ? "" : resolved.prompt,
  );

  useEffect(() => {
    setCatalog(resolved.catalog);
    setActiveId(resolved.activeId);
    activeIdRef.current = resolved.activeId;
    activePromptRef.current =
      resolved.activeId === GENERAL_PROMPT_ID ? "" : resolved.prompt;
  }, [resolved]);

  const reqIdRef = useRef(0);
  const dictReqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const segmentHistoryRef = useRef<LitSegment[]>([]);
  const glossaryEntries = useMemo(
    () =>
      parseJsonArray<GlossaryEntry>(translateGlossary, []).filter(
        (r) => r.enabled !== false && r.src.trim() && r.dst.trim(),
      ),
    [translateGlossary],
  );
  const { width: panelWidth, beginResize: beginPanelResize } =
    usePersistedWidth("llmchat-translate-panel-width", 320, 220, 640);
  const [panelHidden, setPanelHidden] = useState(false);

  const usesLlm = translateProvider === "llm";
  const activeTag =
    catalog.find((c) => c.id === activeId)?.tag || "通用";

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (languageSavedTimerRef.current !== null) {
        window.clearTimeout(languageSavedTimerRef.current);
      }
      if (ocrProgressPollRef.current !== null) {
        window.clearInterval(ocrProgressPollRef.current);
      }
    };
  }, []);

  const showLanguageSaved = useCallback(() => {
    if (languageSavedTimerRef.current !== null) {
      window.clearTimeout(languageSavedTimerRef.current);
    }
    setLanguageSaved(true);
    languageSavedTimerRef.current = window.setTimeout(() => {
      setLanguageSaved(false);
      languageSavedTimerRef.current = null;
    }, 2400);
  }, []);

  useEffect(() => {
    if (!visible || docKind !== "pdf") return;
    void api.getOcrModelStatus().then(setOcrModelStatus).catch(() => undefined);
  }, [docKind, visible]);

  useEffect(() => {
    if (!ocrModeMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      const element = ocrModeMenuRef.current;
      if (element && !element.contains(event.target as Node)) {
        setOcrModeMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOcrModeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [ocrModeMenuOpen]);

  useEffect(() => {
    if (!promptMenuOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const el = promptMenuRef.current;
      if (el && !el.contains(ev.target as Node)) {
        setPromptMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPromptMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [promptMenuOpen]);

  const commitPromptCatalog = useCallback(
    async (next: {
      catalog: LiteraturePromptEntry[];
      activeId: string;
    }) => {
      const entry =
        next.catalog.find((c) => c.id === next.activeId) ||
        next.catalog.find((c) => c.id === GENERAL_PROMPT_ID);
      const prompt =
        next.activeId === GENERAL_PROMPT_ID
          ? ""
          : entry?.prompt || "";
      setCatalog(next.catalog);
      setActiveId(next.activeId);
      activeIdRef.current = next.activeId;
      activePromptRef.current = prompt;
      await onPromptCatalogChange?.({
        catalog: next.catalog,
        activeId: next.activeId,
        prompt:
          next.activeId === GENERAL_PROMPT_ID
            ? DEFAULT_LIT_PROMPT_GENERAL
            : prompt || DEFAULT_LIT_PROMPT_GENERAL,
      });
    },
    [onPromptCatalogChange],
  );

  const clearSegmentHistory = useCallback(() => {
    segmentHistoryRef.current = [];
  }, []);

  const translateOnly = useCallback(
    async (text: string, reqId: number) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setError(null);
      try {
        const provider = translateProvider || "bing";
        // 通用：不传 prompt，走后端内置英文默认以节省 token
        const useCustomPrompt =
          activeIdRef.current !== GENERAL_PROMPT_ID &&
          !!(activePromptRef.current || "").trim();
        const context =
          provider === "llm" && translateContextParagraphs > 0
            ? buildLitContext(
                segmentHistoryRef.current,
                trimmed,
                translateContextParagraphs,
              )
            : [];
        const tr = await api.translate(
          trimmed,
          { signal: ac.signal },
          {
            provider,
            source: translateSource || "en",
            target: translateTarget || "zh-CN",
            maxLength: translateMaxLength || 0,
            autoChunk: translateAutoChunk !== false,
            ...(provider === "llm"
              ? {
                  apiUrl,
                  apiKey,
                  model,
                  ...(useCustomPrompt
                    ? { prompt: activePromptRef.current }
                    : {}),
                  ...(glossaryEntries.length
                    ? { glossary: glossaryEntries }
                    : {}),
                  ...(context.length ? { context } : {}),
                  feature: "literature",
                }
              : { feature: "literature" }),
          },
        );
        if (reqId !== reqIdRef.current) return;
        const out = (tr.translation || "").trim();
        if (
          !out ||
          /<!doctype\s*html/i.test(out) ||
          /<\s*html[\s>]/i.test(out)
        ) {
          setTranslation("");
          setError(
            !out
              ? `译文为空（引擎：${tr.provider || provider}）。请确认设置里已保存引擎，或换 Bing / 大模型后重试`
              : out,
          );
          return;
        }
        setTranslation(out);
        segmentHistoryRef.current = upsertLitSegment(
          segmentHistoryRef.current,
          trimmed,
          out,
        );
      } catch (err) {
        if (ac.signal.aborted || reqId !== reqIdRef.current) return;
        setTranslation("");
        setError(toFriendlyError(err, "翻译失败，请稍后重试"));
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [
      apiKey,
      apiUrl,
      model,
      translateAutoChunk,
      translateContextParagraphs,
      translateMaxLength,
      translateProvider,
      translateSource,
      translateTarget,
      glossaryEntries,
    ],
  );

  const fillDict = useCallback(
    async (raw: string) => {
      const reqId = ++dictReqIdRef.current;
      const word = extractEnglishWord(raw);
      setDict(null);
      if (!word) {
        setDictHint("多词/句子仅提供译文；可在底部输入单个单词查词典");
        setDictLoading(false);
        return;
      }
      setDictLoading(true);
      setDictHint(`正在查询「${word}」…`);
      try {
        const entry = await lookupDictionary(word, {
          source: translateSource || "en",
          target: translateTarget || "zh-CN",
        });
        if (reqId !== dictReqIdRef.current) return;
        setDict(entry);
        setDictHint(null);
      } catch (e) {
        if (reqId !== dictReqIdRef.current) return;
        setDict(null);
        setDictHint(
          toFriendlyError(
            e,
            "词典服务暂时不可用，请检查网络或后端是否运行",
          ),
        );
      } finally {
        if (reqId === dictReqIdRef.current) setDictLoading(false);
      }
    },
    [translateSource, translateTarget],
  );

  const runLookup = useCallback(
    async (text: string) => {
      const trimmed = normalizePdfSelectionText(
        text,
        translateClearLineBreaks,
      );
      if (!trimmed.trim()) return;

      const reqId = ++reqIdRef.current;
      setSource(trimmed);
      await translateOnly(trimmed, reqId);
    },
    [translateClearLineBreaks, translateOnly],
  );

  const runDictOnly = useCallback(
    (text: string) => {
      void fillDict(text);
    },
    [fillDict],
  );

  const onTextSelected = useCallback(
    (text: string) => {
      const trimmed = normalizePdfSelectionText(
        text,
        translateClearLineBreaks,
      );
      if (!trimmed.trim()) return;
      if (extractEnglishWord(trimmed)) {
        void fillDict(trimmed);
        return;
      }
      void runLookup(trimmed);
    },
    [fillDict, runLookup, translateClearLineBreaks],
  );

  const onRetranslate = useCallback(() => {
    void (async () => {
      const trimmed = normalizePdfSelectionText(
        source,
        translateClearLineBreaks,
      );
      if (!trimmed.trim()) return;
      if (trimmed !== source) setSource(trimmed);
      const reqId = ++reqIdRef.current;
      await translateOnly(trimmed, reqId);
    })();
  }, [source, translateClearLineBreaks, translateOnly]);

  const clearPdfSeed = useCallback(() => {
    setPdfSeed(null);
    setPdfSeedPage(null);
  }, []);
  const clearEpubSeed = useCallback(() => setEpubSeed(null), []);

  const chooseLiteratureOcrMode = useCallback(
    async (mode: OcrMode) => {
      if (ocrModeBusy) return;
      setOcrModeError(null);
      try {
        let status = ocrModelStatus;
        if (!status) {
          status = await api.getOcrModelStatus();
          setOcrModelStatus(status);
        }
        const installed =
          mode === "fast" || status.modes.find((item) => item.id === mode)?.installed;
        if (!installed) {
          setOcrModeBusy(mode);
          const poll = async () => {
            try {
              setOcrModelStatus(await api.getOcrModelStatus());
            } catch {
              /* keep the download request authoritative */
            }
          };
          void poll();
          ocrProgressPollRef.current = window.setInterval(() => void poll(), 350);
          const next = await api.ensureOcrMode(mode);
          setOcrModelStatus(next);
        }
        await onOcrModeChange?.(mode);
        setOcrModeMenuOpen(false);
      } catch (error) {
        setOcrModeError(toFriendlyError(error, "识别模型切换失败"));
      } finally {
        if (ocrProgressPollRef.current !== null) {
          window.clearInterval(ocrProgressPollRef.current);
          ocrProgressPollRef.current = null;
        }
        setOcrModeBusy(null);
        void api.getOcrModelStatus().then(setOcrModelStatus).catch(() => undefined);
      }
    },
    [ocrModeBusy, ocrModelStatus, onOcrModeChange],
  );

  const activeOcrMode = normalizeOcrMode(ocrMode);
  const ocrDownload = ocrModelStatus?.download;
  const ocrDownloadTotal = Math.max(0, ocrDownload?.totalBytes ?? 0);
  const ocrDownloadDone = Math.max(0, ocrDownload?.downloadedBytes ?? 0);
  const ocrDownloadPercent = ocrDownloadTotal
    ? Math.min(100, Math.round((ocrDownloadDone / ocrDownloadTotal) * 100))
    : 0;

  const ocrModeMenu = (
    <div className="literature-ocr-menu" ref={ocrModeMenuRef}>
      <button
        type="button"
        className={`pdf-tool-btn literature-ocr-trigger${ocrModeMenuOpen ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={ocrModeMenuOpen}
        onClick={() => {
          setPromptMenuOpen(false);
          setOcrModeMenuOpen((open) => !open);
        }}
      >
        识别模式 · {OCR_MODE_LABELS[activeOcrMode]}
        <svg
          className="literature-ocr-trigger-arrow"
          viewBox="0 0 20 20"
          aria-hidden
        >
          <path d="M4 7l6 6 6-6" />
        </svg>
      </button>
      {ocrModeMenuOpen ? (
        <div className="literature-ocr-dropdown" role="menu">
          <div className="literature-ocr-dropdown-head">
            <strong>PDF 识别模型</strong>
            <span>仅用于 OCR</span>
          </div>
          <p
            className="hint"
            style={{
              margin: "0 3px 9px",
              padding: "7px 9px",
              borderRadius: 8,
              background: "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))",
              color: "var(--accent-ink)",
              lineHeight: 1.45,
            }}
          >
            <strong>作用范围：</strong>
            只影响扫描页、智能提取的 OCR 回退及 Shift+提取本页。普通原生文字层框选不使用此模型。
          </p>
          <div className="literature-ocr-options">
            {LITERATURE_OCR_MODES.map((option) => {
              const selected = activeOcrMode === option.id;
              const status = ocrModelStatus?.modes.find((item) => item.id === option.id);
              const downloading =
                ocrModeBusy === option.id ||
                (ocrDownload?.active === true && ocrDownload.mode === option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`literature-ocr-option${selected ? " is-selected" : ""}`}
                  disabled={ocrModeBusy !== null || ocrDownload?.active === true}
                  onClick={() => void chooseLiteratureOcrMode(option.id)}
                >
                  <span className="literature-ocr-option-mark" aria-hidden>
                    {selected ? "✓" : ""}
                  </span>
                  <span className="literature-ocr-option-copy">
                    <strong>{OCR_MODE_LABELS[option.id]}</strong>
                    <small>{option.description}</small>
                  </span>
                  <span className="literature-ocr-option-state">
                    {option.id === "fast"
                      ? "内置"
                      : downloading
                        ? `${ocrDownloadPercent}%`
                        : status?.installed
                          ? "已下载"
                          : "需下载"}
                  </span>
                </button>
              );
            })}
          </div>
          {ocrModeBusy ? (
            <div className="literature-ocr-progress" aria-live="polite">
              <div>
                <span>{ocrDownload?.model || "正在建立下载连接"}</span>
                <strong>{ocrDownloadPercent}%</strong>
              </div>
              <span className="ocr-download-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ocrDownloadPercent}>
                <span className="ocr-download-progress-fill" style={{ width: `${ocrDownloadPercent}%` }} />
              </span>
            </div>
          ) : null}
          {ocrModeError ? <p className="literature-ocr-error">{ocrModeError}</p> : null}
        </div>
      ) : null}
    </div>
  );

  const promptMenu = (
    <div className="pdf-prompt-menu" ref={promptMenuRef}>
      <button
        type="button"
        className={"pdf-tool-btn" + (promptMenuOpen ? " is-active" : "")}
        disabled={!usesLlm}
        title={
          usesLlm
            ? `提示词：${activeTag}`
            : "切换为「大模型翻译」后可使用提示词"
        }
        onClick={() => {
          setOcrModeMenuOpen(false);
          setPromptMenuOpen((v) => !v);
        }}
      >
        提示词 · {activeTag}
      </button>
      {promptMenuOpen && usesLlm ? (
        <div className="pdf-prompt-dropdown">
          <div className="pdf-prompt-dropdown-head">
            <strong>文献翻译提示词</strong>
            <button
              type="button"
              className="pdf-tool-btn"
              onClick={() => setPromptMenuOpen(false)}
            >
              关闭
            </button>
          </div>
          <LiteraturePromptPanel
            catalog={catalog}
            activeId={activeId}
            onCommit={commitPromptCatalog}
          />
        </div>
      ) : null}
    </div>
  );

  const renderLanguageControls = () => (
    <div className="toolbar-language-pair" aria-label="翻译语言">
      <LangCombobox
        label="源语言"
        value={translateSource}
        onChange={(code) => onTranslateSourceChange?.(code)}
        onSaved={showLanguageSaved}
        compact
      />
      <span className="toolbar-language-arrow" aria-hidden>
        →
      </span>
      <LangCombobox
        label="目标语言"
        value={translateTarget}
        onChange={(code) => onTranslateTargetChange?.(code)}
        onSaved={showLanguageSaved}
        allowAuto={false}
        compact
      />
    </div>
  );

  return (
    <div className="literature-layout">
      <div className="literature-reader">
        {languageSaved ? (
          <div className="settings-toast ocr-toast is-ok" role="status">
            保存成功
          </div>
        ) : null}
        <PdfPane
          visible={visible && docKind === "pdf"}
          onTextSelected={onTextSelected}
          clearLineBreaks={translateClearLineBreaks}
          translateProvider={translateProvider}
          model={model}
          ocrMode={ocrMode}
          onOpenImageOcr={onOpenImageOcr}
          seedDoc={pdfSeed}
          seedPageNumber={pdfSeedPage}
          onSeedConsumed={clearPdfSeed}
          onOpenOtherKind={onOpenFromPdf}
          onDocumentChange={clearSegmentHistory}
          toolbarExtra={
            docKind === "pdf" ? (
              <>
                {renderLanguageControls()}
                {ocrModeMenu}
                {promptMenu}
              </>
            ) : null
          }
        />
        <EpubPane
          visible={visible && docKind === "epub"}
          onTextSelected={onTextSelected}
          translateProvider={translateProvider}
          model={model}
          seedDoc={epubSeed}
          onSeedConsumed={clearEpubSeed}
          onOpenOtherKind={onOpenFromEpub}
          onDocumentChange={clearSegmentHistory}
          toolbarExtra={
            docKind === "epub" ? (
              <>
                {renderLanguageControls()}
                {promptMenu}
              </>
            ) : null
          }
        />
      </div>
      <div
        className={`col-resizer col-resizer-panel${panelHidden ? " is-collapsed" : ""}`}
        title={panelHidden ? "" : "拖动调整译文面板宽度"}
        onMouseDown={
          panelHidden
            ? undefined
            : (e) => beginPanelResize(e, "grow-left")
        }
      >
        <button
          type="button"
          className="translate-panel-toggle"
          aria-label={panelHidden ? "显示翻译侧边栏" : "隐藏翻译侧边栏"}
          aria-expanded={!panelHidden}
          title={panelHidden ? "显示翻译侧边栏" : "隐藏翻译侧边栏"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPanelHidden((hidden) => !hidden)}
        >
          <span
            className={`translate-panel-toggle-icon${panelHidden ? " is-expand" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {!panelHidden ? (
        <TranslatePanel
          width={panelWidth}
          source={source}
          translation={translation}
          loading={loading}
          error={error}
          dict={dict}
          dictHint={dictHint}
          dictLoading={dictLoading}
          onSourceChange={setSource}
          onRetranslate={onRetranslate}
          onDictLookup={runDictOnly}
        />
      ) : null}
    </div>
  );
}
