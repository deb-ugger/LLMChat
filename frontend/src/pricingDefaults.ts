/** Built-in default rates per 1M tokens. Currency is per vendor (see vendorCurrencies). */

export type PricingCurrency = "CNY" | "USD";

export type TokenRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Local-time peak window (HH:mm). Half-open [from, to); supports overnight wrap. */
export type PeakWindow = {
  from: string;
  to: string;
};

/** @deprecated Legacy global idle window; migrated into per-rule peakWindows on load. */
export type PricingDayParts = {
  idleFrom: string;
  idleTo: string;
};

export type PricingBand = "idle" | "peak";

/**
 * One weekday + band + rates row inside a date interval.
 * Array order is priority: index 0 wins when multiple sub-rules match.
 */
export type PricingSubRule = {
  id: string;
  peakWeekdays?: number[];
  band: PricingBand;
  rates: TokenRates;
};

export type PricingRule = {
  id: string;
  vendor: string;
  model: string;
  /** Inclusive start YYYY-MM-DD */
  from: string;
  /** Inclusive end YYYY-MM-DD; empty = open */
  to: string;
  /** Peak / default rates in the vendor's billing currency */
  rates: TokenRates;
  /**
   * Idle-period rates (always present in UI).
   * Used when event local time is outside this rule's peakWindows.
   */
  idleRates: TokenRates;
  /**
   * Custom peak windows for this date-interval entry.
   * Empty = always peak (use rates). Non-empty: in any window → rates, else idleRates.
   */
  peakWindows: PeakWindow[];
  /**
   * ISO weekdays that may use peak rates: 1=Mon … 7=Sun.
   * Empty = every day (default). Length 7 is stored as empty.
   * @deprecated Prefer per-sub-rule peakWeekdays
   */
  peakWeekdays?: number[];
  /**
   * Sub-rules inside this date interval (星期 + 时段 + 四列价).
   * First matching entry wins (top of the list = highest priority).
   */
  subRules?: PricingSubRule[];
  /** Level-2 lock: this date-interval cannot be edited until unlocked */
  locked?: boolean;
};

export type PricingTable = {
  displayCurrency: PricingCurrency;
  /** Billing currency for each vendor */
  vendorCurrencies: Record<string, PricingCurrency>;
  /**
   * Level-1 lock: models listed here cannot be edited until unlocked.
   * Also freezes toggles of per-interval (level-2) locks.
   */
  lockedModels: string[];
  /** @deprecated Kept for migrating old pricing.json only */
  dayParts?: PricingDayParts;
  rules: PricingRule[];
};

export const DEFAULT_DAY_PARTS: PricingDayParts = {
  idleFrom: "00:30",
  idleTo: "08:30",
};

/**
 * DeepSeek 官方高峰时段（北京时间）：9:00–12:00、14:00–18:00。
 * @see https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 */
export const DEFAULT_DEEPSEEK_PEAK_WINDOWS: PeakWindow[] = [
  { from: "09:00", to: "12:00" },
  { from: "14:00", to: "18:00" },
];

function ratesRoughlyEqual(a: TokenRates, b: TokenRates): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}
/** Default billing currency by vendor. */
export const DEFAULT_VENDOR_CURRENCIES: Record<string, PricingCurrency> = {
  DeepSeek: "CNY",
  OpenAI: "USD",
  Google: "USD",
  通义千问: "CNY",
};

export function defaultVendorCurrency(vendor: string): PricingCurrency {
  const v = vendor.trim();
  if (v in DEFAULT_VENDOR_CURRENCIES) return DEFAULT_VENDOR_CURRENCIES[v]!;
  return "USD";
}

