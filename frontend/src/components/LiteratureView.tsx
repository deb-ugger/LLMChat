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
}: Props) {
  const [source, setSource] = useState("");
  const [translation, setTranslation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dict, setDict] = useState<DictionaryEntry | null>(null);
  const [dictHint, setDictHint] = useState<string | null>(null);
  const reqIdRef = useRef(0);
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
            ...(provider === "llm"
              ? { apiUrl, apiKey, model }
              : {}),
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

  const fillDict = useCallback(async (trimmed: string, reqId: number) => {
    const isWord = WORD_RE.test(trimmed);
    if (reqId !== reqIdRef.current) return;
    setDict(null);
    if (isWord) {
      try {
        const entry = await lookupDictionary(trimmed);
        if (reqId !== reqIdRef.current) return;
        if (entry) {
          setDict(entry);
          setDictHint(null);
        } else {
          setDictHint("未找到词典义项");
        }
      } catch {
        if (reqId !== reqIdRef.current) return;
        setDictHint("词典服务暂时不可用");
      }
    } else {
      setDictHint("多词/句子仅提供译文；可输入单个单词查词典");
    }
  }, []);

  const runLookup = useCallback(
    async (text: string) => {
      const trimmed = normalizePdfSelectionText(text);
      if (!trimmed) return;

      const reqId = ++reqIdRef.current;
      setSource(trimmed);
      await translateOnly(trimmed, reqId);
      if (reqId !== reqIdRef.current) return;
      await fillDict(trimmed, reqId);
    },
    [fillDict, translateOnly],
  );

  const onTextSelected = useCallback(
    (text: string) => {
      void runLookup(text);
    },
    [runLookup],
  );

  const onRetranslate = useCallback(() => {
    void (async () => {
      const trimmed = normalizePdfSelectionText(source);
      if (!trimmed) return;
      if (trimmed !== source) setSource(trimmed);
      const reqId = ++reqIdRef.current;
      await translateOnly(trimmed, reqId);
      if (reqId !== reqIdRef.current) return;
      await fillDict(trimmed, reqId);
    })();
  }, [fillDict, source, translateOnly]);

  return (
    <div className="literature-layout">
      <PdfPane
        visible={visible}
        onTextSelected={onTextSelected}
        translateProvider={translateProvider}
        model={model}
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
        onSourceChange={setSource}
        onRetranslate={onRetranslate}
        onLookup={(w) => void runLookup(w)}
      />
    </div>
  );
}
