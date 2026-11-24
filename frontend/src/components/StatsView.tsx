import { EmptyState } from "./EmptyState";
import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import { writeOutput } from "../appOutput";


import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { createPortal } from "react-dom";
import {
api,
type PricingCurrency,
type PricingRule,
type UsageEvent,
type UsageSummaryItem,
} from "../api";
import { toFriendlyError } from "../friendlyError";
import {
formatMoney
} from "../pricingDefaults";
import { FEATURE_LABEL,FEATURE_OPTIONS,UsageBarChart,bandLabel,formatTokenExact,hasConsumption,isSupplementEvent,localDateString,nonCachedInput,parseLocalDate,shortUsageModelName,tokenFieldForSum,tokenTotalOf,type ActorOption,type GroupBy } from "./StatsChart";


type OkFilter = "" | "ok" | "fail" | "supplement";
type BandFilter = "" | "idle" | "peak" | "flat";
type RangePreset =
  | "today"
  | "yesterday"
  | "7"
  | "15"
  | "30"
  | "90"
  | "month"
  | "custom";

const STATS_FILTERS_KEY = "llmchat-stats-filters";
const DETAIL_PAGE_SIZE = 100;

/** 千分位整数，KPI 与明细共用一个口径。 */
function intText(value: number): string {
  return Math.round(value || 0).toLocaleString("zh-CN");
}

/**
 * 大数用「万 / 亿」收口：五位以上的 Token 数在 KPI 里读不出来，
 * 明细表仍按精确值显示。
 */
function metricText(value: number): { text: string; unit: string } {
  const n = value || 0;
  const abs = Math.abs(n);
  if (abs >= 1e8) return { text: (n / 1e8).toFixed(2), unit: "亿" };
  if (abs >= 1e4) return { text: (n / 1e4).toFixed(1), unit: "万" };
  return { text: intText(n), unit: "" };
}

function MetricValue({ value, suffix, compact }: {
  value: number;
  suffix?: string;
  compact?: boolean;
}) {
  const { text, unit } = compact ? metricText(value) : { text: intText(value), unit: "" };
  return (
    <span className="stats-kpi-value">
      {text}
      {unit && <em>{unit}</em>}
      {suffix && <em>{suffix}</em>}
    </span>
  );
}

function MetricPart({ label, value, tone, compact }: {
  label: string;
  value: number;
  tone?: "ok" | "fail" | "supplement";
  compact?: boolean;
}) {
  const { text, unit } = compact ? metricText(value) : { text: intText(value), unit: "" };
  return (
    <span className={`stats-kpi-part${tone ? ` is-${tone}` : ""}`}>
      <span className="stats-kpi-part-label">{label}</span>
      <span className="stats-kpi-part-value">
        {text}
        {unit && <em>{unit}</em>}
      </span>
    </span>
  );
}

type StatsFiltersState = {
  rangePreset: RangePreset;
  customFrom: string;
  customTo: string;
  feature: string;
  okFilter: OkFilter;
  bandFilter: BandFilter;
  groupBy: GroupBy;
  metric: "requests" | "tokens" | "cost";
};

const RANGE_PRESETS = new Set<RangePreset>([
  "today",
  "yesterday",
  "7",
  "15",
  "30",
  "90",
  "month",
  "custom",
]);

const RANGE_PRESET_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7", label: "近 7 天" },
  { value: "15", label: "近 15 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
  { value: "month", label: "本月" },
];

function isRangePreset(v: unknown): v is RangePreset {
  return typeof v === "string" && RANGE_PRESETS.has(v as RangePreset);
}
function isGroupBy(v: unknown): v is GroupBy {
  return (
    v === "feature" ||
    v === "engine" ||
    v === "llm" ||
    v === "day" ||
    v === "band"
  );
}

function isBandFilter(v: unknown): v is BandFilter {
  return v === "" || v === "idle" || v === "peak" || v === "flat";
}

function isOkFilter(v: unknown): v is OkFilter {
  return v === "" || v === "ok" || v === "fail" || v === "supplement";
}

function isMetric(v: unknown): v is StatsFiltersState["metric"] {
  return v === "requests" || v === "tokens" || v === "cost";
}

function monthToDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
  return { from: localDateString(from), to: localDateString(to) };
}

