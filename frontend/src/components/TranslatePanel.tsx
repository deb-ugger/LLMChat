import { useCallback, useRef, useState } from "react";
import type { DictionaryEntry } from "../api";

type Props = {
  width?: number;
  source: string;
  translation: string;
  loading: boolean;
  error: string | null;
  dict: DictionaryEntry | null;
  dictHint: string | null;
  dictLoading?: boolean;
  onSourceChange: (text: string) => void;
  onRetranslate: () => void;
  /** Bottom box: dictionary only (must not rewrite 原文). */
  onDictLookup: (word: string) => void;
};

async function copyText(text: string) {
  const t = text.trim();
  if (!t) return false;
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = t;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
  }
}

function pickPhonetics(entry: DictionaryEntry | null) {
  if (!entry) {
    return {
      us: null as string | null,
      uk: null as string | null,
      usAudio: null as string | null,
      ukAudio: null as string | null,
    };
  }
  let us: string | null = null;
  let uk: string | null = null;
  let usAudio: string | null = null;
  let ukAudio: string | null = null;
  for (const p of entry.phonetics) {
    const audio = p.audio || "";
    const text = p.text || "";
    if (
      audio.includes("-us") ||
      audio.includes("_us") ||
      audio.includes("type=2")
    ) {
      us = text || us;
      usAudio = audio || usAudio;
    } else if (
      audio.includes("-uk") ||
      audio.includes("_uk") ||
      audio.includes("-gb") ||
      audio.includes("type=1")
    ) {
      uk = text || uk;
      ukAudio = audio || ukAudio;
    } else if (text && !us) {
      us = text;
      if (audio) usAudio = audio;
    } else if (text && !uk) {
      uk = text;
      if (audio) ukAudio = audio;
    }
  }
  if (!us && entry.phonetics[0]?.text) us = entry.phonetics[0].text;
  if (!usAudio) {
    const firstAudio = entry.phonetics.find((p) => p.audio)?.audio;
    if (firstAudio) usAudio = firstAudio;
  }
  return { us, uk, usAudio, ukAudio };
}

export function TranslatePanel({
  width,
  source,
  translation,
  loading,
  error,
  dict,
  dictHint,
  dictLoading = false,
  onSourceChange,
  onRetranslate,
  onDictLookup,
}: Props) {
  const [manual, setManual] = useState("");
  const [copiedKey, setCopiedKey] = useState<null | "dst" | "src">(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const phonetics = pickPhonetics(dict);

  const play = (url: string | null) => {
    if (!url) return;
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = url;
    void audioRef.current.play().catch(() => undefined);
  };

  const onCopy = useCallback(async (key: "dst" | "src", text: string) => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopiedKey(key);
    // Drop focus so the button does not stay "stuck" visible after mouse leave.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.setTimeout(() => {
      setCopiedKey((cur) => (cur === key ? null : cur));
    }, 1500);
  }, []);

  const synonyms = Array.from(
    new Set(
      (dict?.meanings ?? []).flatMap((m) => m.synonyms ?? []).slice(0, 12),
    ),
  );

  return (
    <aside
      className="translate-panel"
      style={width != null ? { width } : undefined}
    >
      <div className="translate-panel-body">
        <section className="tr-block">
          <h3>【译文】</h3>
          {loading ? (
            <p className="hint">翻译中…</p>
          ) : error ? (
            <pre className="boot-error boot-error-full">{error}</pre>
          ) : (
            <div className="tr-box">
              <button
                type="button"
                className="tr-copy-btn"
                disabled={!translation.trim()}
                onClick={() => void onCopy("dst", translation)}
                title="复制译文"
              >
                {copiedKey === "dst" ? "已复制" : "复制文本"}
              </button>
              <p className="tr-text">
                {translation || "在左侧 PDF 中拖选英文后显示译文"}
              </p>
            </div>
          )}
        </section>

        <section className="tr-block">
          <div className="tr-block-head">
            <h3>【原文】（可编辑）</h3>
            <div className="tr-block-head-actions">
              <button
                type="button"
                className="pdf-tool-btn"
                disabled={loading || !source.trim()}
                onClick={onRetranslate}
                title="根据当前原文重新翻译"
              >
                重新翻译
              </button>
            </div>
          </div>
          <div className="tr-box">
            <button
              type="button"
              className="tr-copy-btn"
              disabled={!source.trim()}
              onClick={() => void onCopy("src", source)}
              title="复制原文"
            >
              {copiedKey === "src" ? "已复制" : "复制文本"}
            </button>
            <textarea
              className="tr-source-edit"
              value={source}
              placeholder="选中 PDF 文本将填入此处，也可手动修改后点「重新翻译」"
              onChange={(e) => onSourceChange(e.target.value)}
              rows={8}
            />
          </div>
        </section>

        <section className="tr-block">
          <h3>【词典】</h3>
          {dictLoading && <p className="hint">词典查询中…</p>}
          {dictHint && <p className="hint">{dictHint}</p>}
          {!dict && !dictHint && !dictLoading && (
            <p className="hint">
              选中单词只查词典；选中句子才会更新原文并翻译
            </p>
          )}
          {dict && (
            <div className="dict-entry">
              <div className="dict-word">{dict.word}</div>
              <div className="dict-phonetics">
                {phonetics.us && (
                  <button
                    type="button"
                    className="phonetic-btn"
                    onClick={() => play(phonetics.usAudio)}
                    title="美式发音"
                  >
                    美 {phonetics.us}
                    {phonetics.usAudio ? " ▶" : ""}
                  </button>
                )}
                {phonetics.uk && (
                  <button
                    type="button"
                    className="phonetic-btn"
                    onClick={() => play(phonetics.ukAudio)}
                    title="英式发音"
                  >
                    英 {phonetics.uk}
                    {phonetics.ukAudio ? " ▶" : ""}
                  </button>
                )}
                {!phonetics.uk && phonetics.usAudio && !phonetics.us && (
                  <button
                    type="button"
                    className="phonetic-btn"
                    onClick={() => play(phonetics.usAudio)}
                  >
                    发音 ▶
                  </button>
                )}
              </div>
              {dict.meanings.map((m, i) => (
                <div key={`${m.partOfSpeech}-${i}`} className="dict-meaning">
                  <div className="dict-pos">{m.partOfSpeech}</div>
                  <ol>
                    {m.definitions.slice(0, 8).map((d, j) => (
                      <li key={j}>
                        {d.definition}
                        {d.example && (
                          <div className="dict-example">例：{d.example}</div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              {(dict.examples?.length ?? 0) > 0 && (
                <div className="dict-examples">
                  <strong>双语例句：</strong>
                  <ul>
                    {dict.examples!.slice(0, 5).map((ex, i) => (
                      <li key={i}>
                        <div className="dict-example-en">{ex.en}</div>
                        {ex.zh ? (
                          <div className="dict-example-zh">{ex.zh}</div>
                        ) : null}
                        {ex.source ? (
                          <div className="dict-example-src">{ex.source}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {synonyms.length > 0 && (
                <div className="dict-syn">
                  <strong>同近义词：</strong>
                  {synonyms.join("、")}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <form
        className="translate-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          const q = manual.trim();
          if (q) onDictLookup(q);
        }}
      >
        <input
          value={manual}
          placeholder="输入单词查词典（不改动上方原文）"
          onChange={(e) => setManual(e.target.value)}
          enterKeyHint="search"
        />
        <button
          type="submit"
          className="send-btn translate-lookup-btn"
          disabled={!manual.trim() || dictLoading}
        >
          查询
        </button>
      </form>
    </aside>
  );
}
