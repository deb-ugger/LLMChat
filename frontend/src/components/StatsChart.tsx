import type { EChartsCoreOption,EChartsType } from "echarts/core";
import * as echarts from "echarts/core";
import { memo, useEffect, useMemo, useRef } from "react";
import { BarChart, CustomChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([BarChart, CustomChart, LineChart, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);
import {
type PricingCurrency,
type PricingRule,
type UsageEvent,
type UsageSummaryItem
} from "../api";
import {
formatMoney,
isPeakLocalTime,
parseTimeToMinutes,
} from "../pricingDefaults";
type GroupBy = "feature" | "engine" | "llm" | "day" | "band";

const FEATURE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部功能" },
  { value: "chat", label: "对话" },
  { value: "literature", label: "文献翻译" },
  { value: "ocr", label: "图片 OCR" },
  { value: "text", label: "文本翻译" },
  { value: "speech_recognition", label: "在线语音识别" },
  { value: "speech_proofread", label: "字幕校对" },
  { value: "unity", label: "在线翻译" },
  { value: "settings_test", label: "设置测试" },
  { value: "vendor_models", label: "刷新模型" },
];

const FEATURE_LABEL: Record<string, string> = Object.fromEntries(
  FEATURE_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]),
);

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function localDateString(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function inclusiveDayCount(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  if (!a || !b) return 0;
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86400000) + 1;
}

