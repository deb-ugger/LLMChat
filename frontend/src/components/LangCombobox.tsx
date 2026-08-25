import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterLangOptions, type LangOption } from "../languages";

type Props = {
  label: string;
  value: string;
  onChange: (code: string) => void | Promise<void>;
  onSaved?: () => void;
  allowAuto?: boolean;
  compact?: boolean;
};

export function LangCombobox({
  label,
  value,
  onChange,
  onSaved,
  allowAuto = true,
  compact = false,
}: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const focusedRef = useRef(false);
  const pendingSavedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);

  useEffect(() => {
    valueRef.current = value;
    setQuery(value);
  }, [value]);

  const options = useMemo(
    () => filterLangOptions(query, allowAuto),
    [allowAuto, query],
  );

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setQuery(valueRef.current);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const commitValue = async (code: string) => {
    const previous = valueRef.current;
    if (code === previous) {
      setQuery(previous);
      setOpen(false);
      return;
    }

    setQuery(code);
    setOpen(false);
    try {
      await onChange(code);
      if (focusedRef.current) {
        pendingSavedRef.current = true;
      } else {
        onSaved?.();
      }
    } catch {
      setQuery(previous);
    }
  };

  const pick = (opt: LangOption) => {
    void commitValue(opt.code);
  };

  const restoreValue = () => {
    setQuery(valueRef.current);
    setOpen(false);
  };

  return (
    <div
      className={`lang-combobox${compact ? " is-compact" : ""}`}
      ref={rootRef}
    >
      <span className="lang-combobox-label">{label}</span>
      <input
        value={query}
        placeholder={compact ? "语言" : "输入代码或名称筛选，如 zh"}
        autoComplete="off"
        aria-controls={listId}
        aria-expanded={open}
        onFocus={() => {
          focusedRef.current = true;
          setQuery(valueRef.current);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const trimmed = query.trim();
            e.preventDefault();
            if (options[0]) {
              pick(options[0]);
            } else if (trimmed && (allowAuto || trimmed.toLowerCase() !== "auto")) {
              void commitValue(trimmed);
            } else {
              restoreValue();
            }
          }
          if (e.key === "Escape") restoreValue();
        }}
        onBlur={() => {
          focusedRef.current = false;
          restoreValue();
          if (pendingSavedRef.current) {
            pendingSavedRef.current = false;
            onSaved?.();
          }
        }}
      />
      {open && (
        <ul id={listId} className="lang-combobox-list" role="listbox">
          {options.length === 0 ? (
            <li className="lang-combobox-empty">无匹配项，按 Enter 确认自定义代码</li>
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
