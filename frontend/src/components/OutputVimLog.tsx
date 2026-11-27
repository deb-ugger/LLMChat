import { useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from "react";
import { Annotation, Compartment, EditorState, type Range, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, drawSelection } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { formatOutputTime, outputStatusLabel, type OutputRow } from "../appOutput";

export type OutputVimLogHandle = { focus: () => void };
type Props = {
  ref: Ref<OutputVimLogHandle>;
  rows: readonly OutputRow[];
  targetId?: string;
  searchOpen: boolean;
  query: string;
  matchId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
};

const closeDrawers = new WeakMap<EditorView, () => void>();
const logRefresh = Annotation.define<boolean>();
Vim.defineEx("quit", "q", cm => closeDrawers.get(cm.cm6)?.());

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--fs-body)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "1.35", overflowAnchor: "none", scrollBehavior: "auto" },
  ".cm-content": { padding: "0" },
  ".cm-line": { padding: "2px 6px" },
  ".cm-searchMatch": { backgroundColor: "#fce9a6", color: "#202d29" },
  ".cm-searchMatch-selected": { backgroundColor: "#f3cb64" },
  ".cm-vim-panel": { backgroundColor: "var(--bg-muted)", color: "var(--text)" },
  "&.cm-focused": { outline: "1px solid var(--accent)", outlineOffset: "-1px" },
});

function createDocument(rows: readonly OutputRow[]) {
  let offset = 0;
  const marks: Range<Decoration>[] = [];
  const byId = new Map<string, number>();
  const records = rows.map(row => {
    const time = formatOutputTime(row.time);
    const prefix = time.padEnd(23) + " ";
    const label = outputStatusLabel(row.level);
    const value = (prefix + (label ? `[${label}] ` : "") + row.text).replace(/\r\n?/g, "\n");
    const from = offset;
    byId.set(row.id, from);
    if (time.length) marks.push(Decoration.mark({ class: "output-vim-time" }).range(from, from + time.length));
    if (label) {
      marks.push(Decoration.mark({ class: "global-output-level output-vim-" + row.level })
        .range(from + prefix.length, from + prefix.length + label.length + 2));
    }
    offset += value.length + 1;
    return { id: row.id, from, value };
  });
  return { records, byId, text: records.map(record => record.value).join("\n"), marks };
}
type LogDocument = ReturnType<typeof createDocument>;

function recordAt(model: LogDocument, position: number) {
  let first = 0, end = model.records.length;
  while (first < end) {
    const middle = (first + end) >>> 1;
    if (model.records[middle].from <= position) first = middle + 1;
    else end = middle;
  }
  return model.records[first - 1];
}

function decorations(model: LogDocument, query: string, matchId?: string) {
  if (!query) return Decoration.set(model.marks);
  const marks = [...model.marks];
  const needle = query.toLowerCase();
  for (const { id, from, value } of model.records) {
    const source = value.toLowerCase();
    if (id === matchId) marks.push(Decoration.line({ class: "output-vim-match-row" }).range(from));
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
      if (at + needle.length <= value.length) marks.push(Decoration.mark({ class: "search-match" })
        .range(from + at, from + at + needle.length));
    }
  }
  return Decoration.set(marks, true);
}

function updateDocument(previous: LogDocument, next: LogDocument): TransactionSpec["changes"] {
  const first = next.records[0];
  if (!first) return { from: 0, to: previous.text.length };
  const start = previous.byId.get(first.id);
  const overlap = start === undefined ? "" : previous.text.slice(start);
  if (start !== undefined && (next.text === overlap || next.text.startsWith(overlap + "\n"))) {
    return [
      { from: 0, to: start },
      { from: previous.text.length, insert: next.text.slice(overlap.length) },
    ];
  }
  return { from: 0, to: previous.text.length, insert: next.text };
}

