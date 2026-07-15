import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterLangOptions, type LangOption } from "../languages";

type Props = {
  label: string;
  value: string;
  onChange: (code: string) => void;
};

export function LangCombobox({ label, value, onChange }: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  const options = useMemo(() => filterLangOptions(query), [query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (opt: LangOption) => {
    onChange(opt.code);
    setQuery(opt.code);
    setOpen(false);
  };

  return (
    <div className="lang-combobox" ref={rootRef}>
      <span className="lang-combobox-label">{label}</span>
      <input
        value={query}
        placeholder="输入代码或名称筛选，如 zh"
        autoComplete="off"
        aria-controls={listId}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && options[0]) {
            e.preventDefault();
            pick(options[0]);
          }
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => {
          const trimmed = query.trim();
          if (trimmed && trimmed !== value) onChange(trimmed);
        }}
      />
      {open && (
        <ul id={listId} className="lang-combobox-list" role="listbox">
          {options.length === 0 ? (
            <li className="lang-combobox-empty">无匹配项，回车/失焦可用自定义代码</li>
          ) : (
            options.map((opt) => (
              <li key={opt.code}>
                <button
                  type="button"
                  className={
                    opt.code === value
                      ? "lang-combobox-option active"
                      : "lang-combobox-option"
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt)}
                >
                  <span className="lang-code">{opt.code}</span>
                  <span className="lang-label">{opt.label}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
