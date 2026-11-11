import { useLayoutEffect, useRef, type CSSProperties, type TextareaHTMLAttributes } from "react";
import "./SearchHighlight.css";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const source = text.toLowerCase(), needle = query.toLowerCase();
  const parts = [];
  let start = 0, found = source.indexOf(needle);
  while (found !== -1) {
    parts.push(text.slice(start, found), <mark className="search-match" key={found}>{text.slice(found, found + query.length)}</mark>);
    start = found + query.length;
    found = source.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

// Keep the native editor and its selection; only the matching background is mirrored.
export function SearchTextarea({ query, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { query: string; value: string }) {
  const editor = useRef<HTMLTextAreaElement>(null), mirror = useRef<HTMLDivElement>(null);
  const matching = !!query && props.value.toLowerCase().includes(query.toLowerCase());
  useLayoutEffect(() => {
    if (!matching || !editor.current || !mirror.current) return;
    const input = editor.current, backdrop = mirror.current;
    const sync = () => {
      const style = getComputedStyle(input);
      for (const name of ["font", "line-height", "letter-spacing", "text-align", "text-indent", "tab-size", "padding", "border-width", "border-style", "word-break", "overflow-wrap"]) {
        backdrop.style.setProperty(name, style.getPropertyValue(name));
      }
      Object.assign(backdrop.style, { top: `${input.offsetTop}px`, left: `${input.offsetLeft}px`, width: `${input.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`, height: `${input.offsetHeight}px` });
      backdrop.scrollTop = input.scrollTop;
      backdrop.scrollLeft = input.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener("scroll", sync);
    return () => { observer.disconnect(); input.removeEventListener("scroll", sync); };
  }, [matching, props.value, query]);
  return <span className={`search-editor${matching ? " has-search-match" : ""}`}>
    {matching && <div className="search-editor-mirror" ref={mirror} aria-hidden="true" style={{ color: "transparent" } as CSSProperties}><SearchHighlight text={props.value + "\n"} query={query} /></div>}
    <textarea {...props} ref={editor} />
  </span>;
}
