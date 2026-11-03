import { useEffect,useId,useMemo,useRef,useState } from "react";
import {
groupModelPresets,
vendorOfModel,
type ModelPreset
} from "../modelPresets";
function sortByConfigured<T>(
  items: T[],
  isConfigured: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => {
    const ca = isConfigured(a) ? 1 : 0;
    const cb = isConfigured(b) ? 1 : 0;
    return cb - ca;
  });
}

type ConfigStatusKind = "ok" | "warn" | "free" | "pending";

type StatusSelectOption = {
  value: string;
  title: string;
  subtitle?: string;
  status: ConfigStatusKind;
  statusText: string;
};

type StatusSelectGroup = {
  label: string;
  options: StatusSelectOption[];
};

function statusBadgeClass(status: ConfigStatusKind): string {
  return `settings-engine-badge is-${status}`;
}

function StatusSelect({
  label,
  value,
  groups,
  onChange,
  className,
  searchable = false,
}: {
  label?: string;
  value: string;
  groups: StatusSelectGroup[];
  onChange: (value: string) => void;
  className?: string;
  searchable?: boolean;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const flat = useMemo(
    () => groups.flatMap((g) => g.options),
    [groups],
  );
  const selected = flat.find((o) => o.value === value) || flat[0];
  const filteredGroups = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!searchable || !keyword) return groups;
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          [option.value, option.title, option.subtitle || ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(keyword),
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, query, searchable]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  return (
    <div
      className={"status-select" + (className ? ` ${className}` : "")}
      ref={rootRef}
    >
      {label ? <span className="status-select-label">{label}</span> : null}
      <button
        type="button"
        className={"status-select-trigger" + (open ? " is-open" : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) setQuery("");
          setOpen(!open);
        }}
      >
        {selected ? (
          <>
            <em className={statusBadgeClass(selected.status)}>
              {selected.statusText}
            </em>
            <span className="status-select-trigger-text">
              <strong>{selected.title}</strong>
              {selected.subtitle ? (
                <span className="status-select-sub">{selected.subtitle}</span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="status-select-trigger-text">请选择</span>
        )}
        <span className="status-select-caret" aria-hidden />
      </button>
      {open && (
        <div id={listId} className="status-select-menu" role="listbox">
          {searchable ? (
            <div className="status-select-search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={`搜索${label || "选项"}…`}
                aria-label={`搜索${label || "选项"}`}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
            </div>
          ) : null}
          {filteredGroups.length === 0 ? (
            <div className="status-select-empty">没有匹配的选项</div>
          ) : null}
          {filteredGroups.map((g) => (
            <div key={g.label} className="status-select-group">
              <div className="status-select-group-label">{g.label}</div>
              {g.options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  className={
                    "status-select-option" +
                    (opt.value === value ? " is-active" : "")
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <em className={statusBadgeClass(opt.status)}>
                    {opt.statusText}
                  </em>
                  <span className="status-select-option-text">
                    <strong>{opt.title}</strong>
                    {opt.subtitle ? (
                      <span className="status-select-sub">{opt.subtitle}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LOCAL_VENDOR = "本地模型";

function FeatureModelSelect({
  value,
  customModels,
  isConfigured,
  onChange,
  presets,
}: {
  value: string;
  customModels: string[];
  isConfigured: (model: string) => boolean;
  onChange: (model: string) => void;
  presets: ModelPreset[];
}) {
  const vendorList = useMemo(() => {
    const groups = groupModelPresets(presets).map((g) => g.group);
    if (customModels.length > 0) groups.push(LOCAL_VENDOR);
    return groups;
  }, [customModels, presets]);

  const derivedVendor = useMemo(() => {
    const v = vendorOfModel(value, presets);
    if (v) return v;
    if (customModels.includes(value)) return LOCAL_VENDOR;
    return vendorList[0] || LOCAL_VENDOR;
  }, [value, customModels, vendorList, presets]);

  const [vendor, setVendor] = useState(derivedVendor);
  useEffect(() => {
    setVendor(derivedVendor);
  }, [derivedVendor]);

  const isVendorConfigured = (group: string) => {
    if (group === LOCAL_VENDOR) {
      return customModels.some((m) => isConfigured(m));
    }
    return presets
      .filter((p) => p.group === group)
      .some((p) => isConfigured(p.model));
  };

  const modelsForVendor = useMemo(() => {
    if (vendor === LOCAL_VENDOR) {
      return sortByConfigured(customModels, (m) => isConfigured(m)).map(
        (m) => ({ model: m, label: m }),
      );
    }
    return sortByConfigured(
      presets.filter((p) => p.group === vendor),
      (p) => isConfigured(p.model),
    ).map((p) => ({ model: p.model, label: p.label }));
  }, [vendor, customModels, isConfigured, presets]);

  const selectedModel = useMemo(() => {
    if (modelsForVendor.some((m) => m.model === value)) return value;
    return modelsForVendor[0]?.model || value;
  }, [modelsForVendor, value]);

  const vendorGroups = useMemo((): StatusSelectGroup[] => {
    const options = sortByConfigured(vendorList, (g) =>
      isVendorConfigured(g),
    ).map((g) => {
      const count =
        g === LOCAL_VENDOR
          ? customModels.length
          : presets.filter((p) => p.group === g).length;
      const ok = isVendorConfigured(g);
      return {
        value: g,
        title: g,
        subtitle: `${count} 个模型`,
        status: (ok ? "ok" : "warn") as ConfigStatusKind,
        statusText: ok ? "已配置" : "未配置",
      };
    });
    return [{ label: "厂商（已配置优先）", options }];
  }, [vendorList, customModels, isConfigured, presets]);

  const modelGroups = useMemo((): StatusSelectGroup[] => {
    const options = modelsForVendor.map((m) => ({
      value: m.model,
      title: m.label,
      subtitle: m.model,
      status: (isConfigured(m.model) ? "ok" : "warn") as ConfigStatusKind,
      statusText: isConfigured(m.model) ? "已配置" : "未配置",
    }));
    return [
      {
        label: vendor === LOCAL_VENDOR ? "本地模型" : `${vendor} 模型`,
        options,
      },
    ];
  }, [modelsForVendor, vendor, isConfigured]);

  const pickVendor = (nextVendor: string) => {
    setVendor(nextVendor);
    const models =
      nextVendor === LOCAL_VENDOR
        ? sortByConfigured(customModels, (m) => isConfigured(m))
        : sortByConfigured(
            presets.filter((p) => p.group === nextVendor),
            (p) => isConfigured(p.model),
          ).map((p) => p.model);
    if (models[0]) onChange(models[0]);
  };

  return (
    <div className="feature-model-select-row">
      <StatusSelect
        label="厂商"
        className="feature-model-select-half"
        value={vendor}
        groups={vendorGroups}
        onChange={pickVendor}
        searchable
      />
      <StatusSelect
        label="模型"
        className="feature-model-select-half"
        value={selectedModel}
        groups={modelGroups}
        onChange={onChange}
        searchable
      />
    </div>
  );
}
export { FeatureModelSelect, statusBadgeClass, StatusSelect };
export type { ConfigStatusKind };
