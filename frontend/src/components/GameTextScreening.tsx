import { useMemo, type TextareaHTMLAttributes } from "react";
import { gameTextScreeningResult } from "../gameDisplayText";
import { SearchHighlight, SearchTextarea } from "./SearchHighlight";

type ScreeningProps = { source: string; target: string; sourceLanguage?: string; locale?: string; skipTarget?: boolean; screened: boolean; completed?: boolean };
export function GameTextScreenedSource({ source, target, sourceLanguage = "auto", locale, skipTarget = true, screened, completed = false, query }: ScreeningProps & { query: string }) {
  const result = useMemo(() => screened ? gameTextScreeningResult(source, target, sourceLanguage, skipTarget, locale) : null, [screened, source, target, sourceLanguage, skipTarget, locale]);
  if (completed || !result?.structured) return <SearchHighlight text={source} query={query} />;
  return <ScreenedText text={source} retained={result.retained} query={query} />;
}
function ScreenedText({ text, retained, query }: { text: string; retained: { start: number; end: number }[]; query: string }) {
  let offset = 0; const parts = [];
  for (const span of retained) {
    if (span.start > offset) parts.push(<span key={`pending-${offset}`} className="game-text-pending"><SearchHighlight text={text.slice(offset, span.start)} query={query} /></span>);
    parts.push(<SearchHighlight key={`keep-${span.start}`} text={text.slice(span.start, span.end)} query={query} />); offset = span.end;
  }
  if (offset < text.length) parts.push(<span key={`pending-${offset}`} className="game-text-pending"><SearchHighlight text={text.slice(offset)} query={query} /></span>);
  return <>{parts}</>;
}
export function GameTextScreenedEditor({ screeningDraft, screening, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { query: string; value: string; screeningDraft?: string; screening?: ScreeningProps }) {
  const value = props.value || screeningDraft || "";
  const result = useMemo(() => !props.value && screeningDraft && screening?.screened
    ? gameTextScreeningResult(screening.source, screening.target, screening.sourceLanguage, screening.skipTarget, screening.locale) : null,
    [props.value, screeningDraft, screening?.source, screening?.target, screening?.sourceLanguage, screening?.skipTarget, screening?.locale, screening?.screened]);
  const backdropContent = result?.structured ? <><ScreenedText text={value} retained={result.retained} query={props.query} />{"\n"}</> : undefined;
  const rows = Math.max(props.rows || 1, Math.min(8, value.split(/\r\n|\r|\n/).length));
  return <SearchTextarea {...props} rows={rows} value={value} backdropContent={backdropContent} />;
}
