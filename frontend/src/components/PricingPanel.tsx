import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { toFriendlyError } from "../friendlyError";
import {
  DEFAULT_DAY_PARTS,
  DEFAULT_DEEPSEEK_PEAK_WINDOWS,
  DEFAULT_VENDOR_CURRENCIES,
  currentRatesForModel,
  dateInInclusiveRange,
  defaultSubRules,
  defaultVendorCurrency,
  emptyRates,
  ensureSubRules,
  formatPeakWindowsHint,
  formatWeekdaysHint,
  lockNewModels,
  newRuleId,
  newSubRuleId,
  normalizePeakWeekdays,
  normalizePeakWindows,
  parseTimeToMinutes,
  syncLegacyRates,
  type PeakWindow,
  type PricingCurrency,
  type PricingDayParts,
  type PricingRule,
  type PricingSubRule,
  type PricingTable,
  type TokenRates,
} from "../pricingDefaults";
import {
  effectivePresets,
  groupModelPresets,
  type ModelPreset,
  type VendorModelsOverride,
} from "../modelPresets";

export type PricingPanelHandle = {
  save: () => Promise<void>;
  discard: () => Promise<void>;
  isDirty: () => boolean;
};

type Props = {
  active: boolean;
  /** Keeps pricing model rows in sync with 通用 vendor-models.json */
  vendorModelsOverride: VendorModelsOverride;
  notify: (message: string, ok?: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Convert legacy half-open adjacency (next.from === prev.to) to inclusive. */
function migrateHalfOpenRules(rules: PricingRule[]): PricingRule[] {
  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!id) continue;
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push({ ...r });
  }
  const out: PricingRule[] = [];
  for (const list of byModel.values()) {
    list.sort((a, b) =>
      (a.from || "0000-01-01").localeCompare(b.from || "0000-01-01"),
    );
    for (let i = 0; i + 1 < list.length; i++) {
      const cur = list[i];
      const next = list[i + 1];
      if (cur.to && next.from && next.from === cur.to) {
        cur.to = addDaysIso(cur.to, -1);
      }
    }
    out.push(...list);
  }
  // preserve rules without model
  for (const r of rules) {
    if (!r.model.trim()) out.push(r);
  }
  return out;
}

function normalizeTable(raw: Partial<PricingTable> & {
  rules?: Array<
    Partial<PricingRule> & {
      cny?: TokenRates;
      usd?: TokenRates;
      rates?: TokenRates;
      idleRates?: TokenRates;
      peakWindows?: PeakWindow[];
      peakWeekdays?: number[];
    }
  >;
  lockedModels?: string[];
  dayParts?: Partial<PricingDayParts>;
} | null | undefined): PricingTable {
  const displayCurrency: PricingCurrency =
    raw?.displayCurrency === "USD" ? "USD" : "CNY";
  const vendorCurrencies: Record<string, PricingCurrency> = {};
  const rawVc = raw?.vendorCurrencies ?? {};
  for (const [k, v] of Object.entries(rawVc)) {
    const vendor = k.trim();
    if (!vendor) continue;
    vendorCurrencies[vendor] = v === "USD" ? "USD" : "CNY";
  }

  const idleFrom =
    (raw?.dayParts?.idleFrom || DEFAULT_DAY_PARTS.idleFrom).trim() ||
    DEFAULT_DAY_PARTS.idleFrom;
  const idleTo =
    (raw?.dayParts?.idleTo || DEFAULT_DAY_PARTS.idleTo).trim() ||
    DEFAULT_DAY_PARTS.idleTo;
  const dayParts: PricingDayParts = {
    idleFrom:
      parseTimeToMinutes(idleFrom) >= 0 ? idleFrom : DEFAULT_DAY_PARTS.idleFrom,
    idleTo: parseTimeToMinutes(idleTo) >= 0 ? idleTo : DEFAULT_DAY_PARTS.idleTo,
  };
  const hasLegacyDayParts = !!raw?.dayParts;

  const modelIdsFromRules = new Set<string>();

  const rules = Array.isArray(raw?.rules)
    ? raw!.rules.map((r) => {
        const vendor = (r.vendor || "").trim();
        let cur =
          vendorCurrencies[vendor] ?? defaultVendorCurrency(vendor);
        if (vendor && !(vendor in vendorCurrencies)) {
          vendorCurrencies[vendor] = cur;
        }
        let rates: TokenRates;
        if (r.rates) {
          rates = { ...emptyRates(), ...r.rates };
        } else {
          const legacy =
            cur === "USD"
              ? (r as { usd?: TokenRates }).usd
              : (r as { cny?: TokenRates }).cny;
          rates = { ...emptyRates(), ...(legacy || {}) };
        }
        const idleRates = r.idleRates
          ? { ...emptyRates(), ...r.idleRates }
          : { ...rates };
        const peakWindows = normalizePeakWindows(
          r.peakWindows,
          rates,
          idleRates,
          hasLegacyDayParts && r.peakWindows === undefined
            ? dayParts
            : undefined,
        );
        const model = (r.model || "").trim();
        if (model) modelIdsFromRules.add(model);
        // Level-2: explicit flag, otherwise default locked
        const locked = typeof r.locked === "boolean" ? r.locked : true;
        return syncLegacyRates({
          id: (r.id || "").trim() || newRuleId(),
          vendor,
          model,
          from: (r.from || "").trim(),
          to: (r.to || "").trim(),
          rates,
          idleRates,
          peakWindows,
          peakWeekdays: normalizePeakWeekdays(
            (r as { peakWeekdays?: number[] }).peakWeekdays,
          ),
          subRules: Array.isArray((r as { subRules?: PricingSubRule[] }).subRules)
            ? (r as { subRules: PricingSubRule[] }).subRules
            : [],
          locked,
        });
      })
    : [];

  // Level-1: explicit list, otherwise lock every model by default
  let lockedModels: string[];
  if (Array.isArray(raw?.lockedModels)) {
    lockedModels = [
      ...new Set(
        raw!.lockedModels
          .map((s) => String(s || "").trim())
          .filter(Boolean),
      ),
    ];
  } else {
    lockedModels = [...modelIdsFromRules];
  }

  return {
    displayCurrency,
    vendorCurrencies,
    lockedModels,
    rules,
  };
}

/** Level-2: lock one date-interval. */
function lockInterval(rules: PricingRule[], ruleId: string): PricingRule[] {
  return rules.map((r) => (r.id === ruleId ? { ...r, locked: true } : r));
}

/** Level-2: lock every interval of a model (called by level-1 lock). */
function lockIntervalsForModel(
  rules: PricingRule[],
  model: string,
): PricingRule[] {
  const id = model.trim();
  let next = rules;
  for (const r of rules) {
    if (r.model.trim() === id) next = lockInterval(next, r.id);
  }
  return next;
}

/** Level-1: lock a model and all of its intervals. */
function lockModel(table: PricingTable, model: string): PricingTable {
  const id = model.trim();
  if (!id) return table;
  const locked = new Set(table.lockedModels.map((m) => m.trim()).filter(Boolean));
  locked.add(id);
  return {
    ...table,
    lockedModels: [...locked],
    rules: lockIntervalsForModel(table.rules, id),
  };
}

/** Lock every model via level-1 (which locks level-2). */
function lockAllModels(table: PricingTable): PricingTable {
  const ids = [
    ...new Set(table.rules.map((r) => r.model.trim()).filter(Boolean)),
  ];
  return ids.reduce((acc, id) => lockModel(acc, id), table);
}

/** After syncing presets, level-2-lock any newly appeared model intervals. */
function lockNewModelRules(
  prevRules: PricingRule[],
  nextRules: PricingRule[],
): PricingRule[] {
  const prev = new Set(prevRules.map((r) => r.model).filter(Boolean));
  return nextRules.map((r) => {
    const id = r.model.trim();
    if (id && !prev.has(id)) return { ...r, locked: true };
    return r;
  });
}