function enumerateDates(from: string, to: string): string[] {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  if (!a || !b || a > b) return [];
  const out: string[] = [];
  const cur = new Date(a);
  while (cur <= b) {
    out.push(localDateString(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function formatAxisDate(iso: string): string {
  const d = parseLocalDate(iso);
  if (!d) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTipDate(iso: string): string {
  const d = parseLocalDate(iso);
  if (!d) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function displayKey(groupBy: GroupBy, key: string): string {
  if (groupBy === "feature") return FEATURE_LABEL[key] ?? key;
  if (groupBy === "engine") {
    const [id, kind] = key.split("|");
    if (!kind) return id || key;
    return kind === "free" ? `${id}（免费）` : `${id}（需 Key）`;
  }
  if (groupBy === "llm") {
    const [vendor, model] = key.split("|");
    if (!model) return vendor || key;
    return vendor && vendor !== "unknown" ? `${vendor} / ${model}` : model;
  }
  if (groupBy === "band") return bandLabel(key);
  return key;
}

function bandLabel(band: string | undefined): string {
  if (band === "idle") return "闲时";
  if (band === "peak") return "高峰";
  if (band === "flat") return "全时段统一";
  if (!band) return "—";
  return band;
}

function formatTokenExact(n: number): string {
  if (n < 0) return "未知";
  return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

function tokenFieldForSum(n: number | undefined): number {
  if (n == null || n < 0) return 0;
  return n;
}

function isSupplementEvent(ev: UsageEvent): boolean {
  return ev.requestType === "supplement";
}

function isTokenUsageUnknown(item: {
  totalTokens?: number;
  promptTokens?: number;
}): boolean {
  return (item.totalTokens ?? 0) < 0 || (item.promptTokens ?? 0) < 0;
}

function hasConsumption(item: UsageSummaryItem): boolean {
  return (
    item.requests > 0 ||
    item.totalTokens > 0 ||
    (item.cacheReadTokens ?? 0) > 0 ||
    (item.cacheWriteTokens ?? 0) > 0
  );
}

function nonCachedInput(item: {
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const prompt = item.promptTokens ?? 0;
  if (prompt < 0) return 0;
  const read = item.cacheReadTokens ?? 0;
  const write = item.cacheWriteTokens ?? 0;
  if (read <= 0 && write <= 0) return prompt;
  return Math.max(0, prompt - Math.max(0, read) - Math.max(0, write));
}

function tokenTotalOf(item: {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}): number {
  if (isTokenUsageUnknown(item)) return 0;
  const cacheRead = tokenFieldForSum(item.cacheReadTokens);
  const cacheWrite = tokenFieldForSum(item.cacheWriteTokens);
  const input = nonCachedInput(item);
  const output = tokenFieldForSum(item.completionTokens);
  const parts = cacheRead + cacheWrite + input + output;
  if (parts > 0) return parts;
  return tokenFieldForSum(item.totalTokens);
}

function formatTokenCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 10_000) {
    const wan = n / 10_000;
    return `${wan >= 100 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return formatTokenExact(n);
}

function formatPct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const pct = (100 * part) / whole;
  if (pct >= 99.95) return "100%";
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

function eventMetricValue(
  ev: UsageEvent,
  metric: "requests" | "tokens" | "cost",
): number {
  if (metric === "requests") return Math.max(1, ev.requests ?? 1);
  if (metric === "cost") return ev.cost ?? 0;
  return tokenTotalOf({
    cacheReadTokens: ev.cacheReadTokens,
    cacheWriteTokens: ev.cacheWriteTokens,
    promptTokens: ev.promptTokens,
    completionTokens: ev.completionTokens,
    totalTokens: ev.totalTokens,
  });
}

function eventOkCount(ev: UsageEvent): number {
  if (ev.okCount != null) return ev.okCount;
  return !isSupplementEvent(ev) && ev.ok ? Math.max(1, ev.requests ?? 1) : 0;
}

function eventFailCount(ev: UsageEvent): number {
  if (ev.failCount != null) return ev.failCount;
  return !isSupplementEvent(ev) && !ev.ok ? Math.max(1, ev.requests ?? 1) : 0;
}

function eventSupplementCount(ev: UsageEvent): number {
  if (ev.supplementCount != null) return ev.supplementCount;
  return isSupplementEvent(ev) ? Math.max(1, ev.requests ?? 1) : 0;
}

function formatMetricValue(
  n: number,
  metric: "requests" | "tokens" | "cost",
  currency: PricingCurrency,
): string {
  if (metric === "cost") return formatMoney(n, currency);
  if (metric === "requests") return String(Math.round(n));
  return formatTokenExact(n);
}

function formatMetricCompact(
  n: number,
  metric: "requests" | "tokens" | "cost",
  currency: PricingCurrency,
): string {
  if (metric === "cost") return formatMoney(n, currency);
  if (metric === "requests") return String(Math.round(n));
  return formatTokenCompact(n);
}

function metricLabel(
  metric: "requests" | "tokens" | "cost",
  currency: PricingCurrency,
): string {
  if (metric === "cost") return currency === "USD" ? "费用 ($)" : "费用 (¥)";
  if (metric === "tokens") return "Tokens";
  return "请求";
}

function summaryMetricValue(
  r: UsageSummaryItem,
  metric: "requests" | "tokens" | "cost",
): number {
  if (metric === "requests") return r.requests;
  if (metric === "cost") return r.cost ?? 0;
  return tokenTotalOf(r);
}

const MODEL_LINE_COLORS = [
  "#2f6fed",
  "#0a7a32",
  "#7c6bc4",
  "#c45c26",
  "#5a8cb4",
  "#b07a3a",
  "#c62828",
  "#00897b",
  "#6d4c41",
  "#546e7a",
];

const PEAK_AREA = "rgba(251,191,36,0.20)";

const IDLE_AREA = "rgba(34,197,94,0.14)";

const PEAK_LABEL = "#9a5b00";

const IDLE_LABEL = "#166534";

function eventHourIndex(time: string): number {
  const mins = parseTimeToMinutes(time);
  if (mins < 0) return -1;
  return Math.min(23, Math.floor(mins / 60));
}

function minutesToHours(mins: number): number {
  return mins / 60;
}

function formatHourTick(hours: number): string {
  if (hours >= 24) return "24:00";
  const total = Math.max(0, Math.round(hours * 60));
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function hoursToClock(hours: number): string {
  if (hours >= 24) return "23:59";
  const total = Math.max(0, Math.round(hours * 60));
  const hh = Math.min(23, Math.floor(total / 60));
  const mm = total % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function peakHourRanges(windows: { from: string; to: string }[]) {
  const raw: { from: number; to: number }[] = [];
  for (const w of windows) {
    const a = parseTimeToMinutes(w.from);
    const b = parseTimeToMinutes(w.to);
    if (a < 0 || b < 0 || a === b) continue;
    if (a < b) raw.push({ from: minutesToHours(a), to: minutesToHours(b) });
    else {
      raw.push({ from: minutesToHours(a), to: 24 });
      if (b > 0) raw.push({ from: 0, to: minutesToHours(b) });
    }
  }
  raw.sort((x, y) => x.from - y.from || x.to - y.to);
  const merged: { from: number; to: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

function idleHourRanges(peaks: { from: number; to: number }[]) {
  const idle: { from: number; to: number }[] = [];
  let cur = 0;
  for (const p of peaks) {
    if (p.from > cur) idle.push({ from: cur, to: p.from });
    cur = Math.max(cur, p.to);
  }
  if (cur < 24) idle.push({ from: cur, to: 24 });
  return idle;
}

function valueBandArea(from: number, to: number, peak: boolean) {
  const wide = to - from >= 1.2;
  return [
    {
      name: peak ? "高峰" : "闲时",
      xAxis: from,
      itemStyle: { color: peak ? PEAK_AREA : IDLE_AREA },
      label: {
        show: wide,
        position: "insideTop" as const,
        color: peak ? PEAK_LABEL : IDLE_LABEL,
        fontSize: 10,
        fontWeight: 600,
      },
    },
    { xAxis: to },
  ];
}

function exactBandMarkAreas(rule: PricingRule | null) {
  if (!rule || !(rule.peakWindows || []).length) return [];
  const peaks = peakHourRanges(rule.peakWindows);
  const idles = idleHourRanges(peaks);
  return [
    ...idles.map((r) => valueBandArea(r.from, r.to, false)),
    ...peaks.map((r) => valueBandArea(r.from, r.to, true)),
  ];
}

function ruleCoversDate(rule: PricingRule, date: string): boolean {
  if (rule.from && date < rule.from) return false;
  if (rule.to && date > rule.to) return false;
  return true;
}

function pickRuleForDay(
  rules: PricingRule[],
  date: string,
  events: UsageEvent[],
): PricingRule | null {
  const weights = new Map<string, number>();
  for (const ev of events) {
    if (ev.date !== date) continue;
    const model = (ev.model || "").trim();
    if (!model) continue;
    weights.set(model, (weights.get(model) ?? 0) + eventMetricValue(ev, "tokens"));
  }
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  for (const [model] of ranked) {
    const hit = rules.find((r) => r.model === model && ruleCoversDate(r, date));
    if (hit) return hit;
  }
  return (
    rules.find(
      (r) => ruleCoversDate(r, date) && (r.peakWindows || []).length > 0,
    ) ?? null
  );
}

function tickIsPeak(rule: PricingRule | null, hours: number): boolean | null {
  if (!rule || !(rule.peakWindows || []).length) return null;
  return isPeakLocalTime(hoursToClock(hours), rule.peakWindows);
}

function dataIntervalTicks(occupiedHours: number[]): number[] {
  const hours = [...new Set(occupiedHours)]
    .filter((h) => h >= 0 && h < 24)
    .sort((a, b) => a - b);
  const ticks = new Set<number>();
  for (const h of hours) {
    // 每根小时柱都标出左右边界；相邻柱共享的边界只保留一个刻度。
    ticks.add(h);
    ticks.add(Math.min(24, h + 1));
  }
  return [...ticks].sort((a, b) => a - b);
}

function collectHourlyAxisTicks(
  rule: PricingRule | null,
  occupiedHours: number[],
): number[] {
  const ticks = new Set<number>([0, 24]);
  if (rule?.peakWindows?.length) {
    for (const w of rule.peakWindows) {
      const a = parseTimeToMinutes(w.from);
      const b = parseTimeToMinutes(w.to);
      if (a >= 0) ticks.add(minutesToHours(a));
      if (b >= 0) ticks.add(b === 0 ? 24 : minutesToHours(b));
    }
  }
  for (const t of dataIntervalTicks(occupiedHours)) ticks.add(t);
  return [...ticks]
    .filter((t) => t >= 0 && t <= 24)
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || Math.abs(t - arr[i - 1]) > 1e-6);
}

function hourRangeLabel(h: number): string {
  return `${pad2(h)}:00–${pad2(h + 1)}:00`;
}

function eventActorKey(ev: UsageEvent): string {
  if (ev.channel === "llm") {
    return `llm|${(ev.vendor || "").trim()}|${(ev.model || "").trim()}`;
  }
  return `eng|${(ev.engineId || "").trim()}|${(ev.engineKind || "").trim()}`;
}

function eventActorLabel(ev: UsageEvent): string {
  if (ev.channel === "llm") {
    return (ev.model || "").trim() || "未知模型";
  }
  const id = (ev.engineId || "").trim() || "未知引擎";
  if (ev.engineKind === "free") return `${id}（免费）`;
  if (ev.engineKind === "keyed") return `${id}（需 Key）`;
  return id;
}

type ActorOption = { key: string; label: string };

function collectActors(
  events: UsageEvent[],
  date: string,
  metric: "requests" | "tokens" | "cost" = "tokens",
): ActorOption[] {
  const map = new Map<string, { label: string; weight: number }>();
  for (const ev of events) {
    if (ev.date !== date) continue;
    const key = eventActorKey(ev);
    const add = eventMetricValue(ev, metric);
    const cur = map.get(key);
    if (!cur) map.set(key, { label: eventActorLabel(ev), weight: add });
    else cur.weight += add;
  }
  return [...map.entries()]
    .sort(
      (a, b) =>
        b[1].weight - a[1].weight ||
        a[1].label.localeCompare(b[1].label, "zh-CN"),
    )
    .map(([key, v]) => ({ key, label: v.label }));
}

function hourlyXAxis(rule: PricingRule | null, ticks: number[]) {
  return {
    type: "value" as const,
    min: 0,
    max: 24,
    scale: false,
    boundaryGap: [0, 0] as [number, number],
    minInterval: 0.25,
    axisTick: {
      show: true,
      alignWithLabel: true,
      customValues: ticks,
    },
    axisLabel: {
      fontSize: 11,
      fontWeight: 600,
      hideOverlap: false,
      showMinLabel: true,
      showMaxLabel: true,
      customValues: ticks,
      formatter: (v: number) => formatHourTick(v),
      color: (value: string) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return "#6b778a";
        const peak = tickIsPeak(rule, n >= 24 ? 23.999 : n);
        if (peak == null) return "#6b778a";
        return peak ? PEAK_LABEL : IDLE_LABEL;
      },
    },
    splitLine: { show: false },
  };
}

function markAreaHost(markAreas: ReturnType<typeof exactBandMarkAreas>) {
  if (!markAreas.length) return [];
  return [
    {
      name: "",
      type: "bar" as const,
      data: [] as number[],
      silent: true,
      tooltip: { show: false },
      itemStyle: { opacity: 0 },
      markArea: { silent: true, z: 0, data: markAreas },
    },
  ];
}

const hourlyBarRender = (
  _params: unknown,
  api: {
    value: (dim: number) => number;
    coord: (data: number[]) => number[];
    style: () => Record<string, unknown>;
  },
) => {
  const x0 = Number(api.value(0));
  const yVal = Number(api.value(1));
  const yBase = Number(api.value(2) ?? 0);
  const yTop = Number(api.value(3) ?? yBase + yVal);
  if (!Number.isFinite(x0) || !Number.isFinite(yVal) || yVal === 0) {
    return undefined;
  }
  const start = api.coord([x0, yBase]);
  const end = api.coord([x0 + 1, yTop]);
  const x = start[0];
  const y = end[1];
  const width = Math.max(0, end[0] - start[0] - 1);
  const height = Math.max(0, start[1] - end[1]);
  return {
    type: "rect",
    shape: { x: x + 0.5, y, width, height },
    style: api.style(),
  };
};

function hourlyBarPoint(hour: number, value: number, base: number) {
  return [hour, value, base, base + value];
}

function buildActorDetailOption({
  actor,
  day,
  events,
  currency,
  metric,
  pricingRules,
}: {
  actor: ActorOption;
  day: string;
  events: UsageEvent[];
  currency: PricingCurrency;
  metric: "requests" | "tokens" | "cost";
  pricingRules: PricingRule[];
}): EChartsCoreOption {
  const rule = pickRuleForDay(pricingRules, day, events);
  const markAreas = exactBandMarkAreas(rule);
  const hourEvents: UsageEvent[][] = Array.from({ length: 24 }, () => []);
  for (const ev of events) {
    if (ev.date !== day || eventActorKey(ev) !== actor.key) continue;
    const h = eventHourIndex(ev.time);
    if (h >= 0) hourEvents[h].push(ev);
  }

  const occupiedHours = Array.from({ length: 24 }, (_, h) => h).filter(
    (h) => hourEvents[h].length > 0,
  );
  const ticks = collectHourlyAxisTicks(rule, occupiedHours);
  const hourOk = (h: number) =>
    hourEvents[h].reduce((sum, ev) => sum + eventOkCount(ev), 0);
  const hourFail = (h: number) =>
    hourEvents[h].reduce((sum, ev) => sum + eventFailCount(ev), 0);
  const hourSupplement = (h: number) =>
    hourEvents[h].reduce((sum, ev) => sum + eventSupplementCount(ev), 0);
  const hourCost = (h: number) =>
    hourEvents[h].reduce((sum, ev) => sum + (ev.cost ?? 0), 0);
  const hourField = (h: number, pick: (ev: UsageEvent) => number) =>
    hourEvents[h].reduce((sum, ev) => sum + pick(ev), 0);

  const tooltipHtml = (h: number) => {
    const peak = tickIsPeak(rule, h);
    const band = peak == null ? "" : peak ? "高峰" : "闲时";
    const bandColor =
      peak == null ? "#6b778a" : peak ? PEAK_LABEL : IDLE_LABEL;
    const head = [
      `<div style="font-weight:700;margin-bottom:4px">${actor.label}</div>`,
      `<div style="font-weight:700;margin-bottom:4px">${hourRangeLabel(h)}</div>`,
      band
        ? `<div style="margin-bottom:6px;color:${bandColor};font-weight:700">${band}</div>`
        : "",
    ];
    if (metric === "requests") {
      return [
        ...head,
        `<div>成功：${hourOk(h)}</div>`,
        `<div>失败：${hourFail(h)}</div>`,
        `<div>补充：${hourSupplement(h)}</div>`,
        `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb">合计：${hourOk(h) + hourFail(h) + hourSupplement(h)}</div>`,
      ].join("");
    }
    if (metric === "cost") {
      return [
        ...head,
        `<div>费用：${formatMoney(hourCost(h), currency)}</div>`,
      ].join("");
    }
    const cacheRead = hourField(h, (ev) =>
      tokenFieldForSum(ev.cacheReadTokens),
    );
    const cacheWrite = hourField(h, (ev) =>
      tokenFieldForSum(ev.cacheWriteTokens),
    );
    const input = hourField(h, (ev) => nonCachedInput(ev));
    const output = hourField(h, (ev) =>
      tokenFieldForSum(ev.completionTokens),
    );
    return [
      ...head,
      `<div>Cache Read：${formatTokenExact(cacheRead)}</div>`,
      `<div>Cache Write：${formatTokenExact(cacheWrite)}</div>`,
      `<div>Input：${formatTokenExact(input)}</div>`,
      `<div>Output：${formatTokenExact(output)}</div>`,
      `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb">Total：${formatTokenExact(cacheRead + cacheWrite + input + output)}</div>`,
    ].join("");
  };

  const series: Record<string, unknown>[] = [
    ...markAreaHost(markAreas),
  ];
  if (metric === "requests") {
    const ok = Array.from({ length: 24 }, (_, h) => hourOk(h));
    const fail = Array.from({ length: 24 }, (_, h) => hourFail(h));
    const supplement = Array.from({ length: 24 }, (_, h) => hourSupplement(h));
    series.push(
      {
        name: "成功",
        type: "custom",
        renderItem: hourlyBarRender,
        encode: { x: 0, y: [2, 3] },
        itemStyle: { color: "#0a7a32" },
        data: ok.map((v, h) => hourlyBarPoint(h, v, 0)),
      },
      {
        name: "失败",
        type: "custom",
        renderItem: hourlyBarRender,
        encode: { x: 0, y: [2, 3] },
        itemStyle: { color: "#c62828" },
        data: fail.map((v, h) => hourlyBarPoint(h, v, ok[h])),
      },
      {
        name: "补充",
        type: "custom",
        renderItem: hourlyBarRender,
        encode: { x: 0, y: [2, 3] },
        itemStyle: { color: "#b7791f" },
        data: supplement.map((v, h) =>
          hourlyBarPoint(h, v, ok[h] + fail[h]),
        ),
      },
    );
  } else if (metric === "cost") {
    series.push({
      name: metricLabel("cost", currency),
      type: "custom",
      renderItem: hourlyBarRender,
      encode: { x: 0, y: [2, 3] },
      itemStyle: { color: "#2f6fed" },
      data: Array.from({ length: 24 }, (_, h) =>
        hourlyBarPoint(h, hourCost(h), 0),
      ),
    });
  } else {
    const stacks = [
      {
        name: "Cache Read",
        color: "#7c6bc4",
        values: Array.from({ length: 24 }, (_, h) =>
          hourField(h, (ev) => tokenFieldForSum(ev.cacheReadTokens)),
        ),
      },
      {
        name: "Cache Write",
        color: "#b07a3a",
        values: Array.from({ length: 24 }, (_, h) =>
          hourField(h, (ev) => tokenFieldForSum(ev.cacheWriteTokens)),
        ),
      },
      {
        name: "Input",
        color: "#2f6fed",
        values: Array.from({ length: 24 }, (_, h) =>
          hourField(h, (ev) => nonCachedInput(ev)),
        ),
      },
      {
        name: "Output",
        color: "#5a8cb4",
        values: Array.from({ length: 24 }, (_, h) =>
          hourField(h, (ev) => tokenFieldForSum(ev.completionTokens)),
        ),
      },
    ];
    stacks.forEach((stack, i) => {
      const bases = new Array(24).fill(0);
      for (let j = 0; j < i; j++) {
        for (let h = 0; h < 24; h++) bases[h] += stacks[j].values[h];
      }
      series.push({
        name: stack.name,
        type: "custom",
        renderItem: hourlyBarRender,
        encode: { x: 0, y: [2, 3] },
        itemStyle: { color: stack.color },
        data: stack.values.map((v, h) => hourlyBarPoint(h, v, bases[h])),
      });
    });
  }

  return {
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const first = (Array.isArray(params) ? params[0] : params) as {
          value?: number[] | number;
        };
        const raw = first?.value;
        const x = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
        const h = Number.isFinite(x)
          ? Math.max(0, Math.min(23, Math.floor(x)))
          : 0;
        return tooltipHtml(h);
      },
    },
    legend:
      metric === "cost"
        ? { show: false }
        : {
            data:
              metric === "requests"
                ? ["成功", "失败", "补充"]
                : ["Cache Read", "Cache Write", "Input", "Output"],
            top: 0,
          },
    grid: {
      left: 56,
      right: 24,
      top: metric === "cost" ? 28 : 40,
      bottom: 44,
      containLabel: false,
    },
    xAxis: hourlyXAxis(rule, ticks),
    yAxis: {
      type: "value",
      name:
        metric === "requests"
          ? "次数"
          : metric === "cost"
            ? currency === "USD"
              ? "费用 ($)"
              : "费用 (¥)"
            : "Tokens",
      minInterval: metric === "requests" ? 1 : undefined,
    },
    series: series as EChartsCoreOption["series"],
  };
}

type BarChartProps = {
  items: UsageSummaryItem[];
  events: UsageEvent[];
  groupBy: GroupBy;
  metric: "requests" | "tokens" | "cost";
  currency: PricingCurrency;
  rangeFrom: string;
  rangeTo: string;
  pricingRules: PricingRule[];
  selectedActor: ActorOption | null;
  onSelectActor: (actor: ActorOption) => void;
};

function UsageBarChartContent({
  items,
  events,
  groupBy,
  metric,
  currency,
  rangeFrom,
  rangeTo,
  pricingRules,
  selectedActor,
  onSelectActor,
}: BarChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  const singleDay =
    groupBy === "day" &&
    rangeFrom &&
    rangeTo &&
    inclusiveDayCount(rangeFrom, rangeTo) === 1
      ? rangeFrom
      : "";
  const drillableActors = useMemo(
    () => (singleDay ? collectActors(events, singleDay, metric) : []),
    [events, metric, singleDay],
  );

  const option = useMemo((): EChartsCoreOption => {
    const rows = items.filter(hasConsumption);

    if (singleDay && selectedActor) {
      return buildActorDetailOption({
        actor: selectedActor,
        day: singleDay,
        events,
        currency,
        metric,
        pricingRules,
      });
    }

    // 按日期 + 时间跨度 > 1 天 → 按模型累计折线/面积图
    if (groupBy === "day") {
      let from = rangeFrom;
      let to = rangeTo;
      if (!from || !to) {
        const keys = rows.map((r) => r.key).filter(Boolean).sort();
        if (keys.length > 0) {
          from = from || keys[0];
          to = to || keys[keys.length - 1];
        }
      }
      const span = from && to ? inclusiveDayCount(from, to) : 0;
      if (span > 1 && from && to) {
        const dates = enumerateDates(from, to);
        const dateSet = new Set(dates);
        const valueLabel = metricLabel(metric, currency);

        // day -> model -> value ; day -> total
        const dayModel = new Map<string, Map<string, number>>();
        const dayTotal = new Map<string, number>();
        const modelTotals = new Map<string, number>();

        for (const ev of events) {
          if (!ev.date || !dateSet.has(ev.date)) continue;
          const add = eventMetricValue(ev, metric);
          if (add <= 0) continue;

          dayTotal.set(ev.date, (dayTotal.get(ev.date) ?? 0) + add);

          const model = (ev.model || "").trim();
          if (model) {
            if (!dayModel.has(ev.date)) dayModel.set(ev.date, new Map());
            const mm = dayModel.get(ev.date)!;
            mm.set(model, (mm.get(model) ?? 0) + add);
            modelTotals.set(model, (modelTotals.get(model) ?? 0) + add);
          }
        }

        // Also include summary day totals for days with only engine (no model) traffic
        for (const r of rows) {
          if (!dateSet.has(r.key)) continue;
          const fromSummary = summaryMetricValue(r, metric);
          const cur = dayTotal.get(r.key) ?? 0;
          if (fromSummary > cur) {
            dayTotal.set(r.key, fromSummary);
          }
        }

        const models = [...modelTotals.entries()]
          .filter(([, t]) => t > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([m]) => m);

        const daily = dates.map((d) => dayTotal.get(d) ?? 0);
        const cumulative: number[] = [];
        let run = 0;
        for (const v of daily) {
          run += v;
          cumulative.push(run);
        }

        const today = localDateString(new Date());

        type SeriesDef = {
          name: string;
          daily: number[];
          cumulative: number[];
          color: string;
        };

        const seriesDefs: SeriesDef[] = [];
        if (models.length > 0) {
          for (let i = 0; i < models.length; i++) {
            const model = models[i];
            const dailies = dates.map(
              (d) => dayModel.get(d)?.get(model) ?? 0,
            );
            const cum: number[] = [];
            let c = 0;
            for (const v of dailies) {
              c += v;
              cum.push(c);
            }
            seriesDefs.push({
              name: model,
              daily: dailies,
              cumulative: cum,
              color: MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length],
            });
          }
        } else {
          seriesDefs.push({
            name: "累计消耗",
            daily,
            cumulative,
            color: "#2f6fed",
          });
        }

        return {
          tooltip: {
            trigger: "axis",
            axisPointer: {
              type: "line",
              snap: true,
              lineStyle: { type: "dashed", color: "#9aa7b8", width: 1 },
            },
            formatter: (params: unknown) => {
              const list = Array.isArray(params) ? params : [params];
              const first = list[0] as { dataIndex?: number };
              const idx = first?.dataIndex ?? 0;
              const iso = dates[idx] ?? "";
              const dayVal = daily[idx] ?? 0;
              const cumVal = cumulative[idx] ?? 0;
              const isToday = iso === today;

              const modelMap = dayModel.get(iso);
              const detailRows: string[] = [];

              if (modelMap) {
                const mods = [...modelMap.entries()]
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1]);
                for (const [model, v] of mods) {
                  detailRows.push(
                    `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.55"><span>${model}</span><span style="font-variant-numeric:tabular-nums">${formatMetricCompact(v, metric, currency)}&nbsp;&nbsp;${formatPct(v, dayVal)}</span></div>`,
                  );
                }
              }

              const parts = [
                `<div style="font-weight:700;margin-bottom:6px">${formatTipDate(iso)}${isToday ? " · Today" : ""}</div>`,
                `<div style="color:#6b778a;margin-bottom:4px">当日明细</div>`,
              ];
              if (detailRows.length > 0) {
                parts.push(...detailRows);
              } else {
                parts.push(
                  `<div style="color:#6b778a">${metric === "cost" ? "无费用" : "无 Token 消耗"}</div>`,
                );
              }
              parts.push(
                `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb">当天消耗: <b>${formatMetricValue(dayVal, metric, currency)}</b> ${valueLabel}</div>`,
                `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb">累计消耗: <b>${formatMetricValue(cumVal, metric, currency)}</b> ${valueLabel}</div>`,
              );
              return parts.join("");
            },
          },
          legend: {
            data: seriesDefs.map((s) => s.name),
            top: 0,
            type: seriesDefs.length > 4 ? "scroll" : "plain",
          },
          grid: { left: 56, right: 24, top: 44, bottom: 48 },
          xAxis: {
            type: "category",
            boundaryGap: false,
            data: dates.map(formatAxisDate),
            axisLabel: { fontSize: 11 },
          },
          yAxis: {
            type: "value",
            name:
              metric === "requests"
                ? "累计请求"
                : metric === "cost"
                  ? currency === "USD"
                    ? "累计费用 ($)"
                    : "累计费用 (¥)"
                  : "累计 Tokens",
            minInterval: metric === "requests" ? 1 : undefined,
          },
          series: seriesDefs.map((s, i) => {
            const todayIdx = dates.indexOf(today);
            const todayStackY =
              todayIdx >= 0
                ? seriesDefs
                    .slice(0, i + 1)
                    .reduce((sum, sd) => sum + (sd.cumulative[todayIdx] ?? 0), 0)
                : null;
            return {
              name: s.name,
              type: "line" as const,
              stack: models.length > 0 ? "cum" : undefined,
              smooth: true,
              // Default hidden; axis hover shows hollow dots on each series.
              showSymbol: false,
              symbol: "circle",
              symbolSize: 8,
              data: s.cumulative,
              lineStyle: { width: 2, color: s.color },
              itemStyle: {
                color: "#fff",
                borderColor: s.color,
                borderWidth: 2,
              },
              emphasis: {
                disabled: false,
                scale: false,
                itemStyle: {
                  color: "#fff",
                  borderColor: s.color,
                  borderWidth: 2,
                },
              },
              areaStyle:
                models.length > 0
                  ? {
                      opacity: 0.55,
                      color: s.color,
                    }
                  : {
                      color: {
                        type: "linear" as const,
                        x: 0,
                        y: 0,
                        x2: 0,
                        y2: 1,
                        colorStops: [
                          { offset: 0, color: "rgba(47,111,237,0.28)" },
                          { offset: 1, color: "rgba(47,111,237,0.02)" },
                        ],
                      },
                    },
              markPoint:
                todayStackY != null
                  ? {
                      symbol: "circle",
                      symbolSize: 8,
                      itemStyle: {
                        color: "#fff",
                        borderColor: s.color,
                        borderWidth: 2,
                      },
                      label: { show: false },
                      data: [
                        {
                          xAxis: formatAxisDate(today),
                          yAxis: todayStackY,
                        },
                      ],
                    }
                  : undefined,
              markLine:
                i === 0 && dates.includes(today)
                  ? {
                      symbol: "none" as const,
                      label: {
                        formatter: "Today",
                        position: "end" as const,
                        color: "#6b778a",
                        fontSize: 11,
                      },
                      lineStyle: { type: "dashed" as const, color: "#c5d0de" },
                      data: [{ xAxis: formatAxisDate(today) }],
                    }
                  : undefined,
            };
          }),
        };
      }

      if (span === 1 && from) {
        const day = from;
        const rule = pickRuleForDay(pricingRules, day, events);
        const markAreas = exactBandMarkAreas(rule);

        const hourEvents: UsageEvent[][] = Array.from({ length: 24 }, () => []);
        for (const ev of events) {
          if (ev.date !== day) continue;
          const h = eventHourIndex(ev.time);
          if (h < 0) continue;
          hourEvents[h].push(ev);
        }

        const hourValue = (h: number) =>
          hourEvents[h].reduce((s, ev) => s + eventMetricValue(ev, metric), 0);
        const occupiedHours = Array.from({ length: 24 }, (_, h) => h).filter(
          (h) => hourValue(h) > 0,
        );
        const ticks = collectHourlyAxisTicks(rule, occupiedHours);

        const tooltipHtml = (h: number) => {
          const peak = tickIsPeak(rule, h);
          const band = peak == null ? "" : peak ? "高峰" : "闲时";
          const bandColor =
            peak == null ? "#6b778a" : peak ? PEAK_LABEL : IDLE_LABEL;
          const byActor = new Map<string, number>();
          for (const ev of hourEvents[h]) {
            const label = eventActorLabel(ev);
            byActor.set(
              label,
              (byActor.get(label) ?? 0) + eventMetricValue(ev, metric),
            );
          }
          const actorRows = [...byActor.entries()].sort((a, b) => b[1] - a[1]);
          const total = hourValue(h);
          const lines = actorRows.map(
            ([name, v]) =>
              `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.55"><span>${name}</span><span style="font-variant-numeric:tabular-nums">${formatMetricValue(v, metric, currency)}</span></div>`,
          );
          return [
            `<div style="font-weight:700;margin-bottom:4px">${hourRangeLabel(h)}</div>`,
            band
              ? `<div style="margin-bottom:6px;color:${bandColor};font-weight:700">${band}</div>`
              : "",
            lines.length
              ? lines.join("")
              : `<div style="color:#6b778a">无消耗</div>`,
            `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb;font-weight:700;display:flex;justify-content:space-between;gap:16px"><span>合计</span><span>${formatMetricValue(total, metric, currency)}</span></div>`,
          ].join("");
        };

        const yName =
          metric === "requests"
            ? "次数"
            : metric === "cost"
              ? currency === "USD"
                ? "费用 ($)"
                : "费用 (¥)"
              : "Tokens";
        const actors = collectActors(events, day, metric);
        const hoursByActor = new Map<string, number[]>();
        hourEvents.forEach((rows, hour) => {
          for (const event of rows) {
            const key = eventActorKey(event);
            let values = hoursByActor.get(key);
            if (!values) { values = Array(24).fill(0); hoursByActor.set(key, values); }
            values[hour] += eventMetricValue(event, metric);
          }
        });
        const actorHourValues = actors.map(actor => hoursByActor.get(actor.key) || Array(24).fill(0));

        const series = [
          ...markAreaHost(markAreas),
          ...(actors.length === 0
            ? [
                {
                  name: metricLabel(metric, currency),
                  type: "custom" as const,
                  renderItem: hourlyBarRender,
                  data: [] as number[][],
                },
              ]
            : actors.map((a, i) => {
                const bases = new Array(24).fill(0);
                for (let j = 0; j < i; j++) {
                  for (let h = 0; h < 24; h++) {
                    bases[h] += actorHourValues[j][h];
                  }
                }
                return {
                  id: a.key,
                  name: a.label,
                  type: "custom" as const,
                  renderItem: hourlyBarRender,
                  encode: { x: 0, y: [2, 3] },
                  cursor: "pointer",
                  itemStyle: {
                    color: MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length],
                  },
                  data: actorHourValues[i].map((v, h) =>
                    hourlyBarPoint(h, v, bases[h]),
                  ),
                };
              })),
        ];

        return {
          tooltip: {
            trigger: "item",
            formatter: (params: unknown) => {
              const first = (Array.isArray(params) ? params[0] : params) as {
                value?: number[] | number;
              };
              const raw = first?.value;
              const x = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
              const h = Number.isFinite(x)
                ? Math.max(0, Math.min(23, Math.floor(x)))
                : 0;
              return tooltipHtml(h);
            },
          },
          legend: {
            data: actors.map((a) => a.label),
            top: 0,
            type: actors.length > 3 ? "scroll" : "plain",
          },
          grid: {
            left: 56,
            right: 24,
            top: actors.length ? 40 : 28,
            bottom: 44,
            containLabel: false,
          },
          xAxis: hourlyXAxis(rule, ticks),
          yAxis: {
            type: "value",
            name: yName,
            minInterval: metric === "requests" ? 1 : undefined,
          },
          series,
        };
      }
    }

    const labels = rows.map((r) => displayKey(groupBy, r.key));
    if (metric === "requests") {
      return {
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        legend: { data: ["成功", "失败", "补充"], top: 0 },
        grid: { left: 48, right: 16, top: 36, bottom: 48 },
        xAxis: {
          type: "category",
          data: labels,
          axisLabel: { rotate: labels.length > 6 ? 28 : 0, fontSize: 11 },
        },
        yAxis: { type: "value", minInterval: 1, name: "次数" },
        series: [
          {
            name: "成功",
            type: "bar",
            stack: "req",
            data: rows.map((r) => r.ok),
            itemStyle: { color: "#0a7a32" },
            barMaxWidth: 36,
          },
          {
            name: "失败",
            type: "bar",
            stack: "req",
            data: rows.map((r) => r.fail),
            itemStyle: { color: "#c62828" },
            barMaxWidth: 36,
          },
          {
            name: "补充",
            type: "bar",
            stack: "req",
            data: rows.map((r) => r.supplement ?? 0),
            itemStyle: { color: "#b7791f" },
            barMaxWidth: 36,
          },
        ],
      };
    }
    if (metric === "cost") {
      return {
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          formatter: (params: unknown) => {
            const list = Array.isArray(params) ? params : [params];
            if (!list.length) return "";
            const axis =
              (list[0] as { axisValueLabel?: string; name?: string })
                .axisValueLabel ||
              (list[0] as { name?: string }).name ||
              "";
            const item = list[0] as {
              marker?: string;
              seriesName?: string;
              value?: number | string;
            };
            const v = Number(item.value ?? 0);
            return `<div style="font-weight:600;margin-bottom:4px">${axis}</div>${item.marker ?? ""}${item.seriesName ?? ""}: ${formatMoney(v, currency)}`;
          },
        },
        grid: { left: 64, right: 16, top: 28, bottom: 48 },
        xAxis: {
          type: "category",
          data: labels,
          axisLabel: { rotate: labels.length > 6 ? 28 : 0, fontSize: 11 },
        },
        yAxis: {
          type: "value",
          name: currency === "USD" ? "费用 ($)" : "费用 (¥)",
        },
        series: [
          {
            name: metricLabel("cost", currency),
            type: "bar",
            data: rows.map((r) => r.cost ?? 0),
            itemStyle: { color: "#0a7a32" },
            barMaxWidth: 36,
          },
        ],
      };
    }

    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params];
          if (!list.length) return "";
          const axis =
            (list[0] as { axisValueLabel?: string; name?: string })
              .axisValueLabel ||
            (list[0] as { name?: string }).name ||
            "";
          let total = 0;
          const lines = list.map((p) => {
            const item = p as {
              marker?: string;
              seriesName?: string;
              value?: number | string;
            };
            const v = Number(item.value ?? 0);
            total += Number.isFinite(v) ? v : 0;
            return `${item.marker ?? ""}${item.seriesName ?? ""}: ${formatTokenExact(v)}`;
          });
          lines.push(
            `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;font-weight:700">Total: ${formatTokenExact(total)}</div>`,
          );
          return `<div style="font-weight:600;margin-bottom:4px">${axis}</div>${lines.join("<br/>")}`;
        },
      },
      legend: {
        data: ["Cache Read", "Cache Write", "Input", "Output"],
        top: 0,
      },
      grid: { left: 56, right: 16, top: 40, bottom: 48 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { rotate: labels.length > 6 ? 28 : 0, fontSize: 11 },
      },
      yAxis: { type: "value", name: "Tokens" },
      series: [
        {
          name: "Cache Read",
          type: "bar",
          stack: "tok",
          data: rows.map((r) => tokenFieldForSum(r.cacheReadTokens)),
          itemStyle: { color: "#7c6bc4" },
          barMaxWidth: 36,
        },
        {
          name: "Cache Write",
          type: "bar",
          stack: "tok",
          data: rows.map((r) => tokenFieldForSum(r.cacheWriteTokens)),
          itemStyle: { color: "#b07a3a" },
          barMaxWidth: 36,
        },
        {
          name: "Input",
          type: "bar",
          stack: "tok",
          data: rows.map((r) => nonCachedInput(r)),
          itemStyle: { color: "#2f6fed" },
          barMaxWidth: 36,
        },
        {
          name: "Output",
          type: "bar",
          stack: "tok",
          data: rows.map((r) => tokenFieldForSum(r.completionTokens)),
          itemStyle: { color: "#5a8cb4" },
          barMaxWidth: 36,
        },
      ],
    };
  }, [
    events,
    groupBy,
    items,
    metric,
    currency,
    pricingRules,
    rangeFrom,
    rangeTo,
    selectedActor,
    singleDay,
  ]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let chart = chartRef.current;
    if (!chart) {
      chart = echarts.init(el, undefined, { renderer: "canvas" });
      chartRef.current = chart;
    }
    chart.setOption(option, true);
    const onChartClick = (params: unknown) => {
      if (!singleDay || selectedActor) return;
      const hit = params as { seriesId?: string };
      const actor = drillableActors.find((item) => item.key === hit.seriesId);
      if (actor) onSelectActor(actor);
    };
    chart.on("click", onChartClick);
    const onResize = () => chart?.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      chart?.off("click", onChartClick);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [drillableActors, onSelectActor, option, selectedActor, singleDay]);

  useEffect(
    () => () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    },
    [],
  );

  const isDayLine =
    groupBy === "day" &&
    (() => {
      let from = rangeFrom;
      let to = rangeTo;
      if (!from || !to) {
        const keys = items
          .filter(hasConsumption)
          .map((r) => r.key)
          .filter(Boolean)
          .sort();
        if (keys.length > 0) {
          from = from || keys[0];
          to = to || keys[keys.length - 1];
        }
      }
      return from && to ? inclusiveDayCount(from, to) > 1 : false;
    })();
  const isSingleDayHourly =
    groupBy === "day" &&
    !!rangeFrom &&
    !!rangeTo &&
    inclusiveDayCount(rangeFrom, rangeTo) === 1;

  if (
    !isDayLine &&
    !isSingleDayHourly &&
    items.filter(hasConsumption).length === 0
  ) {
    return <div className="stats-empty">所选范围内暂无用量数据</div>;
  }

  return <div className="stats-chart" ref={hostRef} />;
}
const UsageBarChart = memo(UsageBarChartContent);
export { bandLabel, FEATURE_LABEL, FEATURE_OPTIONS, formatTokenExact, hasConsumption, isSupplementEvent, localDateString, nonCachedInput, parseLocalDate, tokenFieldForSum, tokenTotalOf, UsageBarChart };
export type { ActorOption, GroupBy };
