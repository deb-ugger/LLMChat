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

function rates(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): TokenRates {
  return { input, output, cacheRead, cacheWrite };
}

function halfRates(r: TokenRates): TokenRates {
  return {
    input: r.input / 2,
    output: r.output / 2,
    cacheRead: r.cacheRead / 2,
    cacheWrite: r.cacheWrite / 2,
  };
}

function rule(
  vendor: string,
  model: string,
  from: string,
  r: TokenRates,
  to = "",
  idle?: TokenRates,
  peakWindows: PeakWindow[] = [],
): PricingRule {
  return {
    id: `builtin-${vendor}-${model}-${from || "open"}`,
    vendor,
    model,
    from,
    to,
    rates: r,
    idleRates: idle ? idle : { ...r },
    peakWindows: peakWindows.map((w) => ({ ...w })),
    locked: true,
  };
}

const FROM = ""; // empty = open start (不限起始)

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

/**
 * Official DeepSeek rates (CNY / 1M tokens) from pricing docs.
 * chat / reasoner aliases use Flash rates.
 */
export function deepSeekOfficialRates(model: string): {
  peak: TokenRates;
  idle: TokenRates;
} | null {
  const id = model.trim();
  if (!id.toLowerCase().startsWith("deepseek")) return null;
  const flashPeak = rates(3.0, 9.0, 0.1, 0);
  const flashIdle = rates(1.5, 4.5, 0.05, 0);
  const proPeak = rates(9.0, 27.0, 0.3, 0);
  const proIdle = rates(4.5, 13.5, 0.15, 0);
  if (id === "deepseek-v4-pro") return { peak: proPeak, idle: proIdle };
  // v4-flash + legacy aliases
  if (
    id === "deepseek-v4-flash" ||
    id === "deepseek-chat" ||
    id === "deepseek-reasoner" ||
    id.startsWith("deepseek-")
  ) {
    return { peak: flashPeak, idle: flashIdle };
  }
  return null;
}

function ratesRoughlyEqual(a: TokenRates, b: TokenRates): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

function peakWindowsEqual(a: PeakWindow[] | undefined, b: PeakWindow[]): boolean {
  const aa = [...(a || [])]
    .map((w) => `${w.from}-${w.to}`)
    .sort();
  const bb = [...b].map((w) => `${w.from}-${w.to}`).sort();
  if (aa.length !== bb.length) return false;
  return aa.every((s, i) => s === bb[i]);
}

function isDeepSeekOfficialInterval(rule: PricingRule): boolean {
  const off = deepSeekOfficialRates(rule.model);
  if (!off) return false;
  return (
    ratesRoughlyEqual(rule.rates, off.peak) &&
    ratesRoughlyEqual(rule.idleRates || rule.rates, off.idle) &&
    peakWindowsEqual(rule.peakWindows, DEFAULT_DEEPSEEK_PEAK_WINDOWS)
  );
}

function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysIsoLocal(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * For each DeepSeek model already in the table, ensure a date interval carries
 * the latest official rates + peak windows. Does not rewrite built-in defaults;
 * closes the previous open-ended interval and appends a new one from today.
 */
export function appendDeepSeekOfficialDateIntervals(
  rules: PricingRule[],
  opts?: { today?: string; lockedModels?: string[] },
): { rules: PricingRule[]; addedModels: string[] } {
  const today = opts?.today || todayIsoLocal();
  const yesterday = addDaysIsoLocal(today, -1);
  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!id) continue;
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push(r);
  }

  const out = rules.map((r) => ({
    ...r,
    rates: { ...r.rates },
    idleRates: { ...(r.idleRates || r.rates) },
    peakWindows: (r.peakWindows || []).map((w) => ({ ...w })),
    locked: !!r.locked,
  }));
  const addedModels: string[] = [];

  for (const [model, list] of byModel) {
    const off = deepSeekOfficialRates(model);
    if (!off) continue;
    if (list.some((r) => isDeepSeekOfficialInterval(r))) continue;

    const sorted = [...list].sort((a, b) =>
      (a.from || "0000-01-01").localeCompare(b.from || "0000-01-01"),
    );
    const open = sorted.find((r) => !(r.to || "").trim()) || sorted[sorted.length - 1];
    if (!open) continue;
    // Do not alter a locked interval (level-2) or a model under level-1 lock.
    if (open.locked) continue;
    if ((opts?.lockedModels || []).includes(model)) continue;

    const openIdx = out.findIndex((r) => r.id === open.id);
    if (openIdx < 0) continue;

    const openFrom = (out[openIdx]!.from || "").trim();
    // Cannot close an interval that starts today/future — update in place instead.
    if (openFrom && openFrom >= today) {
      out[openIdx] = {
        ...out[openIdx]!,
        rates: { ...off.peak },
        idleRates: { ...off.idle },
        peakWindows: DEFAULT_DEEPSEEK_PEAK_WINDOWS.map((w) => ({ ...w })),
        to: "",
      };
      addedModels.push(model);
      continue;
    }

    // Close previous open-ended range at yesterday (inclusive).
    if (!(out[openIdx]!.to || "").trim()) {
      if (openFrom && yesterday < openFrom) {
        // Zero-width — just overwrite
        out[openIdx] = {
          ...out[openIdx]!,
          rates: { ...off.peak },
          idleRates: { ...off.idle },
          peakWindows: DEFAULT_DEEPSEEK_PEAK_WINDOWS.map((w) => ({ ...w })),
        };
        addedModels.push(model);
        continue;
      }
      out[openIdx] = { ...out[openIdx]!, to: yesterday };
    }

    out.push({
      id: newRuleId(),
      vendor: out[openIdx]!.vendor || "DeepSeek",
      model,
      from: today,
      to: "",
      rates: { ...off.peak },
      idleRates: { ...off.idle },
      peakWindows: DEFAULT_DEEPSEEK_PEAK_WINDOWS.map((w) => ({ ...w })),
      locked: false,
    });
    addedModels.push(model);
  }

  return { rules: out, addedModels };
}