export function emptyRates(): TokenRates {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function newRuleId(): string {
  return `p${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
}

export function newSubRuleId(): string {
  return `s${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
}

export function normalizeSubRule(raw: Partial<PricingSubRule> | null | undefined): PricingSubRule {
  const band = raw?.band === "idle" ? "idle" : "peak";
  return {
    id: String(raw?.id || "").trim() || newSubRuleId(),
    peakWeekdays: normalizePeakWeekdays(raw?.peakWeekdays),
    band,
    rates: { ...emptyRates(), ...(raw?.rates || {}) },
  };
}

export function defaultSubRules(seed?: {
  peakWeekdays?: number[];
  rates?: TokenRates;
  idleRates?: TokenRates;
}): PricingSubRule[] {
  const days = normalizePeakWeekdays(seed?.peakWeekdays);
  const peak = { ...emptyRates(), ...(seed?.rates || {}) };
  const idle = { ...emptyRates(), ...(seed?.idleRates || seed?.rates || {}) };
  return [
    {
      id: newSubRuleId(),
      peakWeekdays: [...days],
      band: "idle",
      rates: idle,
    },
    {
      id: newSubRuleId(),
      peakWeekdays: [...days],
      band: "peak",
      rates: peak,
    },
  ];
}

export function ensureSubRules(rule: PricingRule): PricingSubRule[] {
  if (Array.isArray(rule.subRules) && rule.subRules.length > 0) {
    return rule.subRules.map((s) => normalizeSubRule(s));
  }
  return defaultSubRules(rule);
}

export function syncLegacyRates(rule: PricingRule): PricingRule {
  const subs = ensureSubRules(rule);
  const peak = subs.find((s) => s.band === "peak");
  const idle = subs.find((s) => s.band === "idle");
  return {
    ...rule,
    subRules: subs,
    rates: peak ? { ...peak.rates } : { ...rule.rates },
    idleRates: idle
      ? { ...idle.rates }
      : { ...(rule.idleRates || rule.rates) },
  };
}

export function weekdayApplies(
  days: number[] | undefined,
  date: string,
): boolean {
  const n = normalizePeakWeekdays(days);
  if (n.length === 0) return true;
  const wd = isoWeekdayFromDate(date);
  return !!wd && n.includes(wd);
}

export function formatWeekdaysHint(days: number[] | undefined): string {
  const n = normalizePeakWeekdays(days);
  if (n.length === 0) return "每天";
  const labels = ["", "一", "二", "三", "四", "五", "六", "日"];
  return n.map((d) => labels[d] || "").join("");
}

export function formatPeakWindowsHint(
  wins: PeakWindow[] | undefined,
): string {
  const list = wins || [];
  if (list.length === 0) return "未配置（按列表优先级，不区分钟点）";
  return list
    .map((w) => `${(w.from || "").slice(0, 5)}–${(w.to || "").slice(0, 5)}`)
    .join("、");
}

/**
 * First list entry that matches weekday wins when peak windows are empty.
 * With windows, first weekday + idle/peak band match wins; else first weekday.
 */
export function matchSubRule(
  rule: PricingRule,
  date: string,
  time: string,
): PricingSubRule | null {
  const subs = ensureSubRules(rule);
  if (subs.length === 0) return null;
  const hasWindows = (rule.peakWindows || []).length > 0;
  const wantBand: PricingBand = isPeakLocalTime(time, rule.peakWindows)
    ? "peak"
    : "idle";
  let firstWeekday: PricingSubRule | null = null;
  for (const s of subs) {
    if (!weekdayApplies(s.peakWeekdays, date)) continue;
    if (!firstWeekday) firstWeekday = s;
    if (!hasWindows) return s;
    if (s.band === wantBand) return s;
  }
  return firstWeekday || subs[0] || null;
}

/** Merge newly appeared model IDs into the level-1 lock set. */
export function lockNewModels(
  prevRules: PricingRule[],
  nextRules: PricingRule[],
  lockedModels: string[],
): string[] {
  const prev = new Set(prevRules.map((r) => r.model).filter(Boolean));
  const locked = new Set(lockedModels.map((m) => m.trim()).filter(Boolean));
  for (const r of nextRules) {
    const id = r.model.trim();
    if (id && !prev.has(id)) locked.add(id);
  }
  return [...locked];
}

export function formatMoney(n: number, currency: PricingCurrency): string {
  const sym = currency === "USD" ? "$" : "¥";
  if (!Number.isFinite(n) || n === 0) return `${sym}0.00`;
  const abs = Math.abs(n);
  if (abs < 0.0001) return `<${sym}0.0001`;
  if (abs < 0.01) return `${sym}${n.toFixed(4)}`;
  return `${sym}${n.toFixed(2)}`;
}

/** Parse "HH:mm" / "HH:mm:ss" → minutes from midnight; -1 if invalid. */
export function parseTimeToMinutes(raw: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw || "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/** Half-open [from, to) in local HH:mm; supports overnight wrap. */
export function isInHalfOpenTimeRange(
  time: string,
  from: string,
  to: string,
): boolean {
  const t = parseTimeToMinutes(time);
  const a = parseTimeToMinutes(from);
  const b = parseTimeToMinutes(to);
  if (t < 0 || a < 0 || b < 0) return false;
  if (a === b) return false;
  if (a < b) return t >= a && t < b;
  return t >= a || t < b;
}

/** 1=Mon … 7=Sun. Empty or all seven → every day. */
export function normalizePeakWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const item of raw) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n);
  }
  const out = [...set].sort((a, b) => a - b);
  return out.length === 7 ? [] : out;
}

