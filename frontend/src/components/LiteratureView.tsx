import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, lookupDictionary, type DictionaryEntry } from "../api";
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

const WORD_RE = /^[A-Za-z][A-Za-z'-]*$/;
const LIT_DOC_KIND_KEY = "llmchat-lit-doc-kind";

function loadDocKind(): DocKind {
  try {
    const v = localStorage.getItem(LIT_DOC_KIND_KEY);
    if (v === "epub" || v === "pdf") return v;
  } catch {
    /* ignore */
  }
  return "pdf";
}

/** Collapse PDF selection line breaks so they don't break translation. */
function normalizePdfSelectionText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
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
  onPromptCatalogChange,
}: Props) {
  const [source, setSource] = useState("");
  const [translation, setTranslation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dict, setDict] = useState<DictionaryEntry | null>(null);
  const [dictHint, setDictHint] = useState<string | null>(null);
  const [dictLoading, setDictLoading] = useState(false);
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
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

  const usesLlm = translateProvider === "llm";
  const activeTag =
    catalog.find((c) => c.id === activeId)?.tag || "通用";

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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
      const trimmed = normalizePdfSelectionText(text);
      if (!trimmed) return;

      const reqId = ++reqIdRef.current;
      setSource(trimmed);
      await translateOnly(trimmed, reqId);
    },
    [translateOnly],
  );

  const runDictOnly = useCallback(
    (text: string) => {
      void fillDict(text);
    },
    [fillDict],
  );

  const onTextSelected = useCallback(
    (text: string) => {
      const trimmed = normalizePdfSelectionText(text);
      if (!trimmed) return;
      if (extractEnglishWord(trimmed)) {
        void fillDict(trimmed);
        return;
      }
      void runLookup(trimmed);
    },
    [fillDict, runLookup],
  );

  const onRetranslate = useCallback(() => {
    void (async () => {
      const trimmed = normalizePdfSelectionText(source);
      if (!trimmed) return;
      if (trimmed !== source) setSource(trimmed);
      const reqId = ++reqIdRef.current;
      await translateOnly(trimmed, reqId);
    })();
  }, [source, translateOnly]);

  const clearPdfSeed = useCallback(() => {
    setPdfSeed(null);
    setPdfSeedPage(null);
  }, []);
  const clearEpubSeed = useCallback(() => setEpubSeed(null), []);

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
        onClick={() => setPromptMenuOpen((v) => !v)}
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

  return (
    <div className="literature-layout">
      <div className="literature-reader">
        <PdfPane
          visible={visible && docKind === "pdf"}
          onTextSelected={onTextSelected}
          translateProvider={translateProvider}
          model={model}
          ocrMode={ocrMode}
          onOpenImageOcr={onOpenImageOcr}
          seedDoc={pdfSeed}
          seedPageNumber={pdfSeedPage}
          onSeedConsumed={clearPdfSeed}
          onOpenOtherKind={onOpenFromPdf}
          onDocumentChange={clearSegmentHistory}
          toolbarExtra={docKind === "pdf" ? promptMenu : null}
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
          toolbarExtra={docKind === "epub" ? promptMenu : null}
        />
      </div>
      <div
        className="col-resizer col-resizer-panel"
        title="拖动调整译文面板宽度"
        onMouseDown={(e) => beginPanelResize(e, "grow-left")}
      />
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
    </div>
  );
}