/** Default price table used for reset / display when API empty. */
const DEFAULT_RULES: PricingRule[] = (() => {
  // Built-in baseline (not the latest official cutover — that is appended as a
  // new date interval via appendDeepSeekOfficialDateIntervals).
  // DeepSeek — CNY
  const dsFlash = rates(1.0, 2.0, 0.02, 0);
  const dsPro = rates(3.0, 6.0, 0.025, 0);
  const dsChat = rates(1.0, 2.0, 0.02, 0);
  const dsPeakLegacy: PeakWindow[] = [{ from: "08:30", to: "00:30" }];
  return [
    rule(
      "DeepSeek",
      "deepseek-v4-flash",
      FROM,
      dsFlash,
      "",
      halfRates(dsFlash),
      dsPeakLegacy,
    ),
    rule(
      "DeepSeek",
      "deepseek-v4-pro",
      FROM,
      dsPro,
      "",
      halfRates(dsPro),
      dsPeakLegacy,
    ),
    rule(
      "DeepSeek",
      "deepseek-chat",
      FROM,
      dsChat,
      "",
      halfRates(dsChat),
      dsPeakLegacy,
    ),
    rule(
      "DeepSeek",
      "deepseek-reasoner",
      FROM,
      dsChat,
      "",
      halfRates(dsChat),
      dsPeakLegacy,
    ),
    // OpenAI — USD（无官方闲时价 → 空高峰时段 = 始终高峰价）
    rule("OpenAI", "gpt-4o", FROM, rates(2.5, 10.0, 1.25, 2.5)),
    rule("OpenAI", "gpt-4o-mini", FROM, rates(0.15, 0.6, 0.075, 0.15)),
    rule("OpenAI", "gpt-4-turbo", FROM, rates(10.0, 30.0, 5.0, 10.0)),
    rule("OpenAI", "gpt-3.5-turbo", FROM, rates(0.5, 1.5, 0.25, 0.5)),
    // Google — USD
    rule("Google", "gemini-2.0-flash", FROM, rates(0.1, 0.4, 0.025, 0.1)),
    // 通义千问 — CNY
    rule("通义千问", "qwen-plus", FROM, rates(0.8, 2.0, 0.16, 0.8)),
    rule("通义千问", "qwen-turbo", FROM, rates(0.3, 0.6, 0.06, 0.3)),
  ];
})();

export const DEFAULT_PRICING_TABLE: PricingTable = {
  displayCurrency: "CNY",
  vendorCurrencies: { ...DEFAULT_VENDOR_CURRENCIES },
  lockedModels: [...new Set(DEFAULT_RULES.map((r) => r.model))],
  rules: DEFAULT_RULES,
};

export function emptyRates(): TokenRates {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function newRuleId(): string {
  return `p${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
}

export function cloneDefaultPricingTable(): PricingTable {
  const rules = DEFAULT_PRICING_TABLE.rules.map((r) => ({
    ...r,
    id: newRuleId(),
    rates: { ...r.rates },
    idleRates: { ...(r.idleRates || r.rates) },
    peakWindows: (r.peakWindows || []).map((w) => ({ ...w })),
    locked: r.locked !== false,
  }));
  return {
    displayCurrency: DEFAULT_PRICING_TABLE.displayCurrency,
    vendorCurrencies: { ...DEFAULT_PRICING_TABLE.vendorCurrencies },
    lockedModels: [...new Set(rules.map((r) => r.model).filter(Boolean))],
    rules,
  };
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

/**
 * Empty peakWindows → always peak.
 * Otherwise true when local time falls in any window.
 */
export function isPeakLocalTime(
  time: string,
  peakWindows: PeakWindow[] | undefined,
): boolean {
  const wins = peakWindows || [];
  if (wins.length === 0) return true;
  return wins.some((w) => isInHalfOpenTimeRange(time, w.from, w.to));
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
