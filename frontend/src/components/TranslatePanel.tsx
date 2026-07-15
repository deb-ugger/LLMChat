import { useEffect, useRef, useState } from "react";
import type { DictionaryEntry } from "../api";

type Props = {
  width?: number;
  source: string;
  translation: string;
  loading: boolean;
  error: string | null;
  dict: DictionaryEntry | null;
  dictHint: string | null;
  onSourceChange: (text: string) => void;
  onRetranslate: () => void;
  onLookup: (word: string) => void;
};

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
    if (audio.includes("-us") || audio.includes("_us")) {
      us = text || us;
      usAudio = audio || usAudio;
    } else if (
      audio.includes("-uk") ||
      audio.includes("_uk") ||
      audio.includes("-gb")
    ) {
      uk = text || uk;
      ukAudio = audio || ukAudio;
    } else if (text && !us) {
      us = text;
      if (audio) usAudio = audio;
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
  onSourceChange,
  onRetranslate,
  onLookup,
}: Props) {
  const [manual, setManual] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const phonetics = pickPhonetics(dict);

  useEffect(() => {
    setManual(
      source && /^[A-Za-z'-]+$/.test(source.trim()) ? source.trim() : "",
    );
  }, [source]);

  const play = (url: string | null) => {
    if (!url) return;
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = url;
    void audioRef.current.play().catch(() => undefined);
  };

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
            <p className="boot-error">{error}</p>
          ) : (
            <p className="tr-text">
              {translation || "在左侧 PDF 中拖选英文后显示译文"}
            </p>
          )}
        </section>

        <section className="tr-block">
          <div className="tr-block-head">
            <h3>【原文】（可编辑）</h3>
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
          <textarea
            className="tr-source-edit"
            value={source}
            placeholder="选中 PDF 文本将填入此处，也可手动修改后点「重新翻译」"
            onChange={(e) => onSourceChange(e.target.value)}
            rows={8}
          />
        </section>

        <section className="tr-block">
          <h3>【词典】</h3>
          {dictHint && <p className="hint">{dictHint}</p>}
          {!dict && !dictHint && (
            <p className="hint">选中或输入单个英文单词可查词典</p>
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
                    {m.definitions.slice(0, 3).map((d, j) => (
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

      <div className="translate-lookup">
        <input
          value={manual}
          placeholder="输入单词查词典 / 翻译"
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && manual.trim()) {
              onLookup(manual.trim());
            }
          }}
        />
        <button
          type="button"
          className="send-btn"
          disabled={!manual.trim()}
          onClick={() => manual.trim() && onLookup(manual.trim())}
        >
          查询
        </button>
      </div>
    </aside>
  );
}
