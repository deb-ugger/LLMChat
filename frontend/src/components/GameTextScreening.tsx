import { useMemo, useState, type TextareaHTMLAttributes } from "react";
import { gameTextScreeningResult } from "../gameDisplayText";
import type { DialogueRepair, DialogueRepairPreview } from "../gameTextProject";
import { SearchHighlight, SearchTextarea } from "./SearchHighlight";

type ScreeningProps = { source: string; target: string; sourceLanguage?: string; locale?: string; skipTarget?: boolean; screened: boolean; completed?: boolean };
export function GameTextScreenedSource({ source, target, sourceLanguage = "auto", locale, skipTarget = true, screened, completed = false, query, repairs }: ScreeningProps & { query: string; repairs?: DialogueRepair[] }) {
  const result = useMemo(() => screened ? gameTextScreeningResult(source, target, sourceLanguage, skipTarget, locale) : null, [screened, source, target, sourceLanguage, skipTarget, locale]);
  if (repairs?.length) return <RepairText text={source} query={query} repairs={repairs} />;
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
export function GameTextScreenedEditor({ screeningDraft, screening, repairs, repairPreview, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { query: string; value: string; screeningDraft?: string; screening?: ScreeningProps; repairs?: DialogueRepair[]; repairPreview?: DialogueRepairPreview }) {
  const [editing, setEditing] = useState(false);
  const validPreview = repairPreview?.input === props.value ? repairPreview : undefined;
  const showingPreview = !!validPreview && !editing;
  const value = (showingPreview ? validPreview.text : props.value) || screeningDraft || "";
  const result = useMemo(() => !props.value && screeningDraft && screening?.screened
    ? gameTextScreeningResult(screening.source, screening.target, screening.sourceLanguage, screening.skipTarget, screening.locale) : null,
    [props.value, screeningDraft, screening?.source, screening?.target, screening?.sourceLanguage, screening?.skipTarget, screening?.locale, screening?.screened]);
  const backdropContent = repairs?.length && value ? <><RepairText text={value} query={props.query} repairs={repairs} corrected={showingPreview} />{"\n"}</> :
    result?.structured ? <><ScreenedText text={value} retained={result.retained} query={props.query} />{"\n"}</> : undefined;
  const rows = Math.max(props.rows || 1, Math.min(8, value.split(/\r\n|\r|\n/).length));
  const editor = <SearchTextarea {...props} aria-label={showingPreview ? props["aria-label"] + "补丁预览" : props["aria-label"]}
    readOnly={showingPreview || props.readOnly} className={repairs?.length && !value ? [props.className, "game-dialogue-repair-empty"].filter(Boolean).join(" ") : props.className}
    rows={rows} value={value} backdropContent={backdropContent} />;
  if (!validPreview) return editor;
  return <div className="game-dialogue-preview-editor">
    {editor}
    <div className="game-dialogue-preview-tools">
      <span>{showingPreview ? "补丁写入预览" : "原译文"}</span>
      <button type="button" disabled={props.disabled} onClick={() => setEditing(value => !value)}>{showingPreview ? "编辑译文" : "查看预览"}</button>
    </div>
  </div>;
}

const repairPatterns: Record<DialogueRepair, RegExp> = {
  position: /(?<=^|\n)[ \t]*(?:p[xy]\[[0-9]{1,5}\](?=[\u3000-\uFFFF]|\\)|\\p[xy]\[(?:[0-9]-[0-9]{2}\]|[0-9]{1,4}(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])))/giu,
  continuation: /(?<=\n)(?:吗|嗎|呢|吧|呀|か|ね|よ)[!?！？。]+(?=\r?$|\r?\n)/gu,
  alignment: /(?<=\n)[ \t]*(?![ \t\\\r\n])[^\\\r\n][^\r\n]*/gu,
  name: /(?:\\(?:nc|nr|n[1-5]?)<[^<>\r\n]+(?:\r?\n[ \t]*)?>|nc<[^<>\r\n]+>|^<[^<>\r\n]+>$|\\nc(?=[ \t]*$)|\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n]+(?=\r?$))/gim,
};
const previewPatterns = { ...repairPatterns,
  position: /(?<=^|\n)[ \t]*\\p[xy]\[[0-9]+\]/gi,
  continuation: /(?:吗|嗎|呢|吧|呀|か|ね|よ)[!?！？。]+(?=\r?$)/gmu,
  alignment: /(?<=\n)[ \t]*\\px\[[0-9]+\]/gi,
};
function RepairText({ text, query, repairs, corrected = false }: { text: string; query: string; repairs: DialogueRepair[]; corrected?: boolean }) {
  const patterns = corrected ? previewPatterns : repairPatterns;
  const matches = repairs.flatMap(kind => [...text.matchAll(patterns[kind])]).sort((a, b) => a.index - b.index);
  if (!matches.length) return <mark className="game-dialogue-repair"><SearchHighlight text={text} query={query} /></mark>;
  let offset = 0;
  const parts = [];
  for (const match of matches) {
    if (match.index < offset) continue;
    parts.push(<SearchHighlight key={"before-" + match.index} text={text.slice(offset, match.index)} query={query} />);
    parts.push(<mark className="game-dialogue-repair" key={match.index}>{match[0]}</mark>);
    offset = match.index + match[0].length;
  }
  return <>{parts}<SearchHighlight text={text.slice(offset)} query={query} /></>;
}
