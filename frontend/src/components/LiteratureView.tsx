import { useCallback, useEffect, useRef, useState } from "react";
import { api, lookupDictionary, type DictionaryEntry } from "../api";
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
  model: string;
};

export function LiteratureView({ visible, translateProvider, model }: Props) {
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

  const translateOnly = useCallback(async (text: string, reqId: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);
    try {
      const tr = await api.translate(trimmed, { signal: ac.signal });
      if (reqId !== reqIdRef.current) return;
      setTranslation(tr.translation);
    } catch (err) {
      if (ac.signal.aborted || reqId !== reqIdRef.current) return;
      setTranslation("");
      const anyErr = err as Error & { code?: string };
      if (anyErr.code === "LENGTH_LIMIT") {
        setError(anyErr.message);
      } else if (
        anyErr.code === "NETWORK_TIMEOUT" ||
        /timeout|network|failed to fetch|网络/i.test(anyErr.message)
      ) {
        setError("翻译超时或网络异常，请检查网络状况后重试。");
      } else {
        setError(anyErr.message || String(err));
      }
    } finally {
      if (reqId === reqIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

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
        onTextSelected={(t) => void runLookup(t)}
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