export default function OutputVimLog(props: Props) {
  const { ref, rows, targetId, query, matchId } = props;
  const model = useMemo(() => createDocument(rows), [rows]);
  const marks = useMemo(() => decorations(model, query, matchId), [model, query, matchId]);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const styles = useRef(new Compartment());
  const displayed = useRef(model);
  const displayedMarks = useRef<ReturnType<typeof decorations> | null>(null);
  const current = useRef({ props, model, marks });
  const synchronizing = useRef(false);
  current.current = { props, model, marks };
  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);

  useLayoutEffect(() => {
    const initial = current.current;
    displayed.current = initial.model;
    const view = new EditorView({
      parent: host.current!,
      doc: initial.model.text,
      selection: { anchor: initial.model.byId.get(initial.props.targetId ?? "") ?? 0 },
      extensions: [
        vim(), drawSelection(), theme, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping,
        EditorState.changeFilter.of(transaction => !transaction.docChanged || transaction.annotation(logRefresh) === true),
        styles.current.of(EditorView.decorations.of(initial.marks)),
        EditorView.contentAttributes.of({ "aria-label": "运行记录", "aria-readonly": "true", tabindex: "0" }),
        EditorView.updateListener.of(update => {
          if (synchronizing.current || !update.selectionSet) return;
          const id = recordAt(displayed.current, update.state.selection.main.head)?.id;
          if (id && id !== current.current.props.targetId) current.current.props.onSelect(id);
        }),
      ],
    });
    editor.current = view;
    closeDrawers.set(view, () => current.current.props.onClose());
    const scroller = view.scrollDOM;
    let viewportHeight = scroller.clientHeight;
    let visibleBottom = scroller.scrollTop + viewportHeight;
    const rememberBottom = () => {
      // A resize can queue a native scroll event before the resize observer.
      if (scroller.clientHeight === viewportHeight) visibleBottom = scroller.scrollTop + viewportHeight;
    };
    scroller.addEventListener("scroll", rememberBottom, { passive: true });
    const resize = new ResizeObserver(() => {
      const height = scroller.clientHeight;
      if (height === viewportHeight) return;
      const top = Math.max(0, Math.min(visibleBottom - height, scroller.scrollHeight - height));
      scroller.scrollTop = top;
      viewportHeight = height;
      visibleBottom = top + height;
    });
    resize.observe(scroller);
    if (!initial.props.searchOpen) view.focus();
    return () => {
      resize.disconnect();
      scroller.removeEventListener("scroll", rememberBottom);
      closeDrawers.delete(view);
      editor.current = null;
      displayedMarks.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = editor.current!;
    const previous = displayed.current;
    const documentChanged = previous !== model;
    const firstRefresh = displayedMarks.current === null;
    const marksChanged = displayedMarks.current !== marks;
    const selection = view.state.selection.main;
    const selectedRecord = recordAt(previous, selection.head);
    const cursorChanged = selectedRecord?.id !== targetId;
    if (!documentChanged && !marksChanged && !cursorChanged) return;
    const start = model.byId.get(targetId ?? "") ?? 0;
    const headOffset = !cursorChanged && selectedRecord ? selection.head - selectedRecord.from : 0;
    const head = Math.min(model.text.length, start + headOffset);
    const anchorRecord = !cursorChanged && recordAt(previous, selection.anchor);
    const anchorStart = anchorRecord ? model.byId.get(anchorRecord.id) : undefined;
    const anchor = anchorRecord && anchorStart !== undefined
      ? Math.min(model.text.length, anchorStart + selection.anchor - anchorRecord.from) : head;
    displayed.current = model;
    displayedMarks.current = marks;
    synchronizing.current = true;
    try {
      view.dispatch({
        changes: documentChanged ? updateDocument(previous, model) : undefined,
        annotations: logRefresh.of(true),
        selection: documentChanged || cursorChanged ? { anchor, head } : undefined,
        effects: [styles.current.reconfigure(EditorView.decorations.of(marks)),
          ...(firstRefresh || documentChanged || cursorChanged ? [EditorView.scrollIntoView(head, { y: "nearest" })] : [])],
      });
    } finally { synchronizing.current = false; }
  }, [model, marks, targetId]);

  return <div ref={host} className="output-vim-editor" role="log" aria-label="运行记录"
    data-tooltip={'Vim · 10j 跳行，V 选整行，"+yy 复制到剪贴板，/ 搜索本页，Ctrl+F 搜索全部日志，:q 收起输出'} />;
}