function rangeFromPreset(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const todayStr = localDateString(now);
  if (preset === "custom") return { from: "", to: "" };
  if (preset === "month") return monthToDateRange();
  if (preset === "today") return { from: todayStr, to: todayStr };
  if (preset === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yStr = localDateString(y);
    return { from: yStr, to: yStr };
  }
  const days = Number(preset);
  const from = new Date(now);
  from.setDate(from.getDate() - (days - 1));
  return { from: localDateString(from), to: todayStr };
}

const CALENDAR_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function startOfCalendarMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addCalendarMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function calendarMonthTitle(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function calendarMonthCells(month: Date): Array<Date | null> {
  const first = startOfCalendarMonth(month);
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = Array(first.getDay()).fill(null);
  for (let day = 1; day <= count; day += 1) {
    cells.push(new Date(first.getFullYear(), first.getMonth(), day));
  }
  while (cells.length < 42) cells.push(null);
  return cells;
}

function DateRangePicker({
  from,
  to,
  today,
  preset,
  open,
  onOpenChange,
  onPresetChange,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  preset: RangePreset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPresetChange: (preset: RangePreset) => void;
  onChange: (from: string, to: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const todayDate = useMemo(() => parseLocalDate(today) ?? new Date(), [today]);
  const latestAnchor = useMemo(
    () => addCalendarMonths(startOfCalendarMonth(todayDate), -1),
    [todayDate],
  );
  const initialAnchor = useCallback(() => {
    const selected = parseLocalDate(from);
    const wanted = selected ? startOfCalendarMonth(selected) : latestAnchor;
    return wanted > latestAnchor ? latestAnchor : wanted;
  }, [from, latestAnchor]);
  const [anchorMonth, setAnchorMonth] = useState<Date>(initialAnchor);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [hovered, setHovered] = useState("");
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const viewport = getLayoutViewport();
    const rect = getLayoutRect(trigger.getBoundingClientRect(), viewport.scale);
    const width = Math.min(680, Math.max(300, viewport.width - 24));
    const estimatedHeight = 370;
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, viewport.width - width - 12),
    );
    const below = rect.bottom + 7;
    const top =
      below + estimatedHeight <= viewport.height
        ? below
        : Math.max(12, rect.top - estimatedHeight - 7);
    setPopoverStyle({ left, top, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    setAnchorMonth(initialAnchor());
    setDraftFrom(from);
    setDraftTo(to);
    setSelectingEnd(false);
    setHovered("");
    updatePopoverPosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        onOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [from, initialAnchor, onOpenChange, open, to, updatePopoverPosition]);

  const chooseDate = (date: Date) => {
    const value = localDateString(date);
    if (!selectingEnd || !draftFrom) {
      setDraftFrom(value);
      setDraftTo("");
      setSelectingEnd(true);
      setHovered("");
      return;
    }
    const nextFrom = value < draftFrom ? value : draftFrom;
    const nextTo = value < draftFrom ? draftFrom : value;
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    setSelectingEnd(false);
    setHovered("");
    onChange(nextFrom, nextTo);
    onOpenChange(false);
  };

  const previewFrom = draftFrom;
  const previewTo = selectingEnd && hovered ? hovered : draftTo;
  const previewLow =
    previewFrom && previewTo && previewTo < previewFrom ? previewTo : previewFrom;
  const previewHigh =
    previewFrom && previewTo && previewTo < previewFrom ? previewFrom : previewTo;

  const renderMonth = (month: Date) => (
    <section className="stats-calendar-month" key={localDateString(month)}>
      <h3>{calendarMonthTitle(month)}</h3>
      <div className="stats-calendar-weekdays" aria-hidden="true">
        {CALENDAR_WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="stats-calendar-days">
        {calendarMonthCells(month).map((date, index) => {
          if (!date) return <span key={`blank-${index}`} />;
          const value = localDateString(date);
          const isFuture = value > today;
          const isStart = value === draftFrom;
          const isEnd = value === draftTo;
          const isInRange =
            !!previewLow && !!previewHigh && value >= previewLow && value <= previewHigh;
          return (
            <button
              type="button"
              key={value}
              className={[
                isInRange ? "is-in-range" : "",
                isStart ? "is-start" : "",
                isEnd ? "is-end" : "",
                value === today ? "is-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={isFuture}
              aria-label={value}
              aria-pressed={isStart || isEnd}
              onPointerEnter={() => selectingEnd && setHovered(value)}
              onFocus={() => selectingEnd && setHovered(value)}
              onClick={() => chooseDate(date)}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );

  const rangeText =
    from && to
      ? `${from.replaceAll("-", "/")}  →  ${to.replaceAll("-", "/")}`
      : "请选择日期范围";

  return (
    <div className="stats-date-range-picker">
      <button
        ref={triggerRef}
        type="button"
        className="stats-date-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="stats-date-range-trigger-copy">
          <span>{rangeText}</span>
        </span>
        <span
          className={`stats-date-range-icon${open ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 20 20" focusable="false">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="stats-date-range-popover"
              style={popoverStyle}
              role="dialog"
              aria-label="选择时间范围"
            >
              <div className="stats-date-range-layout">
                <nav className="stats-range-presets" aria-label="快捷时间范围">
                  {RANGE_PRESET_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={preset === option.value ? "is-active" : undefined}
                      aria-pressed={preset === option.value}
                      onClick={() => {
                        onPresetChange(option.value);
                        onOpenChange(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {preset === option.value ? (
                        <span className="stats-range-preset-check" aria-hidden="true">✓</span>
                      ) : null}
                    </button>
                  ))}
                </nav>
                <div className="stats-calendar-pane">
                  <div className="stats-calendar-toolbar">
                    <button
                      type="button"
                      aria-label="上两个月"
                      onClick={() =>
                        setAnchorMonth((month) => addCalendarMonths(month, -2))
                      }
                    >
                      ‹
                    </button>
                    <p>{selectingEnd ? "请选择结束日期" : "请选择起始日期"}</p>
                    <button
                      type="button"
                      aria-label="下两个月"
                      disabled={anchorMonth >= latestAnchor}
                      onClick={() =>
                        setAnchorMonth((month) => {
                          const next = addCalendarMonths(month, 2);
                          return next > latestAnchor ? latestAnchor : next;
                        })
                      }
                    >
                      ›
                    </button>
                  </div>
                  <div className="stats-calendar-months">
                    {renderMonth(anchorMonth)}
                    {renderMonth(addCalendarMonths(anchorMonth, 1))}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function loadStatsFilters(today: string): StatsFiltersState {
  const month = monthToDateRange();
  const defaults: StatsFiltersState = {
    rangePreset: "month",
    customFrom: month.from,
    customTo: month.to || today,
    feature: "",
    okFilter: "",
    bandFilter: "",
    groupBy: "day",
    metric: "tokens",
  };
  try {
    const raw = localStorage.getItem(STATS_FILTERS_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<StatsFiltersState>;
    const rangePreset = isRangePreset(saved.rangePreset)
      ? saved.rangePreset
      : defaults.rangePreset;
    let customFrom =
      typeof saved.customFrom === "string" ? saved.customFrom : defaults.customFrom;
    let customTo =
      typeof saved.customTo === "string" ? saved.customTo : defaults.customTo;
    if (rangePreset !== "custom") {
      const r = rangeFromPreset(rangePreset);
      customFrom = r.from;
      customTo = r.to;
    }
    const feature =
      typeof saved.feature === "string" &&
      FEATURE_OPTIONS.some((o) => o.value === saved.feature)
        ? saved.feature
        : defaults.feature;
    return {
      rangePreset,
      customFrom,
      customTo,
      feature,
      okFilter: isOkFilter(saved.okFilter) ? saved.okFilter : defaults.okFilter,
      bandFilter: isBandFilter(saved.bandFilter)
        ? saved.bandFilter
        : defaults.bandFilter,
      groupBy: isGroupBy(saved.groupBy) ? saved.groupBy : defaults.groupBy,
      metric: isMetric(saved.metric) ? saved.metric : defaults.metric,
    };
  } catch {
    return defaults;
  }
}

function saveStatsFilters(state: StatsFiltersState) {
  try {
    localStorage.setItem(STATS_FILTERS_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

function formatTokenCount(n: number): string {
  if (n < 0) return "未知";
  if (!Number.isFinite(n) || n <= 0) return "0";
  // 完整千分位：Token 数用于对账，不砍成「万」丢掉精度。
  return Math.round(n).toLocaleString("en-US");
}

function eventChannelLabel(ev: UsageEvent): string {
  if (ev.channel === "engine") return "在线引擎";
  if (ev.channel !== "llm") return ev.channel || "—";
  const host = ev.apiHost?.trim().toLowerCase();
  if (!host || host === "[") return "LLM（来源未知）";
  return /^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/.test(host) ? "本地 LLM" : "在线 LLM";
}

function eventRemark(ev: UsageEvent): string {
  const parts = [(ev.note || "").trim(), (ev.errorMessage || "").trim()].filter(
    Boolean,
  );
  if (parts.length > 0) return parts.join("；");
  if (!isSupplementEvent(ev) && !ev.ok && ev.errorCode === "PENDING")
    return "Token 消耗未知";
  return "—";
}

function TokenTotalCell({
  cacheRead,
  cacheWrite,
  input,
  output,
  total,
}: {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}) {
  const unknown = total < 0 || cacheRead < 0 || cacheWrite < 0 || input < 0 || output < 0;
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const sumParts =
    tokenFieldForSum(cacheRead) +
    tokenFieldForSum(cacheWrite) +
    tokenFieldForSum(input) +
    tokenFieldForSum(output);
  const displayTotal = unknown ? -1 : sumParts > 0 ? sumParts : total;

  const placeTip = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const viewport = getLayoutViewport();
    const r = getLayoutRect(el.getBoundingClientRect(), viewport.scale);
    const tipW = 180;
    const tipH = 128;
    let left = r.left;
    let top = r.bottom + 8;
    if (left + tipW > viewport.width - 8) {
      left = Math.max(8, viewport.width - tipW - 8);
    }
    if (top + tipH > viewport.height - 8) {
      top = Math.max(8, r.top - tipH - 8);
    }
    setPos({ top, left });
  }, []);

  const show = () => {
    placeTip();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <td className="stats-tokens-cell stats-col-tokens">
      <span
        ref={triggerRef}
        className="stats-tokens-trigger stats-mono"
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        tabIndex={0}
      >
        {formatTokenCount(displayTotal)}
      </span>
      {open &&
        createPortal(
          <div
            className="stats-tokens-tip is-fixed"
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={show}
            onMouseLeave={() => setOpen(false)}
          >
            <div className="stats-tokens-tip-row">
              <span>缓存读</span>
              <span>{formatTokenExact(cacheRead)}</span>
            </div>
            <div className="stats-tokens-tip-row">
              <span>缓存写</span>
              <span>{formatTokenExact(cacheWrite)}</span>
            </div>
            <div className="stats-tokens-tip-row">
              <span>输入</span>
              <span>{formatTokenExact(input)}</span>
            </div>
            <div className="stats-tokens-tip-row">
              <span>输出</span>
              <span>{formatTokenExact(output)}</span>
            </div>
            <div className="stats-tokens-tip-sep" />
            <div className="stats-tokens-tip-row is-total">
              <span>合计</span>
              <span>{formatTokenExact(displayTotal)}</span>
            </div>
          </div>,
          document.body,
        )}
    </td>
  );
}

export function StatsView({ active = true }: { active?: boolean }) {
  const today = localDateString(new Date());
  const initialFilters = useMemo(() => loadStatsFilters(today), [today]);
  const [rangePreset, setRangePreset] = useState<RangePreset>(
    () => initialFilters.rangePreset,
  );
  const [customFrom, setCustomFrom] = useState(() => initialFilters.customFrom);
  const [customTo, setCustomTo] = useState(() => initialFilters.customTo);
  const [feature, setFeature] = useState(() => initialFilters.feature);
  const [okFilter, setOkFilter] = useState<OkFilter>(
    () => initialFilters.okFilter,
  );
  const [bandFilter, setBandFilter] = useState<BandFilter>(
    () => initialFilters.bandFilter,
  );
  const [groupBy, setGroupBy] = useState<GroupBy>(() => initialFilters.groupBy);
  const [metric, setMetric] = useState<"requests" | "tokens" | "cost">(
    () => initialFilters.metric,
  );
  const [currency, setCurrency] = useState<PricingCurrency>("CNY");
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [selectedActor, setSelectedActor] = useState<ActorOption | null>(null);
  const [summary, setSummary] = useState<UsageSummaryItem[]>([]);
  /** Minute-level database aggregates used only by the chart. */
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [detailEvents, setDetailEvents] = useState<UsageEvent[]>([]);
  const [detailPage, setDetailPage] = useState(1);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailPages, setDetailPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [pricingReady, setPricingReady] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const loadedReportKeyRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);

  useEffect(() => {
    if (!active) loadedReportKeyRef.current = null;
  }, [active]);

  useEffect(() => {
    saveStatsFilters({
      rangePreset,
      customFrom,
      customTo,
      feature,
      okFilter,
      bandFilter,
      groupBy,
      metric,
    });
  }, [
    rangePreset,
    customFrom,
    customTo,
    feature,
    okFilter,
    bandFilter,
    groupBy,
    metric,
  ]);

  useEffect(() => {
    if (!active || pricingReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const pricing = await api.getPricing();
        if (cancelled) return;
        if (pricing.displayCurrency === "USD" || pricing.displayCurrency === "CNY") {
          setCurrency(pricing.displayCurrency);
        }
        setPricingRules(pricing.rules ?? []);
      } catch {
        // Reports still work with the default currency if pricing is unavailable.
      } finally {
        if (!cancelled) setPricingReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [active, pricingReady]);

  const range = useMemo(() => {
    if (rangePreset === "custom") {
      let from = customFrom;
      let to = customTo;
      if (from && to && from > to) {
        const t = from;
        from = to;
        to = t;
      }
      // 最短一天：起止同一天亦可
      return { from: from || "", to: to || "" };
    }
    return rangeFromPreset(rangePreset);
  }, [customFrom, customTo, rangePreset]);

  useEffect(() => {
    setSelectedActor(null);
    setDetailPage(1);
  }, [bandFilter, feature, groupBy, okFilter, range.from, range.to]);

  const applyPreset = (preset: RangePreset) => {
    setRangePreset(preset);
    setDateRangeOpen(preset === "custom");
    if (preset !== "custom") {
      const r = rangeFromPreset(preset);
      setCustomFrom(r.from);
      setCustomTo(r.to);
    }
  };

  const onCustomRange = useCallback((from: string, to: string) => {
    setRangePreset("custom");
    setCustomFrom(from);
    setCustomTo(to);
  }, []);

  const onDateRangeOpenChange = useCallback((nextOpen: boolean) => {
    setDateRangeOpen(nextOpen);
  }, []);

  const reportKey = JSON.stringify([
    bandFilter, currency, feature, groupBy, okFilter, range.from, range.to,
  ]);
  const load = useCallback(async (forceFull = false) => {
    if (!active || !pricingReady) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const detailsOnly = !forceFull && loadedReportKeyRef.current === reportKey;
    setLoading(!detailsOnly);
    setDetailsLoading(true);
    setError(null);
    try {
      if (!range.from || !range.to) {
        setSummary([]);
        setEvents([]);
        setDetailEvents([]);
        setDetailTotal(0);
        setDetailPages(0);
        loadedReportKeyRef.current = null;
        return;
      }
      const report = await api.usageReport({
        from: range.from,
        to: range.to,
        feature: feature || undefined,
        groupBy,
        ok: okFilter || undefined,
        currency,
        band: bandFilter || undefined,
        page: detailPage,
        pageSize: DETAIL_PAGE_SIZE,
        detailsOnly,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!detailsOnly) {
        setSummary((report.summary ?? []).filter(hasConsumption));
        setEvents(report.chart ?? []);
        loadedReportKeyRef.current = reportKey;
      }
      setDetailEvents(report.events ?? []);
      if (!detailsOnly) writeOutput(["统计", "用量报告"], `已刷新 · ${report.pagination?.total || 0} 条记录`, "success", false, reportKey);
      setDetailTotal(report.pagination?.total ?? 0);
      setDetailPages(report.pagination?.pages ?? 0);
    } catch (error) {
      if (controller.signal.aborted) return;
      const detail = toFriendlyError(error, "加载统计失败");
      setError(detail); writeOutput(["统计", "用量报告"], detail, "error", true, reportKey);
      if (!detailsOnly) {
        setSummary([]);
        setEvents([]);
        loadedReportKeyRef.current = null;
      }
      setDetailEvents([]);
      setDetailTotal(0);
      setDetailPages(0);
    } finally {
      if (requestRef.current === controller) {
        setLoading(false);
        setDetailsLoading(false);
        requestRef.current = null;
      }
    }
  }, [
    active, pricingReady, reportKey, bandFilter, currency, detailPage, feature,
    groupBy, okFilter, range.from, range.to,
  ]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [load]);

  const totals = useMemo(() => {
    return summary.reduce(
      (acc, r) => {
        acc.requests += r.requests;
        acc.ok += r.ok;
        acc.fail += r.fail;
        acc.supplement += r.supplement ?? 0;
        acc.tokens += tokenTotalOf(r);
        acc.cacheRead += tokenFieldForSum(r.cacheReadTokens);
        acc.cacheWrite += tokenFieldForSum(r.cacheWriteTokens);
        acc.input += nonCachedInput(r);
        acc.output += tokenFieldForSum(r.completionTokens);
        acc.cost += r.cost ?? 0;
        return acc;
      },
      {
        requests: 0,
        ok: 0,
        fail: 0,
        supplement: 0,
        tokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        cost: 0,
      },
    );
  }, [summary]);

  const sortedEvents = useMemo(
    () =>
      [...detailEvents].sort((a, b) =>
        a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
      ),
    [detailEvents],
  );

  // 整列都是同一个值的列对读者没有信息量，直接收起；收起后不再占宽度。
  const detailView = useMemo(() => {
    const rows = sortedEvents;
    const hasBand = rows.some((ev) => ev.pricingBand === "idle" || ev.pricingBand === "peak");
    const hasChars = rows.some((ev) => (ev.sourceChars ?? 0) > 0);
    const hasRemark = rows.some((ev) => eventRemark(ev) !== "—");
    const sameDay = rows.length > 0 && rows.every((ev) => ev.date === rows[0].date);
    return {
      hasBand,
      hasChars,
      hasRemark,
      sameDay,
      columns: 7 + (hasChars ? 1 : 0) + (hasRemark ? 1 : 0),
      collapsed: [
        hasBand ? null : "时段",
        hasChars ? null : "原文长度",
        hasRemark ? null : "备注",
      ].filter((item): item is string => Boolean(item)),
    };
  }, [sortedEvents]);

  return (
    <div className="stats-page" aria-hidden={!active}>
      <header className="stats-header">
        <h1 className="stats-title">用量统计</h1>
        <p className="stats-sub">
          {range.from || "未选时间"}
          {range.to && range.to !== range.from ? ` → ${range.to}` : ""}
          {summary.length > 0 ? ` · ${summary.length} 个模型` : ""}
        </p>
        <div className="stats-header-actions">
          <button
            type="button"
            className="stats-btn"
            onClick={() => void load(true)}
            disabled={loading || detailsLoading}
          >
            刷新
          </button>
        </div>
      </header>

      <div className="stats-filters">
        <div className="stats-field stats-date-range-field">
          <span>时间</span>
          <DateRangePicker
            from={range.from}
            to={range.to}
            today={today}
            preset={rangePreset}
            open={dateRangeOpen}
            onOpenChange={onDateRangeOpenChange}
            onPresetChange={applyPreset}
            onChange={onCustomRange}
          />
        </div>
        <label className="stats-field">
          <span>功能</span>
          <select
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
          >
            {FEATURE_OPTIONS.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stats-field">
          <span>结果</span>
          <select
            value={okFilter}
            onChange={(e) => setOkFilter(e.target.value as OkFilter)}
          >
            <option value="">全部</option>
            <option value="ok">仅成功</option>
            <option value="fail">仅失败</option>
            <option value="supplement">仅补充</option>
          </select>
        </label>
        <label className="stats-field">
          <span>时段</span>
          <select
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value as BandFilter)}
          >
            <option value="">全部时段</option>
            <option value="idle">闲时</option>
            <option value="peak">高峰</option>
            <option value="flat">全时段统一</option>
          </select>
        </label>
        <div className="stats-seg" role="group" aria-label="分组">
          {(
            [
              ["feature", "按功能"],
              ["engine", "翻译引擎"],
              ["llm", "LLM"],
              ["day", "按日期"],
              ["band", "按时段"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={groupBy === k ? "is-active" : undefined}
              onClick={() => setGroupBy(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="stats-seg"
          role="group"
          aria-label="货币"
          data-tooltip="按厂商计费货币筛选，不做汇率换算"
        >
          <button
            type="button"
            className={currency === "CNY" ? "is-active" : undefined}
            onClick={() => setCurrency("CNY")}
          >
            CNY
          </button>
          <button
            type="button"
            className={currency === "USD" ? "is-active" : undefined}
            onClick={() => setCurrency("USD")}
          >
            USD
          </button>
        </div>
      </div>

      {error && <div className="stats-error">{error}</div>}

      <div className="stats-kpis">
        <div className="stats-kpi">
          <span className="stats-kpi-label">请求</span>
          <MetricValue value={totals.requests} suffix="次" />
          <div className="stats-kpi-parts">
            <MetricPart label="成功" value={totals.ok} tone="ok" />
            <MetricPart label="失败" value={totals.fail} tone="fail" />
            <MetricPart label="补充" value={totals.supplement} tone="supplement" />
          </div>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-label">Token 合计</span>
          <MetricValue value={totals.tokens} />
          <div className="stats-kpi-parts">
            <MetricPart label="输入" value={totals.input} />
            <MetricPart label="输出" value={totals.output} />
            <MetricPart label="缓存读" value={totals.cacheRead} />
            <MetricPart label="缓存写" value={totals.cacheWrite} />
          </div>
        </div>
        <div className="stats-kpi">
          <span className="stats-kpi-label">费用（{currency === "USD" ? "$" : "¥"}）</span>
          <span className="stats-kpi-value">{formatMoney(totals.cost, currency)}</span>
          <div className="stats-kpi-parts">
            <span className="stats-kpi-note">按 {currency} 计价，不做汇率换算</span>
          </div>
        </div>
      </div>

      <section className="stats-panel stats-panel-charts">
        <div className="stats-chart-toolbar">
          {!selectedActor && (
            <h2 className="stats-section-title stats-chart-title">用量趋势</h2>
          )}
          {selectedActor && (
            <div className="stats-chart-drill-head">
              <button
                type="button"
                className="stats-chart-back"
                onClick={() => setSelectedActor(null)}
              >
                <span aria-hidden="true">←</span>
                返回
              </button>
              <span className="stats-chart-drill-title">
                {selectedActor.label} 明细
              </span>
            </div>
          )}
          <div className="stats-seg" role="group" aria-label="主图指标">
            <button
              type="button"
              className={metric === "requests" ? "is-active" : undefined}
              onClick={() => setMetric("requests")}
            >
              请求次数
            </button>
            <button
              type="button"
              className={metric === "tokens" ? "is-active" : undefined}
              onClick={() => setMetric("tokens")}
            >
              Token
            </button>
            <button
              type="button"
              className={metric === "cost" ? "is-active" : undefined}
              onClick={() => setMetric("cost")}
            >
              费用
            </button>
          </div>
        </div>
        {loading && summary.length === 0 && events.length === 0 ? (
          <EmptyState className="stats-empty" size="sm" title="加载中…" role="status" />
        ) : (
          <>
            <UsageBarChart
              items={summary}
              events={events}
              groupBy={groupBy}
              metric={metric}
              currency={currency}
              rangeFrom={range.from}
              rangeTo={range.to}
              pricingRules={pricingRules}
              selectedActor={selectedActor}
              onSelectActor={setSelectedActor}
            />
          </>
        )}
      </section>

      <section className="stats-panel stats-table-wrap">
        <div className="stats-detail-header">
          <h2 className="stats-section-title">明细</h2>
          {detailView.collapsed.length > 0 && (
            <span className="stats-detail-hint">
              已收起全空列：{detailView.collapsed.join(" / ")}
            </span>
          )}
        </div>
        <div className="stats-table-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th className="stats-col-time">时间</th>
                <th className="stats-col-feature">功能</th>
                <th className="stats-col-channel">通道</th>
                <th className="stats-col-model">引擎 / 模型</th>
                <th className="stats-col-result">结果</th>
                <th className="stats-col-tokens">Tokens</th>
                <th className="stats-col-cost">费用</th>
                {detailView.hasChars && (
                  <th
                    className="stats-col-chars"
                    data-tooltip="请求原文的字符数（免费引擎可参考用量）"
                  >
                    原文长度
                  </th>
                )}
                {detailView.hasRemark && (
                  <th className="stats-col-remark">备注</th>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedEvents.length === 0 ? (
                <tr>
                  <td colSpan={detailView.columns} className="stats-td-empty">
                    <EmptyState size="sm" title="暂无明细" />
                  </td>
                </tr>
              ) : (
                sortedEvents.map((ev) => {
                  const target =
                    ev.channel === "llm"
                      ? shortUsageModelName(ev.model) || ev.vendor || "—"
                      : ev.engineId
                        ? `${ev.engineId}${
                            ev.engineKind === "keyed"
                              ? "（需 Key）"
                              : ev.engineKind === "free"
                                ? "（免费）"
                                : ""
                          }`
                        : "—";
                  const cacheR = ev.cacheReadTokens ?? 0;
                  const cacheW = ev.cacheWriteTokens ?? 0;
                  const prompt = ev.promptTokens ?? 0;
                  const input =
                    prompt < 0
                      ? -1
                      : cacheR > 0 || cacheW > 0
                        ? Math.max(0, prompt - Math.max(0, cacheR) - Math.max(0, cacheW))
                        : prompt;
                  const output = ev.completionTokens ?? 0;
                  const remark = eventRemark(ev);
                  const supplement = isSupplementEvent(ev);
                  return (
                    <tr key={ev.id}>
                      <td className="stats-col-time">
                        <span className="stats-mono">
                          {detailView.sameDay ? (
                            ev.time
                          ) : (
                            <>
                              <span className="stats-cell-date">{ev.date}</span>
                              {ev.time}
                            </>
                          )}
                        </span>
                        {detailView.hasBand && (
                          <span
                            className={
                              "stats-band-tag is-" + (ev.pricingBand || "none")
                            }
                          >
                            {bandLabel(ev.pricingBand)}
                          </span>
                        )}
                      </td>
                      <td className="stats-col-feature" data-tooltip={FEATURE_LABEL[ev.feature] ?? ev.feature}>
                        {FEATURE_LABEL[ev.feature] ?? ev.feature}
                      </td>
                      <td className="stats-col-channel" data-tooltip={ev.apiHost || undefined}>{eventChannelLabel(ev)}</td>
                      <td className="stats-col-model" data-tooltip={ev.channel === "llm" && ev.model !== target ? ev.model : undefined}>{target}</td>
                      <td className="stats-col-result">
                        <span
                          className={
                            supplement
                              ? "stats-badge is-supplement"
                              : ev.ok
                                ? "stats-badge is-ok"
                                : "stats-badge is-fail"
                          }
                        >
                          {supplement ? "补充" : ev.ok ? "成功" : "失败"}
                        </span>
                      </td>
                      <TokenTotalCell
                        cacheRead={cacheR}
                        cacheWrite={cacheW}
                        input={input}
                        output={output}
                        total={ev.totalTokens ?? 0}
                      />
                      <td className="stats-col-cost stats-mono">
                        {formatMoney(ev.cost ?? 0, currency)}
                      </td>
                      {detailView.hasChars && (
                        <td className="stats-col-chars stats-mono">
                          {ev.sourceChars ?? 0}
                        </td>
                      )}
                      {detailView.hasRemark && (
                        <td
                          className="stats-col-remark stats-reason"
                          data-tooltip={remark === "—" ? undefined : remark}
                        >
                          <span className="stats-reason-text">{remark}</span>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="stats-table-footer">
          <span className="stats-pagination">
            {detailsLoading ? "加载中… · " : ""}共{" "}
            {detailTotal.toLocaleString("zh-CN")} 条
            {detailPages > 0 ? ` · 第 ${detailPage} / ${detailPages} 页` : ""}
          </span>
          <div className="stats-pagination-actions">
            <button
              type="button"
              className="stats-btn"
              disabled={detailsLoading || detailPage <= 1}
              onClick={() => setDetailPage((page) => Math.max(1, page - 1))}
            >
              上一页
            </button>
            <button
              type="button"
              className="stats-btn"
              disabled={detailsLoading || detailPages <= 0 || detailPage >= detailPages}
              onClick={() =>
                setDetailPage((page) => Math.min(detailPages, page + 1))
              }
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