function syncRulesToPresets(
  rules: PricingRule[],
  presets: ModelPreset[],
  vendorCurrencies: Record<string, PricingCurrency>,
): PricingRule[] {
  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!id) continue;
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push(r);
  }

  const out: PricingRule[] = [];
  const seen = new Set<string>();
  for (const p of presets) {
    const id = p.model.trim();
    if (id) seen.add(id);
    const existing = byModel.get(id);
    if (existing && existing.length > 0) {
      for (const r of existing) {
        out.push({ ...r, vendor: p.group || r.vendor, model: id });
      }
      continue;
    }
    out.push(
      syncLegacyRates({
        id: newRuleId(),
        vendor: p.group,
        model: p.model,
        from: "",
        to: "",
        rates: emptyRates(),
        idleRates: emptyRates(),
        peakWindows: [],
        peakWeekdays: [],
        subRules: defaultSubRules(),
        locked: true,
      }),
    );
    if (!(p.group in vendorCurrencies)) {
      vendorCurrencies[p.group] =
        DEFAULT_VENDOR_CURRENCIES[p.group] ?? defaultVendorCurrency(p.group);
    }
  }
  // Keep retired models (no longer in 通用) so historical usage can still be priced.
  for (const r of rules) {
    const id = r.model.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const leftover = byModel.get(id);
    if (!leftover?.length) continue;
    out.push(...leftover);
  }
  return out;
}

function resolvePresets(override: VendorModelsOverride): ModelPreset[] {
  return effectivePresets(override);
}

function mergeTableWithPresets(
  cur: PricingTable,
  presets: ModelPreset[],
  prevRulesForLock: PricingRule[] = cur.rules,
): PricingTable {
  const vendorCurrencies = { ...cur.vendorCurrencies };
  const syncedRules = lockNewModelRules(
    prevRulesForLock,
    syncRulesToPresets(cur.rules, presets, vendorCurrencies),
  );
  return normalizeTable({
    displayCurrency: cur.displayCurrency,
    vendorCurrencies,
    lockedModels: lockNewModels(
      prevRulesForLock,
      syncedRules,
      cur.lockedModels,
    ),
    rules: syncedRules,
  });
}

function modelSetSignature(presets: ModelPreset[]): string {
  return presets
    .map((p) => p.model.trim())
    .filter(Boolean)
    .sort()
    .join("\0");
}

/** Inclusive range keys; empty from=-∞, empty to=+∞ */
function rangeStartKey(from: string): string {
  return from.trim() || "0000-01-01";
}
function rangeEndKey(to: string): string {
  return to.trim() || "9999-12-31";
}

/** Inclusive [from, to] overlap */
function rangesOverlap(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return (
    rangeStartKey(a.from) <= rangeEndKey(b.to) &&
    rangeStartKey(b.from) <= rangeEndKey(a.to)
  );
}

function isIsoDate(s: string): boolean {
  return !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Validate single-rule shape + no overlap + day continuity per model.
 * Continuity: sorted by from, adjacent must satisfy next.from === prev.to + 1 day
 * (open-start only allowed as first; open-end only as last).
 */
function validateRules(rules: PricingRule[]): void {
  for (const r of rules) {
    if (!r.model.trim()) throw new Error("每条规则必须有模型 ID");
    for (const w of r.peakWindows || []) {
      if (parseTimeToMinutes(w.from) < 0 || parseTimeToMinutes(w.to) < 0) {
        throw new Error(
          `模型 ${r.model}：高峰时段须为 HH:MM（当前 ${w.from}–${w.to}）`,
        );
      }
    }
    if (!isIsoDate(r.from)) {
      throw new Error(`模型 ${r.model}：起始日期格式无效`);
    }
    if (!isIsoDate(r.to)) {
      throw new Error(`模型 ${r.model}：结束日期格式无效`);
    }
    // Inclusive: same day allowed; only reject to < from
    if (r.from && r.to && r.to < r.from) {
      throw new Error(`模型 ${r.model}：结束日期不能早于起始日期`);
    }
  }

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rules[i].model !== rules[j].model) continue;
      if (rangesOverlap(rules[i], rules[j])) {
        throw new Error(
          `模型 ${rules[i].model}：日期区间重叠，请调整起始/结束`,
        );
      }
    }
  }

  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push(r);
  }
  for (const [model, list] of byModel) {
    const sorted = [...list].sort((a, b) =>
      rangeStartKey(a.from).localeCompare(rangeStartKey(b.from)),
    );
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      if (i === 0) {
        // open start ok
      } else if (!cur.from) {
        throw new Error(`模型 ${model}：仅第一段可以「不限起始」`);
      }
      if (i < sorted.length - 1 && !cur.to) {
        throw new Error(
          `模型 ${model}：中间区间不能「不限结束」，否则无法衔接后续`,
        );
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        if (!prev.to) {
          throw new Error(`模型 ${model}：上一段不限结束，无法衔接`);
        }
        const expect = addDaysIso(prev.to, 1);
        if (cur.from !== expect) {
          throw new Error(
            `模型 ${model}：区间不连贯（上一段结束 ${prev.to}，下一段起始应为 ${expect}，当前为 ${cur.from || "不限"}）`,
          );
        }
      }
    }
  }
}