/** Local ISO weekday from YYYY-MM-DD; 0 if invalid. */
export function isoWeekdayFromDate(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return 0;
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

export function dateInInclusiveRange(
  date: string,
  from: string,
  to: string,
): boolean {
  const d = date.trim();
  if (!d) return false;
  if (from.trim() && d < from.trim()) return false;
  if (to.trim() && d > to.trim()) return false;
  return true;
}

/**
 * Empty peakWindows → not peak (list priority decides the sub-rule).
 * Otherwise true when local time falls in any window.
 */
export function isPeakLocalTime(
  time: string,
  peakWindows: PeakWindow[] | undefined,
): boolean {
  const wins = peakWindows || [];
  if (wins.length === 0) return false;
  return wins.some((w) => isInHalfOpenTimeRange(time, w.from, w.to));
}

/** Peak if weekday is allowed and clock is in a peak window. */
export function isPeakForRule(
  date: string,
  time: string,
  rule: Pick<PricingRule, "peakWindows" | "peakWeekdays">,
): boolean {
  const days = normalizePeakWeekdays(rule.peakWeekdays);
  if (days.length > 0) {
    const wd = isoWeekdayFromDate(date);
    if (!wd || !days.includes(wd)) return false;
  }
  if (!time.trim()) return true;
  return isPeakLocalTime(time, rule.peakWindows);
}

export type CurrentModelRates = {
  rates: TokenRates;
  band: "idle" | "peak";
  rule: PricingRule;
  subRule: PricingSubRule | null;
};

/** Effective rates for a model at local now (or given date/time). */
export function currentRatesForModel(
  rules: PricingRule[],
  model: string,
  now: Date = new Date(),
): CurrentModelRates | null {
  const id = model.trim();
  if (!id) return null;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  let best: PricingRule | null = null;
  for (const r of rules) {
    if (r.model.trim() !== id) continue;
    if (!dateInInclusiveRange(date, r.from, r.to)) continue;
    if (
      !best ||
      (r.from || "") > (best.from || "") ||
      ((r.from || "") === (best.from || "") && !best.to.trim() && r.to.trim())
    ) {
      best = r;
    }
  }
  if (!best) return null;
  const sub = matchSubRule(best, date, time);
  if (sub) {
    return {
      rates: { ...sub.rates },
      band: sub.band,
      rule: best,
      subRule: sub,
    };
  }
  const peak = isPeakForRule(date, time, best);
  return {
    rates: peak ? { ...best.rates } : { ...(best.idleRates || best.rates) },
    band: peak ? "peak" : "idle",
    rule: best,
    subRule: null,
  };
}

export function formatIntervalHint(rule: PricingRule): string {
  const from = (rule.from || "").trim();
  const to = (rule.to || "").trim();
  if (!from && !to) return "不限日期";
  if (from && !to) return `${from} 起`;
  if (!from && to) return `至 ${to}`;
  return `${from} ~ ${to}`;
}

/** Legacy: idle = complement of peak derived from global dayParts. */
export function isIdleLocalTime(
  time: string,
  dayParts: PricingDayParts,
): boolean {
  const peak = peakWindowsFromIdleDayParts(dayParts);
  return !isPeakLocalTime(time, peak);
}

/** Convert legacy global idle [idleFrom, idleTo) → peak complement window. */
export function peakWindowsFromIdleDayParts(
  dayParts: PricingDayParts,
): PeakWindow[] {
  const idleFrom =
    (dayParts.idleFrom || "").trim() || DEFAULT_DAY_PARTS.idleFrom;
  const idleTo = (dayParts.idleTo || "").trim() || DEFAULT_DAY_PARTS.idleTo;
  if (parseTimeToMinutes(idleFrom) < 0 || parseTimeToMinutes(idleTo) < 0) {
    return DEFAULT_DEEPSEEK_PEAK_WINDOWS.map((w) => ({ ...w }));
  }
  if (idleFrom === idleTo) return [];
  return [{ from: idleTo, to: idleFrom }];
}

/** Normalize / migrate peakWindows for one rule. */
export function normalizePeakWindows(
  raw: PeakWindow[] | undefined,
  rates: TokenRates,
  idleRates: TokenRates,
  dayParts?: PricingDayParts,
): PeakWindow[] {
  if (Array.isArray(raw)) {
    return raw
      .map((w) => ({
        from: String(w?.from || "").trim().slice(0, 5),
        to: String(w?.to || "").trim().slice(0, 5),
      }))
      .filter(
        (w) =>
          parseTimeToMinutes(w.from) >= 0 && parseTimeToMinutes(w.to) >= 0,
      );
  }
  // Legacy: only invent a peak window when idle rates differ (had real idle pricing)
  if (dayParts && !ratesRoughlyEqual(rates, idleRates)) {
    return peakWindowsFromIdleDayParts(dayParts);
  }
  return [];
}
