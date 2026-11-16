import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import "./SearchableSelect.css";

type Choice = { value: string; label: string; group: string; disabled: boolean };
type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size"> & { optionTags?: Readonly<Record<string, readonly string[] | undefined>>; displayValue?:string; placeholder?: string; emptyLabel?: string };
type OptionProps = { value?: string | number; label?: string; disabled?: boolean; children?: ReactNode };
const names = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function ChoiceTags({ tags }: { tags?: readonly string[] }) {
  if (!tags?.length) return null;
  return <span className="searchable-select-tags">
    {tags.map(tag => <span key={tag} className="searchable-select-tag">{tag}</span>)}
  </span>;
}

function optionText(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<OptionProps>(child) ? optionText(child.props.children) : String(child)).join("");
}

function readChoices(children: ReactNode, group = "", disabled = false): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === Fragment) return readChoices(child.props.children, group, disabled);
    if (child.type === "optgroup") return readChoices(child.props.children, child.props.label || "", disabled || !!child.props.disabled);
    if (child.type !== "option") return [];
    const text = optionText(child.props.children);
    const value = String(child.props.value ?? text);
    if (!value.trim()) return [];
    return [{ value, label: child.props.label || text, group, disabled: disabled || !!child.props.disabled }];
  });
}

/** Keep native select change events so existing settings and task handlers keep their behavior. */
export function SearchableSelect({ children, className, style, disabled, value, defaultValue, id, title, optionTags, displayValue, placeholder = "请选择", emptyLabel = "没有可用选项", ...props }: Props) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const choices = useMemo(() => [...new Map(readChoices(children).map(choice => [choice.value, choice])).values()].sort((a, b) => names.compare(a.label, b.label) || names.compare(a.value, b.value)), [children]);
  const hasChoices = choices.some(choice => !choice.disabled);
  const unavailable = disabled || !hasChoices;
  const selectedValue = String(value ?? defaultValue ?? "");
  const selected = choices.find(choice => choice.value === selectedValue);
  const selectedTags = selected && optionTags?.[selected.value];
  const showCaption = !open && selected && !selected.disabled && !!selectedTags?.length;
  const words = (query || "").trim().normalize("NFKC").toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = choices.filter(choice => {
    const text = `${choice.label} ${choice.value} ${choice.group} ${optionTags?.[choice.value]?.join(" ") || ""}`.normalize("NFKC").toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
  const close = useCallback(() => { menu.current?.hidePopover(); setOpen(false); setQuery(null); }, []);
  const position = useCallback(() => {
    if (!root.current || !menu.current) return;
    const rect = root.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upwards = below < 240 && above > below;
    Object.assign(menu.current.style, {
      width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      top: upwards ? "auto" : `${rect.bottom + 4}px`, bottom: upwards ? `${window.innerHeight - rect.top + 4}px` : "auto",
      maxHeight: `${Math.max(40, Math.min(360, upwards ? above : below))}px`,
    });
  }, []);
  const show = () => {
    if (input.current?.matches(":disabled")) return;
    setQuery("");
    const index = choices.findIndex(choice => choice.value === selectedValue && !choice.disabled);
    setActive(index >= 0 ? index : choices.findIndex(choice => !choice.disabled));
    position(); menu.current?.showPopover(); setOpen(true);
  };
  const choose = (choice: Choice) => {
    if (choice.disabled || input.current?.matches(":disabled") || !native.current) return;
    if (selectedValue !== choice.value) {
      native.current.value = choice.value;
      native.current.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
  };
  useEffect(() => { if (unavailable) close(); }, [unavailable, close]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, close, position]);
  useEffect(() => {
    const list = menu.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !list || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, active, query]);
  return <div ref={root} className={`searchable-select${className ? ` ${className}` : ""}`} style={style}>
    <input ref={input} id={id} className="searchable-select-input" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
      aria-activedescendant={open && active >= 0 && filtered[active] ? `${listId}-${active}` : undefined}
      aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]} disabled={unavailable} autoFocus={props.autoFocus}
      data-tooltip={title || selected?.label || displayValue} autoComplete="off" spellCheck={false} placeholder={hasChoices ? selected?.label || placeholder : emptyLabel}
      value={query ?? (selected && !selected.disabled ? selected.label : displayValue || "")}
      onFocus={show} onClick={() => { if (!open) show(); }}
      onChange={event => { setQuery(event.target.value); setActive(0); if (!open) { position(); menu.current?.showPopover(); setOpen(true); } }}
      onBlur={close}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Enter" && open) { event.preventDefault(); event.stopPropagation(); if (filtered[active]) choose(filtered[active]); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) { show(); return; }
          const direction = event.key === "ArrowDown" ? 1 : -1;
          let next = active;
          do { next += direction; } while (next >= 0 && next < filtered.length && filtered[next].disabled);
          if (next >= 0 && next < filtered.length) setActive(next);
        }
      }} />
    {showCaption && <span className="searchable-select-caption" aria-hidden="true">
      <span className="searchable-select-caption-title">{selected.label}</span>
      <ChoiceTags tags={selectedTags} />
    </span>}
    <button type="button" className="searchable-select-caret" disabled={unavailable} tabIndex={-1} aria-label="展开选项"
      onPointerDown={event => event.preventDefault()} onClick={() => { if (open) close(); else { input.current?.focus(); show(); } }}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
    </button>
    <select {...props} ref={native} value={value} defaultValue={defaultValue} disabled={unavailable} hidden tabIndex={-1} aria-hidden="true">{children}</select>
    <div ref={menu} id={listId} className="searchable-select-menu" popover="manual" role="listbox" aria-label={props["aria-label"] || "可选项"}>
      {open && (filtered.length ? filtered.map((choice, index) => <button key={choice.value} id={`${listId}-${index}`} data-index={index} type="button" role="option"
        aria-selected={choice.value === selectedValue} disabled={choice.disabled} data-tooltip={choice.label} aria-label={choice.label}
        className={`searchable-select-option${index === active ? " is-active" : ""}`}
        onPointerDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)}
        onClick={event => { event.preventDefault(); choose(choice); }}>
        <span>{choice.label}</span>{choice.group && <small>{choice.group}</small>}
        <ChoiceTags tags={optionTags?.[choice.value]} />
      </button>) : <div className="searchable-select-empty">无匹配项</div>)}
    </div>
  </div>;
}