function maxIsoDate(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function BoundDateField({
  kind,
  value,
  peerDate,
  disabled,
  onChange,
}: {
  kind: "from" | "to";
  value: string;
  /** For end date: start date used when defaulting */
  peerDate?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const open = !value;
  const defaultDated = () => {
    if (kind === "to") {
      return maxIsoDate(todayIso(), (peerDate || "").trim());
    }
    return todayIso();
  };
  return (
    <div className={"pricing-bound" + (disabled ? " is-disabled" : "")}>
      <div className="pricing-bound-toggle" role="group">
        <button
          type="button"
          className={"pricing-bound-chip" + (open ? " is-active" : "")}
          disabled={disabled}
          onClick={() => onChange("")}
        >
          {kind === "from" ? "不限起始" : "不限结束"}
        </button>
        <button
          type="button"
          className={"pricing-bound-chip" + (!open ? " is-active" : "")}
          disabled={disabled}
          onClick={() => {
            if (!value) onChange(defaultDated());
          }}
        >
          指定日期
        </button>
      </div>
      {!open ? (
        <input
          type="date"
          className="pricing-date-input"
          value={value}
          min={kind === "to" && peerDate ? peerDate : undefined}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

const WEEKDAY_CHIPS: { n: number; label: string }[] = [
  { n: 1, label: "一" },
  { n: 2, label: "二" },
  { n: 3, label: "三" },
  { n: 4, label: "四" },
  { n: 5, label: "五" },
  { n: 6, label: "六" },
  { n: 7, label: "日" },
];

function WeekdayChips({
  value,
  disabled,
  compact,
  onChange,
}: {
  value: number[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (next: number[]) => void;
}) {
  const days = normalizePeakWeekdays(value);
  const everyDay = days.length === 0;
  const toggleDay = (n: number) => {
    if (everyDay) {
      onChange([n]);
      return;
    }
    const set = new Set(days);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    onChange(normalizePeakWeekdays([...set]));
  };
  return (
    <div
      className={"pricing-weekdays" + (compact ? " is-compact" : "")}
      role="group"
      aria-label="适用星期"
    >
      {compact ? null : (
        <span className="pricing-windows-label">适用星期</span>
      )}
      <button
        type="button"
        className={"pricing-weekday-chip" + (everyDay ? " is-active" : "")}
        disabled={disabled}
        onClick={() => onChange([])}
      >
        每天
      </button>
      {WEEKDAY_CHIPS.map((d) => (
        <button
          key={d.n}
          type="button"
          className={
            "pricing-weekday-chip" +
            (!everyDay && days.includes(d.n) ? " is-active" : "")
          }
          disabled={disabled}
          onClick={() => toggleDay(d.n)}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

function normalizePriceOnBlur(raw: string): number {
  const t = raw.trim();
  if (t === "" || t === "." || t === "-") return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function PricingRateInput(props: {
  value: number;
  disabled?: boolean;
  className?: string;
  title?: string;
  onCommit: (n: number) => void;
}) {
  const { value, disabled, className, title, onCommit } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null ? draft : String(value);
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={shown}
      disabled={disabled}
      title={title}
      onFocus={() => setDraft(value === 0 ? "" : String(value))}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" || /^\d*\.?\d*$/.test(raw)) setDraft(raw);
      }}
      onBlur={() => {
        const next = normalizePriceOnBlur(draft ?? "");
        setDraft(null);
        onCommit(next);
      }}
    />
  );
}

function PricingLockButton(props: {
  locked: boolean;
  level: 1 | 2;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  const { locked, level, disabled, label, onClick } = props;
  const levelHint = level === 1 ? "一级（模型）" : "二级（区间）";
  return (
    <button
      type="button"
      className={
        "pricing-lock-btn" +
        (level === 1 ? " is-level1" : " is-level2") +
        (locked ? " is-locked" : " is-unlocked") +
        (disabled ? " is-disabled" : "")
      }
      disabled={disabled}
      title={
        disabled
          ? "模型已一级锁定，请先解锁模型"
          : locked
            ? `已${levelHint}锁定：点击解锁`
            : `已${levelHint}解锁：点击锁定以防误改`
      }
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
    >
      {locked ? (
        <svg
          className="pricing-lock-icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <rect
            x="5"
            y="11"
            width="14"
            height="10"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M8 11V8a4 4 0 0 1 8 0v3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="16" r="1.25" fill="currentColor" />
        </svg>
      ) : (
        <svg
          className="pricing-lock-icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <rect
            x="5"
            y="11"
            width="14"
            height="10"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M8 11V8a4 4 0 0 1 7.5-2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="16" r="1.25" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

export const PricingPanel = forwardRef<PricingPanelHandle, Props>(
  function PricingPanel(
    { active, vendorModelsOverride, notify, onDirtyChange },
    ref,
  ) {
    const [table, setTable] = useState<PricingTable>(() => {
      const vendorCurrencies = {
        ...DEFAULT_VENDOR_CURRENCIES,
      };
      const rules = syncRulesToPresets(
        [],
        resolvePresets(vendorModelsOverride),
        vendorCurrencies,
      );
      return normalizeTable({
        displayCurrency: "CNY",
        vendorCurrencies,
        rules,
        // omit lockedModels → default lock all
      });
    });
    const [loading, setLoading] = useState(false);
    const [dirty, setDirtyState] = useState(false);
    const setDirty = useCallback(
      (next: boolean) => {
        setDirtyState(next);
        onDirtyChange?.(next);
      },
      [onDirtyChange],
    );
    const tableRef = useRef(table);
    tableRef.current = table;
    const presetSigRef = useRef(
      modelSetSignature(resolvePresets(vendorModelsOverride)),
    );
    const [editorModel, setEditorModel] = useState<string | null>(null);
    const [subEditorIntervalId, setSubEditorIntervalId] = useState<
      string | null
    >(null);
    const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
    const [modalToast, setModalToast] = useState<{
      message: string;
      ok: boolean;
    } | null>(null);
    const modalToastTimerRef = useRef<number | null>(null);
    const editorModelRef = useRef<string | null>(null);
    const subEditorRef = useRef<string | null>(null);
    const [nowTick, setNowTick] = useState(() => Date.now());
    useEffect(() => {
      const t = window.setInterval(() => setNowTick(Date.now()), 30000);
      return () => window.clearInterval(t);
    }, []);
    editorModelRef.current = editorModel;
    subEditorRef.current = subEditorIntervalId;
    const flash = useCallback(
      (message: string, ok = true) => {
        if (editorModelRef.current || subEditorRef.current) {
          setModalToast({ message, ok });
          if (modalToastTimerRef.current) {
            window.clearTimeout(modalToastTimerRef.current);
          }
          modalToastTimerRef.current = window.setTimeout(() => {
            setModalToast(null);
            modalToastTimerRef.current = null;
          }, 2800);
          return;
        }
        notify(message, ok);
      },
      [notify],
    );
    const closeSubEditor = useCallback(() => {
      setSubEditorIntervalId(null);
      setSelectedSubId(null);
    }, []);
    const closeRuleEditor = useCallback(() => {
      closeSubEditor();
      setEditorModel(null);
    }, [closeSubEditor]);
    useEffect(() => {
      if (!editorModel) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (subEditorIntervalId) closeSubEditor();
        else closeRuleEditor();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [editorModel, subEditorIntervalId, closeRuleEditor, closeSubEditor]);

    const applyLocal = useCallback((next: PricingTable) => {
      setTable(next);
      tableRef.current = next;
      setDirty(true);
    }, []);

    const load = useCallback(async () => {
      setLoading(true);
      try {
        const res = await api.getPricing();
        const presets = resolvePresets(vendorModelsOverride);
        const base = normalizeTable(res);
        const vendorCurrencies = { ...base.vendorCurrencies };
        const nextRules = syncRulesToPresets(
          migrateHalfOpenRules(base.rules),
          presets,
          vendorCurrencies,
        );
        const syncedRules = lockNewModelRules(base.rules, nextRules);
        const synced = normalizeTable({
          displayCurrency: base.displayCurrency,
          vendorCurrencies,
          lockedModels: lockNewModels(
            base.rules,
            syncedRules,
            base.lockedModels,
          ),
          rules: syncedRules,
        });
        setTable(synced);
        tableRef.current = synced;
        presetSigRef.current = modelSetSignature(presets);
        setDirty(false);
      } finally {
        setLoading(false);
      }
    }, [vendorModelsOverride]);

    useEffect(() => {
      if (active) void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    useEffect(() => {
      if (!active || loading) return;
      const presets = resolvePresets(vendorModelsOverride);
      const sig = modelSetSignature(presets);
      if (sig === presetSigRef.current) return;
      const prevSig = presetSigRef.current;
      presetSigRef.current = sig;
      const cur = tableRef.current;
      const synced = mergeTableWithPresets(cur, presets, cur.rules);
      setTable(synced);
      tableRef.current = synced;
      const added = presets.filter(
        (p) =>
          !cur.rules.some((r) => r.model.trim() === p.model.trim()),
      );
      const retired = [
        ...new Set(
          cur.rules
            .map((r) => r.model.trim())
            .filter(
              (id) =>
                id && !presets.some((p) => p.model.trim() === id),
            ),
        ),
      ];
      if (added.length > 0 || retired.length > 0) {
        setDirty(true);
        const parts: string[] = [];
        if (added.length > 0) {
          parts.push(`新增 ${added.map((p) => p.model).join("、")}`);
        }
        if (retired.length > 0) {
          parts.push(`已下架保留 ${retired.join("、")}`);
        }
        flash(`模型列表已与「通用」同步（${parts.join("；")}），请保存价目表`);
      } else if (prevSig) {
        // Vendor reassignment only — still refresh table rows
        setDirty(true);
      }
    }, [vendorModelsOverride, active, loading, notify, setDirty]);

    const save = useCallback(async () => {
      const presets = resolvePresets(vendorModelsOverride);
      const cur = tableRef.current;
      const vendorCurrencies = { ...cur.vendorCurrencies };
      const nextRules = lockNewModelRules(
        cur.rules,
        syncRulesToPresets(cur.rules, presets, vendorCurrencies),
      );
      const body = lockAllModels({
        displayCurrency: cur.displayCurrency,
        vendorCurrencies,
        lockedModels: lockNewModels(cur.rules, nextRules, cur.lockedModels),
        rules: nextRules,
      });
      try {
        validateRules(body.rules);
      } catch (e) {
        flash(e instanceof Error ? e.message : "价目表不符合规则", false);
        throw e;
      }
      const res = await api.putPricing(body);
      const base = normalizeTable(res);
      const vc = { ...base.vendorCurrencies };
      const syncedRules = lockNewModelRules(
        base.rules,
        syncRulesToPresets(base.rules, presets, vc),
      );
      const synced = lockAllModels(
        normalizeTable({
          displayCurrency: base.displayCurrency,
          vendorCurrencies: vc,
          lockedModels: lockNewModels(
            base.rules,
            syncedRules,
            base.lockedModels,
          ),
          rules: syncedRules,
        }),
      );
      setTable(synced);
      tableRef.current = synced;
      setDirty(false);
      flash("已保存计费价目表");
    }, [notify, vendorModelsOverride]);

    useImperativeHandle(
      ref,
      () => ({
        save,
        discard: async () => {
          setLoading(true);
          try {
            const res = await api.getPricing();
            const presets = resolvePresets(vendorModelsOverride);
            const base = normalizeTable(res);
            const vendorCurrencies = { ...base.vendorCurrencies };
            const nextRules = lockNewModelRules(
              base.rules,
              syncRulesToPresets(
                migrateHalfOpenRules(base.rules),
                presets,
                vendorCurrencies,
              ),
            );
            const synced = normalizeTable({
              displayCurrency: base.displayCurrency,
              vendorCurrencies,
              lockedModels: lockNewModels(
                base.rules,
                nextRules,
                base.lockedModels,
              ),
              rules: nextRules,
            });
            setTable(synced);
            tableRef.current = synced;
            setDirty(false);
            flash("已取消修改，已恢复为已保存的价目表");
          } catch (e) {
            flash(toFriendlyError(e, "取消修改失败"), false);
            throw e;
          } finally {
            setLoading(false);
          }
        },
        isDirty: () => tableRef.current !== undefined && dirty,
      }),
      [save, notify, dirty, vendorModelsOverride],
    );

    const activePresets = useMemo(
      () => resolvePresets(vendorModelsOverride),
      [vendorModelsOverride],
    );

    const rulesByModel = useMemo(() => {
      const map = new Map<string, PricingRule[]>();
      for (const r of table.rules) {
        const id = r.model.trim();
        if (!id) continue;
        if (!map.has(id)) map.set(id, []);
        map.get(id)!.push(r);
      }
      for (const list of map.values()) {
        list.sort((a, b) =>
          rangeStartKey(a.from).localeCompare(rangeStartKey(b.from)),
        );
      }
      return map;
    }, [table.rules]);

    const vendorGroups = useMemo(() => {
      const activeIds = new Set(
        activePresets.map((p) => p.model.trim()).filter(Boolean),
      );
      const vendorOf = new Map<string, string>();
      const ruleOrder: string[] = [];
      for (const r of table.rules) {
        const id = r.model.trim();
        if (!id || vendorOf.has(id)) continue;
        vendorOf.set(id, (r.vendor || "").trim() || "其他");
        ruleOrder.push(id);
      }
      const retiredByVendor = new Map<string, string[]>();
      for (const id of ruleOrder) {
        if (activeIds.has(id)) continue;
        const vendor = vendorOf.get(id) || "其他";
        if (!retiredByVendor.has(vendor)) retiredByVendor.set(vendor, []);
        retiredByVendor.get(vendor)!.push(id);
      }
      const seen = new Set<string>();
      const out: { vendor: string; models: { id: string; retired: boolean }[] }[] =
        [];
      for (const g of groupModelPresets(activePresets)) {
        seen.add(g.group);
        const models = [
          ...g.models
            .map((p) => p.model.trim())
            .filter(Boolean)
            .map((id) => ({ id, retired: false })),
          ...(retiredByVendor.get(g.group) || []).map((id) => ({
            id,
            retired: true,
          })),
        ];
        if (models.length) out.push({ vendor: g.group, models });
      }
      for (const [vendor, ids] of retiredByVendor) {
        if (seen.has(vendor)) continue;
        out.push({
          vendor,
          models: ids.map((id) => ({ id, retired: true })),
        });
      }
      return out;
    }, [activePresets, table.rules]);

    const now = useMemo(() => new Date(nowTick), [nowTick]);

    const isModelLocked = (model: string) =>
      tableRef.current.lockedModels.includes(model.trim());

    const editBlockReason = (rule: PricingRule): string | null => {
      if (isModelLocked(rule.model)) {
        return `「${rule.model}」已一级锁定，请先解锁模型`;
      }
      if (rule.locked) {
        return "该日期区间已二级锁定，请先解锁区间";
      }
      return null;
    };

    const tryPatchRule = (id: string, patch: Partial<PricingRule>) => {
      const cur = tableRef.current;
      const target = cur.rules.find((r) => r.id === id);
      if (!target) return;
      const block = editBlockReason(target);
      if (block) {
        flash(block, false);
        return;
      }
      const nextRules = cur.rules.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
      );
      try {
        validateRules(nextRules);
      } catch (e) {
        flash(e instanceof Error ? e.message : "日期不符合规则", false);
        // still apply so user can continue editing toward a valid state
      }
      applyLocal({ ...cur, rules: nextRules });
    };

    const setPeakWindows = (id: string, peakWindows: PeakWindow[]) => {
      tryPatchRule(id, { peakWindows });
    };

    const addPeakWindow = (id: string) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === id);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const seed =
        rule.peakWindows?.[rule.peakWindows.length - 1] ||
        DEFAULT_DEEPSEEK_PEAK_WINDOWS[0]!;
      setPeakWindows(id, [
        ...(rule.peakWindows || []),
        { from: seed.from, to: seed.to },
      ]);
    };

    const patchPeakWindow = (
      id: string,
      index: number,
      patch: Partial<PeakWindow>,
    ) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === id);
      if (!rule) return;
      const next = (rule.peakWindows || []).map((w, i) =>
        i === index ? { ...w, ...patch } : w,
      );
      setPeakWindows(id, next);
    };

    const removePeakWindow = (id: string, index: number) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === id);
      if (!rule) return;
      setPeakWindows(
        id,
        (rule.peakWindows || []).filter((_, i) => i !== index),
      );
    };

    const patchInterval = (id: string, next: PricingRule) => {
      const cur = tableRef.current;
      applyLocal({
        ...cur,
        rules: cur.rules.map((r) => (r.id === id ? syncLegacyRates(next) : r)),
      });
    };

    const patchSubRule = (
      intervalId: string,
      subId: string,
      patch: Partial<PricingSubRule>,
    ) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === intervalId);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const subs = ensureSubRules(rule).map((s) =>
        s.id === subId ? { ...s, ...patch } : s,
      );
      patchInterval(intervalId, { ...rule, subRules: subs });
    };

    const copySubRule = (intervalId: string, subId: string) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === intervalId);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const subs = ensureSubRules(rule);
      const src = subs.find((s) => s.id === subId);
      if (!src) {
        flash("请先选中一条子规则，再复制", false);
        return;
      }
      const next: PricingSubRule = {
        id: newSubRuleId(),
        peakWeekdays: [...(src.peakWeekdays || [])],
        band: src.band,
        rates: { ...src.rates },
      };
      patchInterval(intervalId, { ...rule, subRules: [next, ...subs] });
      setSubEditorIntervalId(intervalId);
      setSelectedSubId(next.id);
      flash("已复制到列表顶部（优先级最高），请点「保存价目表」写入");
    };

    const addSubRule = (intervalId: string) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === intervalId);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const subs = ensureSubRules(rule);
      const seed = subs[0];
      const next: PricingSubRule = {
        id: newSubRuleId(),
        peakWeekdays: seed ? [...(seed.peakWeekdays || [])] : [],
        band: seed?.band === "peak" ? "idle" : "peak",
        rates: seed ? { ...seed.rates } : emptyRates(),
      };
      patchInterval(intervalId, { ...rule, subRules: [next, ...subs] });
      setSubEditorIntervalId(intervalId);
      setSelectedSubId(next.id);
      flash("已在列表顶部新增子规则（优先级最高），请点「保存价目表」写入");
    };

    const moveSubRule = (intervalId: string, fromIndex: number, toIndex: number) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === intervalId);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const subs = ensureSubRules(rule);
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= subs.length ||
        toIndex >= subs.length
      ) {
        return;
      }
      const next = [...subs];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      patchInterval(intervalId, { ...rule, subRules: next });
    };

    const removeSubRule = (intervalId: string, subId: string) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === intervalId);
      if (!rule) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const subs = ensureSubRules(rule);
      if (subs.length <= 1) {
        flash("至少保留一条子规则", false);
        return;
      }
      patchInterval(intervalId, {
        ...rule,
        subRules: subs.filter((s) => s.id !== subId),
      });
      flash("已暂存删除子规则，请点「保存价目表」写入");
    };

    const setVendorCurrency = (vendor: string, currency: PricingCurrency) => {
      const cur = tableRef.current;
      applyLocal({
        ...cur,
        vendorCurrencies: {
          ...cur.vendorCurrencies,
          [vendor]: currency,
        },
      });
    };

    /** Level-1: lock/unlock whole model. Locking calls level-2 lock on all intervals. */
    const toggleModelLock = (model: string) => {
      const id = model.trim();
      if (!id) return;
      const cur = tableRef.current;
      if (cur.lockedModels.includes(id)) {
        applyLocal({
          ...cur,
          lockedModels: cur.lockedModels.filter((m) => m.trim() !== id),
        });
        return;
      }
      applyLocal(lockModel(cur, id));
    };

    /** Level-2: lock/unlock one date-interval (blocked while model is L1-locked). */
    const toggleRuleLock = (ruleId: string) => {
      const cur = tableRef.current;
      const target = cur.rules.find((r) => r.id === ruleId);
      if (!target) return;
      if (isModelLocked(target.model)) {
        flash(`「${target.model}」已一级锁定，请先解锁模型`, false);
        return;
      }
      const nextRules = cur.rules.map((r) =>
        r.id === ruleId ? { ...r, locked: !r.locked } : r,
      );
      applyLocal({ ...cur, rules: nextRules });
    };

    /** Local only until save. New start = previous inclusive end + 1 day. */
    const addNewRange = (src: PricingRule) => {
      const block = editBlockReason(src);
      if (block) {
        flash(block, false);
        return;
      }
      const cur = tableRef.current;
      if (!src.to) {
        flash(
          `「${src.model}」当前为「不限结束」（此后全部适用）。请先指定结束日期，保存前再新增区间。`,
          false,
        );
        return;
      }
      const newFrom = addDaysIso(src.to, 1);
      if (src.from && newFrom < src.from) {
        flash("结束日期无效，无法衔接新区间", false);
        return;
      }

      const right: PricingRule = syncLegacyRates({
        id: newRuleId(),
        vendor: src.vendor,
        model: src.model,
        from: newFrom,
        to: "",
        rates: { ...src.rates },
        idleRates: { ...(src.idleRates || src.rates) },
        peakWindows: (src.peakWindows || []).map((w) => ({ ...w })),
        peakWeekdays: normalizePeakWeekdays(src.peakWeekdays),
        subRules: ensureSubRules(src).map((s) => ({
          id: newSubRuleId(),
          peakWeekdays: [...(s.peakWeekdays || [])],
          band: s.band,
          rates: { ...s.rates },
        })),
        locked: false,
      });
      const nextRules = [...cur.rules, right];
      try {
        validateRules(nextRules);
      } catch (e) {
        flash(e instanceof Error ? e.message : "无法新增区间", false);
        return;
      }
      applyLocal({ ...cur, rules: nextRules });
      flash(`已暂存新区间（自 ${newFrom} 起），请点「保存价目表」写入`);
    };

    const removeInterval = (rule: PricingRule, intervalCount: number) => {
      if (intervalCount <= 1) return;
      const block = editBlockReason(rule);
      if (block) {
        flash(block, false);
        return;
      }
      const cur = tableRef.current;
      if (subEditorIntervalId === rule.id) closeSubEditor();
      applyLocal({
        ...cur,
        rules: cur.rules.filter((r) => r.id !== rule.id),
      });
      flash(`已暂存删除，请点「保存价目表」写入`);
    };

    const RATE_FIELDS = [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ] as const;

    const renderPeakWindowEditor = (rule: PricingRule, locked: boolean) => {
      const peakWindows = rule.peakWindows || [];
      return (
        <div
          className="pricing-windows-inline"
          onClick={(e) => e.stopPropagation()}
        >
          {peakWindows.length === 0 ? (
            <span
              className="pricing-windows-empty"
              title="未配置时按列表优先级，不区分钟点"
            >
              未配置
            </span>
          ) : (
            peakWindows.map((w, wi) => (
              <span key={wi} className="pricing-window-chip">
                <input
                  type="time"
                  className="pricing-time-input"
                  value={(w.from || "").slice(0, 5)}
                  disabled={locked}
                  title="高峰起始（含）"
                  onChange={(e) =>
                    patchPeakWindow(rule.id, wi, {
                      from: e.target.value || "00:00",
                    })
                  }
                />
                <span className="pricing-window-sep">–</span>
                <input
                  type="time"
                  className="pricing-time-input"
                  value={(w.to || "").slice(0, 5)}
                  disabled={locked}
                  title="高峰结束（不含）"
                  onChange={(e) =>
                    patchPeakWindow(rule.id, wi, {
                      to: e.target.value || "00:00",
                    })
                  }
                />
                <button
                  type="button"
                  className="pricing-window-remove"
                  title="删除此时段"
                  disabled={locked}
                  onClick={() => removePeakWindow(rule.id, wi)}
                >
                  ×
                </button>
              </span>
            ))
          )}
          <button
            type="button"
            className="pricing-btn pricing-btn-secondary pricing-btn-sm"
            disabled={locked}
            title={locked ? "已锁定，请先解锁" : "添加高峰时段"}
            onClick={() => addPeakWindow(rule.id)}
          >
            添加时段
          </button>
        </div>
      );
    };

    const renderIntervalEditor = (model: string) => {
      const list = rulesByModel.get(model) ?? [];
      const modelLocked = table.lockedModels.includes(model.trim());
      return list.map((r, idx) => {
        const intervalLocked = !!r.locked;
        const locked = modelLocked || intervalLocked;
        const peakWindows = r.peakWindows || [];
        const intervalCount = list.length;
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const showCurrent = dateInInclusiveRange(today, r.from, r.to);
        const snapAt = (() => {
          if (showCurrent) return now;
          const raw = (r.from || today).trim();
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
          if (!m) return now;
          const d = new Date(now);
          d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          return d;
        })();
        const live = currentRatesForModel([r], r.model, snapAt);
        const showSnap = !!live;
        const showWindows = live?.band === "peak";
        const span = (showSnap ? 1 : 0) + (showWindows ? 1 : 0) + 1;
        const rowClass =
          "pricing-row" +
          (idx === 0 ? " is-model-start" : " is-interval-cont") +
          (locked ? " is-locked" : "");
        const lockHint = modelLocked
          ? "已一级锁定，请先解锁模型"
          : intervalLocked
            ? "已二级锁定，请先解锁区间"
            : null;
        const dateCells = (
          <>
            <td rowSpan={span}>
              <BoundDateField
                kind="from"
                value={r.from}
                disabled={locked}
                onChange={(from) => tryPatchRule(r.id, { from })}
              />
            </td>
            <td className="pricing-date-end" rowSpan={span}>
              <BoundDateField
                kind="to"
                value={r.to}
                peerDate={r.from}
                disabled={locked}
                onChange={(to) => tryPatchRule(r.id, { to })}
              />
            </td>
          </>
        );
        const actionCell = (
          <td className="pricing-row-actions" rowSpan={span}>
            <div className="pricing-row-actions-inner">
              <PricingLockButton
                level={2}
                locked={intervalLocked}
                disabled={modelLocked}
                label={
                  intervalLocked
                    ? `二级解锁区间 ${r.model}`
                    : `二级锁定区间 ${r.model}`
                }
                onClick={() => toggleRuleLock(r.id)}
              />
              <button
                type="button"
                className="pricing-btn pricing-btn-accent pricing-btn-sm"
                title={
                  lockHint || "暂存：上一段结束日+1 起新增不限结束区间"
                }
                disabled={locked}
                onClick={() => addNewRange(r)}
              >
                新增区间
              </button>
              {intervalCount > 1 ? (
                <button
                  type="button"
                  className="pricing-btn pricing-btn-danger pricing-btn-sm"
                  title={lockHint || undefined}
                  disabled={locked}
                  onClick={() => removeInterval(r, intervalCount)}
                >
                  删除区间
                </button>
              ) : null}
            </div>
          </td>
        );
        return (
          <Fragment key={r.id}>
            {idx > 0 ? (
              <tr className="pricing-interval-sep" aria-hidden>
                <td colSpan={9} />
              </tr>
            ) : null}
            {showSnap && live ? (
              <tr
                className={
                  rowClass +
                  " pricing-current-now" +
                  (showWindows ? " pricing-split-windows" : "")
                }
              >
                {dateCells}
                <td
                  className={
                    "pricing-weekday-cell pricing-band-cell is-band-top-left is-" +
                    live.band
                  }
                >
                  {showCurrent ? (
                    <span className="pricing-current-chip">当前</span>
                  ) : null}
                  {formatWeekdaysHint(live.subRule?.peakWeekdays)}
                </td>
                <td
                  className={
                    "pricing-part-col pricing-rates-start pricing-band-cell is-" +
                    live.band
                  }
                >
                  <span className={"pricing-part-tag is-" + live.band}>
                    {live.band === "idle" ? "闲时" : "高峰"}
                  </span>
                </td>
                {RATE_FIELDS.map((field, fi) => (
                  <td
                    key={field}
                    className={
                      "pricing-band-cell is-" +
                      live.band +
                      (fi === RATE_FIELDS.length - 1
                        ? " pricing-rates-end is-band-top-right"
                        : "")
                    }
                  >
                    <span className="pricing-current-value">
                      {live.rates[field]}
                    </span>
                  </td>
                ))}
                {actionCell}
              </tr>
            ) : null}
            {showWindows ? (
              <tr
                className={"pricing-windows-row" + (locked ? " is-locked" : "")}
              >
                {showSnap ? null : dateCells}
                <td
                  className={
                    "pricing-windows-cell pricing-band-cell is-peak" +
                    (showSnap ? "" : " is-band-top-left is-band-top-right")
                  }
                  colSpan={6}
                >
                  <div className="pricing-windows-inner">
                    <span className="pricing-windows-label">高峰时段</span>
                    <span className="pricing-windows-empty">
                      {formatPeakWindowsHint(peakWindows)}
                    </span>
                  </div>
                </td>
                {showSnap ? null : actionCell}
              </tr>
            ) : null}
            <tr className={rowClass + " pricing-edit-sub-row"}>
              {showSnap || showWindows ? null : dateCells}
              <td
                className={
                  "pricing-edit-sub-cell" +
                  (showSnap || showWindows ? " is-band-bottom" : " is-band-only")
                }
                colSpan={6}
              >
                <button
                  type="button"
                  className="pricing-edit-sub-btn"
                  title="打开子规则列表，修改或新增价格规则"
                  onClick={() => setSubEditorIntervalId(r.id)}
                >
                  修改/新增价格规则
                  <span className="pricing-edit-sub-plus" aria-hidden>
                    +
                  </span>
                </button>
              </td>
              {showSnap || showWindows ? null : actionCell}
            </tr>
          </Fragment>
        );
      });
    };

    const editorRules = editorModel
      ? (rulesByModel.get(editorModel) ?? [])
      : [];
    const editorSubRule = subEditorIntervalId
      ? table.rules.find((r) => r.id === subEditorIntervalId) || null
      : null;

    return (
      <div className="pricing-panel">
        <div className="pricing-sync-banner" role="note">
          <strong>模型列表与「通用」同步（只增不减）</strong>
          <span>
            主表显示此刻生效的四列单价。点「修改规则」编辑日期区间；高峰时段与价格规则在第二层弹窗中修改。未配置高峰时段时按列表从上到下取第一条适用星期，不强制高峰。通用里新出现的模型会自动加入；已下架的模型不删除，固定排在该厂商列表底部，避免历史用量无法计价。模型
            ID 旁为一级锁；弹窗内为二级锁。改价需两级都解锁。保存后才会写入磁盘。
          </span>
        </div>

        {loading ? (
          <p className="hint">加载价目表…</p>
        ) : (
          <>
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>显示与编辑</h2>
              </div>
              <div className="pricing-toolbar">
                <label className="settings-half">
                  统计页默认货币
                  <select
                    value={table.displayCurrency}
                    onChange={(e) =>
                      applyLocal({
                        ...tableRef.current,
                        displayCurrency:
                          e.target.value === "USD" ? "USD" : "CNY",
                      })
                    }
                  >
                    <option value="CNY">人民币 (CNY)</option>
                    <option value="USD">美元 (USD)</option>
                  </select>
                </label>
                <div className="pricing-toolbar-actions">
                  {dirty ? (
                    <span className="pricing-dirty-hint">有未保存修改</span>
                  ) : null}
                </div>
              </div>
              <p className="hint">
                计费货币按厂商设置。主表价格按当前日期、钟点与适用星期匹配区间。子规则可重叠，按列表从上到下取第一条命中。日期区间须闭区间衔接。
              </p>
            </section>

            {vendorGroups.every((g) => g.models.length === 0) ? (
              <div className="settings-card">
                <p className="hint">
                  通用中尚无可用模型。请先在「通用」配置厂商与模型。
                </p>
              </div>
            ) : (
              vendorGroups.map(({ vendor, models }) => {
                if (models.length === 0) return null;
                const vendorCur =
                  table.vendorCurrencies[vendor] ??
                  defaultVendorCurrency(vendor);
                const unitShort = vendorCur === "USD" ? "$/1M" : "¥/1M";
                return (
                  <section
                    key={vendor}
                    className="settings-card pricing-vendor"
                  >
                    <div className="settings-card-head pricing-vendor-head">
                      <h2>{vendor}</h2>
                      <label className="pricing-vendor-currency">
                        <span className="pricing-vendor-currency-label">
                          计费货币
                        </span>
                        <select
                          value={vendorCur}
                          onChange={(e) =>
                            setVendorCurrency(
                              vendor,
                              e.target.value === "USD" ? "USD" : "CNY",
                            )
                          }
                        >
                          <option value="CNY">人民币 (CNY)</option>
                          <option value="USD">美元 (USD)</option>
                        </select>
                      </label>
                    </div>
                    <div className="pricing-table-scroll">
                      <table className="pricing-table pricing-table-current">
                        <thead>
                          <tr>
                            <th>模型 ID</th>
                            <th title="百万tokens输入（缓存未命中）">
                              <span className="pricing-th-main">Input</span>
                              <span className="pricing-th-unit">{unitShort}</span>
                            </th>
                            <th title="百万tokens输出">
                              <span className="pricing-th-main">Output</span>
                              <span className="pricing-th-unit">{unitShort}</span>
                            </th>
                            <th title="百万tokens输入（缓存命中）">
                              <span className="pricing-th-main">Cache Read</span>
                              <span className="pricing-th-unit">{unitShort}</span>
                            </th>
                            <th title="百万tokens缓存写入">
                              <span className="pricing-th-main">Cache Write</span>
                              <span className="pricing-th-unit">{unitShort}</span>
                            </th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {models.map(({ id: model, retired }) => {
                            const modelLocked = table.lockedModels.includes(
                              model.trim(),
                            );
                            const current = currentRatesForModel(
                              table.rules,
                              model,
                              now,
                            );
                            const rates = current?.rates ?? emptyRates();
                            const band = current?.band;
                            return (
                              <tr
                                key={model}
                                className={
                                  "pricing-row pricing-current-row" +
                                  (modelLocked ? " is-locked" : "") +
                                  (retired ? " is-retired" : "") +
                                  (band === "idle"
                                    ? " is-idle"
                                    : band === "peak"
                                      ? " is-peak"
                                      : " is-miss")
                                }
                              >
                                <td className="pricing-model-cell">
                                  <div className="pricing-model-cell-inner">
                                    <PricingLockButton
                                      level={1}
                                      locked={modelLocked}
                                      label={
                                        modelLocked
                                          ? `一级解锁 ${model}`
                                          : `一级锁定 ${model}`
                                      }
                                      onClick={() => toggleModelLock(model)}
                                    />
                                    <span
                                      className="pricing-model-id"
                                      title={
                                        retired
                                          ? `${model}（通用已下架，保留计费）`
                                          : model
                                      }
                                    >
                                      {model}
                                    </span>
                                    {retired ? (
                                      <span
                                        className="pricing-band-pill is-retired"
                                        title="该模型已不在通用列表中，保留以免历史用量无法计价"
                                      >
                                        已下架
                                      </span>
                                    ) : null}
                                    <span
                                      className={
                                        "pricing-band-pill is-" + (band || "miss")
                                      }
                                    >
                                      {band === "idle"
                                        ? "闲时"
                                        : band === "peak"
                                          ? "高峰"
                                          : "无匹配"}
                                    </span>
                                  </div>
                                </td>
                                {RATE_FIELDS.map((field) => (
                                  <td key={field} className="pricing-current-cell">
                                    <span className="pricing-current-value">
                                      {rates[field]}
                                    </span>
                                  </td>
                                ))}
                                <td className="pricing-row-actions">
                                  <div className="pricing-row-actions-inner">
                                    <button
                                      type="button"
                                      className="pricing-btn pricing-btn-accent pricing-btn-sm"
                                      onClick={() => setEditorModel(model)}
                                    >
                                      修改规则
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })
            )}
          </>
        )}

        {editorModel
          ? createPortal(
              <div
                className="pricing-rule-backdrop"
                role="presentation"
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeRuleEditor();
                }}
              >
                <div
                  className="pricing-rule-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="pricing-rule-title"
                >
                  {modalToast && !editorSubRule ? (
                    <div
                      className={
                        "pricing-modal-toast" +
                        (modalToast.ok ? " is-ok" : " is-fail")
                      }
                      role="status"
                    >
                      {modalToast.message}
                    </div>
                  ) : null}
                  <header className="pricing-rule-modal-head">
                    <h3 id="pricing-rule-title">{editorModel}</h3>
                    <button
                      type="button"
                      className="pricing-btn pricing-btn-secondary pricing-btn-sm"
                      onClick={closeRuleEditor}
                    >
                      关闭
                    </button>
                  </header>
                  <div className="pricing-rule-modal-body">
                    {editorRules.length === 0 ? (
                      <p className="hint">该模型尚无区间。</p>
                    ) : (
                      <div className="pricing-table-scroll">
                        <table className="pricing-table">
                          <thead>
                            <tr>
                              <th>起始</th>
                              <th className="pricing-date-end">结束</th>
                              <th>适用星期</th>
                              <th className="pricing-part-col pricing-rates-start">
                                时段
                              </th>
                              <th>
                                <span className="pricing-th-main">Input</span>
                              </th>
                              <th>
                                <span className="pricing-th-main">Output</span>
                              </th>
                              <th>
                                <span className="pricing-th-main">
                                  Cache Read
                                </span>
                              </th>
                              <th className="pricing-rates-end">
                                <span className="pricing-th-main">
                                  Cache Write
                                </span>
                              </th>
                              <th className="pricing-row-actions">操作</th>
                            </tr>
                          </thead>
                          <tbody>{renderIntervalEditor(editorModel)}</tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}

        {editorSubRule
          ? createPortal(
              <div
                className="pricing-rule-backdrop pricing-sub-backdrop"
                role="presentation"
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeSubEditor();
                }}
              >
                <div
                  className="pricing-rule-modal pricing-sub-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="pricing-sub-title"
                >
                  {modalToast ? (
                    <div
                      className={
                        "pricing-modal-toast" +
                        (modalToast.ok ? " is-ok" : " is-fail")
                      }
                      role="status"
                    >
                      {modalToast.message}
                    </div>
                  ) : null}
                  <header className="pricing-rule-modal-head">
                    <div>
                      <h3 id="pricing-sub-title">
                        价格规则 · {editorSubRule.model}
                      </h3>
                      <p className="hint pricing-sub-hint">
                        越靠上优先级越高。高峰行下方为高峰时段；未配置时按列表优先级，不区分钟点。再点选中行可取消选中。
                      </p>
                    </div>
                    <button
                      type="button"
                      className="pricing-btn pricing-btn-secondary pricing-btn-sm"
                      onClick={closeSubEditor}
                    >
                      关闭
                    </button>
                  </header>
                  <div className="pricing-rule-modal-body">
                    {(() => {
                      const rule = editorSubRule;
                      const modelLocked = table.lockedModels.includes(
                        rule.model.trim(),
                      );
                      const locked = modelLocked || !!rule.locked;
                      const lockHint = modelLocked
                        ? "已一级锁定，请先解锁模型"
                        : rule.locked
                          ? "已二级锁定，请先解锁区间"
                          : null;
                      const subs = ensureSubRules(rule);
                      const live = currentRatesForModel(
                        [rule],
                        rule.model,
                        now,
                      );
                      const liveId = live?.subRule?.id;
                      const selectedIndex = selectedSubId
                        ? subs.findIndex((s) => s.id === selectedSubId)
                        : -1;
                      const hasSelection = selectedIndex >= 0;
                      const requireSelect = (label: string) => {
                        if (hasSelection) return true;
                        flash(`请先选中一条子规则，再${label}`, false);
                        return false;
                      };
                      return (
                        <div className="pricing-sub-editor">
                        <div className="pricing-sub-layout">
                          <div className="pricing-table-scroll">
                            <table className="pricing-table pricing-sub-table">
                              <thead>
                                <tr>
                                  <th className="pricing-prio-col">当前有效</th>
                                  <th>适用星期</th>
                                  <th className="pricing-part-col pricing-rates-start">
                                    时段
                                  </th>
                                  <th>
                                    <span className="pricing-th-main">
                                      Input
                                    </span>
                                  </th>
                                  <th>
                                    <span className="pricing-th-main">
                                      Output
                                    </span>
                                  </th>
                                  <th>
                                    <span className="pricing-th-main">
                                      Cache Read
                                    </span>
                                  </th>
                                  <th className="pricing-rates-end">
                                    <span className="pricing-th-main">
                                      Cache Write
                                    </span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {subs.map((sub, index) => {
                                  const selected = selectedSubId === sub.id;
                                  const showPeakWindows = sub.band === "peak";
                                  const onRowClick = (
                                    e: MouseEvent<HTMLTableRowElement>,
                                  ) => {
                                    const el = e.target as HTMLElement;
                                    if (
                                      el.closest(
                                        "input, select, button, .pricing-weekday-chip",
                                      )
                                    ) {
                                      setSelectedSubId(sub.id);
                                      return;
                                    }
                                    setSelectedSubId((cur) =>
                                      cur === sub.id ? null : sub.id,
                                    );
                                  };
                                  return (
                                    <Fragment key={sub.id}>
                                  {index > 0 ? (
                                    <tr
                                      className="pricing-sub-gap"
                                      aria-hidden
                                    >
                                      <td colSpan={7} />
                                    </tr>
                                  ) : null}
                                  <tr
                                    className={
                                      "pricing-row pricing-sub-row pricing-band-" +
                                      sub.band +
                                      (liveId === sub.id ? " is-live" : "") +
                                      (selected ? " is-selected" : "") +
                                      (showPeakWindows
                                        ? " has-windows pricing-split-windows"
                                        : "")
                                    }
                                    onClick={onRowClick}
                                  >
                                    <td
                                      className={
                                        "pricing-prio-cell" +
                                        (liveId === sub.id
                                          ? " is-live-status"
                                          : "")
                                      }
                                      rowSpan={showPeakWindows ? 2 : 1}
                                    >
                                      {liveId === sub.id ? (
                                        <span className="pricing-live-status">
                                          <span
                                            className="pricing-live-dot"
                                            aria-hidden
                                          />
                                          生效中
                                        </span>
                                      ) : (
                                        <span className="pricing-current-empty">
                                          未生效
                                        </span>
                                      )}
                                    </td>
                                    <td
                                      className={
                                        "pricing-weekday-cell pricing-band-cell is-" +
                                        sub.band +
                                        (showPeakWindows
                                          ? " is-soft-top-left"
                                          : " is-soft-left")
                                      }
                                    >
                                      <WeekdayChips
                                        compact
                                        value={sub.peakWeekdays || []}
                                        disabled={locked}
                                        onChange={(next) =>
                                          patchSubRule(rule.id, sub.id, {
                                            peakWeekdays: next,
                                          })
                                        }
                                      />
                                    </td>
                                    <td
                                      className={
                                        "pricing-part-col pricing-rates-start pricing-band-cell is-" +
                                        sub.band
                                      }
                                    >
                                      <select
                                        className={
                                          "pricing-band-select is-" + sub.band
                                        }
                                        value={sub.band}
                                        disabled={locked}
                                        onChange={(e) =>
                                          patchSubRule(rule.id, sub.id, {
                                            band:
                                              e.target.value === "idle"
                                                ? "idle"
                                                : "peak",
                                          })
                                        }
                                      >
                                        <option value="idle">闲时</option>
                                        <option value="peak">高峰</option>
                                      </select>
                                    </td>
                                    {RATE_FIELDS.map((field, fi) => (
                                      <td
                                        key={field}
                                        className={
                                          "pricing-band-cell is-" +
                                          sub.band +
                                          (fi === RATE_FIELDS.length - 1
                                            ? " pricing-rates-end" +
                                              (showPeakWindows
                                                ? " is-soft-top-right"
                                                : " is-soft-right")
                                            : "")
                                        }
                                      >
                                        <PricingRateInput
                                          className={
                                            "pricing-rate-input is-" + sub.band
                                          }
                                          value={sub.rates[field]}
                                          disabled={locked}
                                          title={lockHint || "单价"}
                                          onCommit={(n) =>
                                            patchSubRule(rule.id, sub.id, {
                                              rates: {
                                                ...sub.rates,
                                                [field]: n,
                                              },
                                            })
                                          }
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                  {showPeakWindows ? (
                                    <tr
                                      className={
                                        "pricing-windows-row" +
                                        (selected ? " is-selected" : "")
                                      }
                                      onClick={onRowClick}
                                    >
                                      <td
                                        className="pricing-windows-cell pricing-band-cell is-peak is-soft-bottom"
                                        colSpan={6}
                                      >
                                        <div className="pricing-windows-inner">
                                          <span className="pricing-windows-label">
                                            高峰时段
                                          </span>
                                          {renderPeakWindowEditor(
                                            rule,
                                            locked,
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  ) : null}
                                    </Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <aside
                            className="pricing-sub-side"
                            aria-label="价格规则操作"
                          >
                            <button
                              type="button"
                              className="pricing-btn pricing-btn-secondary"
                              disabled={!hasSelection || selectedIndex === 0}
                              title={
                                hasSelection
                                  ? "上移（提高优先级）"
                                  : "请先选中一条价格规则"
                              }
                              onClick={() => {
                                if (lockHint) {
                                  flash(lockHint, false);
                                  return;
                                }
                                if (!requireSelect("上移")) return;
                                moveSubRule(
                                  rule.id,
                                  selectedIndex,
                                  selectedIndex - 1,
                                );
                              }}
                            >
                              上移
                            </button>
                            <button
                              type="button"
                              className="pricing-btn pricing-btn-secondary"
                              disabled={
                                !hasSelection ||
                                selectedIndex === subs.length - 1
                              }
                              title={
                                hasSelection
                                  ? "下移（降低优先级）"
                                  : "请先选中一条价格规则"
                              }
                              onClick={() => {
                                if (lockHint) {
                                  flash(lockHint, false);
                                  return;
                                }
                                if (!requireSelect("下移")) return;
                                moveSubRule(
                                  rule.id,
                                  selectedIndex,
                                  selectedIndex + 1,
                                );
                              }}
                            >
                              下移
                            </button>
                            <button
                              type="button"
                              className="pricing-btn pricing-btn-danger"
                              disabled={!hasSelection || subs.length <= 1}
                              title={
                                hasSelection
                                  ? "删除选中的价格规则"
                                  : "请先选中一条价格规则"
                              }
                              onClick={() => {
                                if (lockHint) {
                                  flash(lockHint, false);
                                  return;
                                }
                                if (!requireSelect("删除")) return;
                                const id = selectedSubId;
                                if (!id) return;
                                const nextSel =
                                  subs[selectedIndex + 1]?.id ||
                                  subs[selectedIndex - 1]?.id ||
                                  null;
                                removeSubRule(rule.id, id);
                                setSelectedSubId(
                                  nextSel === id ? null : nextSel,
                                );
                              }}
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              className="pricing-btn pricing-btn-secondary"
                              disabled={!hasSelection}
                              title={
                                hasSelection
                                  ? "复制选中的价格规则到列表顶部"
                                  : "请先选中一条价格规则"
                              }
                              onClick={() => {
                                if (lockHint) {
                                  flash(lockHint, false);
                                  return;
                                }
                                if (!requireSelect("复制")) return;
                                if (!selectedSubId) return;
                                copySubRule(rule.id, selectedSubId);
                              }}
                            >
                              复制
                            </button>
                            <button
                              type="button"
                              className="pricing-btn pricing-btn-accent"
                              title="在列表顶部新增一条价格规则"
                              onClick={() => {
                                if (lockHint) {
                                  flash(lockHint, false);
                                  return;
                                }
                                addSubRule(rule.id);
                              }}
                            >
                              新增
                            </button>
                          </aside>
                        </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  },
);
