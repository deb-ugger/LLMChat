import { useCallback, useEffect, useRef, useState } from "react";
import { api, lookupDictionary, type DictionaryEntry } from "../api";
import { toFriendlyError } from "../friendlyError";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { PdfPane } from "./PdfPane";
import { TranslatePanel } from "./TranslatePanel";

const WORD_RE = /^[A-Za-z][A-Za-z'-]*$/;

/** Collapse PDF selection line breaks so they don't break translation. */
function normalizePdfSelectionText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    // join hyphenated line-wrap: "exam-\nple" → "example"
    .replace(/-\s*[\r\n]+/g, "")
    // other newlines → space
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

type Props = {
  visible: boolean;
  translateProvider: string;
  translateSource?: string;
  translateTarget?: string;
  translateMaxLength?: number;
  translateAutoChunk?: boolean;
  model: string;
  apiUrl?: string;
  apiKey?: string;
  onOpenImageOcr?: (file: File) => void;
};

export function LiteratureView({
  visible,
  translateProvider,
  translateSource = "en",
  translateTarget = "zh-CN",
  translateMaxLength = 0,
  translateAutoChunk = true,
  model,
  apiUrl = "",
  apiKey = "",
  onOpenImageOcr,
}: Props) {
  const [source, setSource] = useState("");
  const [translation, setTranslation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dict, setDict] = useState<DictionaryEntry | null>(null);
  const [dictHint, setDictHint] = useState<string | null>(null);
  const [dictLoading, setDictLoading] = useState(false);
  const reqIdRef = useRef(0);
  const dictReqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const { width: panelWidth, beginResize: beginPanelResize } =
    usePersistedWidth("llmchat-translate-panel-width", 320, 220, 640);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
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
        const tr = await api.translate(
          trimmed,
          { signal: ac.signal },
          {
            provider,
            source: translateSource || "en",
            target: translateTarget || "zh-CN",
            maxLength: translateMaxLength || 0,
            autoChunk: translateAutoChunk !== false,
            ...(provider === "llm" ? { apiUrl, apiKey, model } : {}),
          },
        );
        if (reqId !== reqIdRef.current) return;
        const out = (tr.translation || "").trim();
        if (!out) {
          setTranslation("");
          setError(
            `译文为空（引擎：${tr.provider || provider}）。请确认设置里已保存引擎，或换 Bing / 大模型后重试`,
          );
          return;
        }
        setTranslation(out);
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
      translateMaxLength,
      translateProvider,
      translateSource,
      translateTarget,
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

  /** Phrase/sentence selection: update 原文 + 译文 (not for single words). */
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

  /** Bottom search / single-word PDF selection: dictionary only. */
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
      // Single English word → dictionary only; keep 原文 / 译文 unchanged.
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

  return (
    <div className="literature-layout">
      <PdfPane
        visible={visible}
        onTextSelected={onTextSelected}
        translateProvider={translateProvider}
        model={model}
        onOpenImageOcr={onOpenImageOcr}
      />
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
