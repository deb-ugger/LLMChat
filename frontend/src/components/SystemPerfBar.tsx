import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SystemPerformancePoint } from "../benchmark/systemPerformanceTypes";
import { fetchSystemPerformanceHistory, fetchSystemPerformanceNow } from "../systemPerformance";

/**
 * 底部系统性能条。
 *
 * 收起态（38px）：性能⌄ │ CPU 56°C 12% ▁▂▃ │ 内存 72% ▁▂▃ │ 磁盘 9.4MB/s 62% ▁▂▃ │
 *               网络 477KB/s ▁▂▃ │ GPU 84°C 88% ▁▂▃ │ 模型服务 2模型 53.0tok/s ▁▂▃
 * 展开态：向上抬起 340px 面板，8 张卡片（含 CPU / GPU 温度、模型服务）。
 *
 * 取不到的字段（温度、磁盘占用率、tok/s、模型数量）显示「—」，不参与取档，
 * 避免把「没采到」误画成绿色正常。
 */

type Level = "lo" | "mid" | "hi";

const PERCENT_MID = 50;
const PERCENT_HIGH = 80;
const TEMP_MID = 65;
const TEMP_HIGH = 80;

const TIMELINE_MS = 30 * 60 * 1000;
const HISTORY_POINTS = 150;
const POLL_MS = 3000;
const STORAGE_KEY = "llmchat-sysbar-expanded";

function levelOfPercent(value: number | null): Level | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value >= PERCENT_HIGH) return "hi";
  if (value >= PERCENT_MID) return "mid";
  return "lo";
}

function levelOfTemp(value: number | null): Level | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value >= TEMP_HIGH) return "hi";
  if (value >= TEMP_MID) return "mid";
  return "lo";
}

function formatPercent(value: number | null): string {
  return value == null || Number.isNaN(value) ? "—" : `${value.toFixed(0)}%`;
}

function formatTemp(value: number | null): string {
  return value == null || Number.isNaN(value) ? "—" : `${value.toFixed(0)}°C`;
}

function formatRate(value: number | null): { value: string; unit: string } {
  if (value == null || Number.isNaN(value)) return { value: "—", unit: "" };
  if (value >= 1024 * 1024) return { value: (value / 1024 / 1024).toFixed(1), unit: "MB/s" };
  if (value >= 1024) return { value: (value / 1024).toFixed(0), unit: "KB/s" };
  return { value: value.toFixed(0), unit: "B/s" };
}

function formatTokPerSecond(value: number | null): { value: string; unit: string } {
  if (value == null || Number.isNaN(value)) return { value: "—", unit: "tok/s" };
  if (value >= 1000) return { value: (value / 1000).toFixed(1), unit: "k tok/s" };
  return { value: value.toFixed(1), unit: "tok/s" };
}

/** 折线用固定 viewBox，靠 preserveAspectRatio 拉伸，宽度由 CSS 决定。 */
function sparkPath(series: readonly (number | null)[], max: number | null): string {
  const values = series.filter((value): value is number => value != null && !Number.isNaN(value));
  if (values.length < 2) return "";
  const top = max && max > 0 ? max : Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  return values
    .map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)} ${(20 - Math.min(value / top, 1) * 18).toFixed(1)}`)
    .join(" ");
}

type MetricSpec = {
  key: string;
  label: string;
  secondary?: string;
  value: string;
  unit?: string;
  level: Level | null;
  secondaryLevel?: Level | null;
  series: (number | null)[];
  max: number | null;
};

export function SystemPerfBar() {
  const [latest, setLatest] = useState<SystemPerformancePoint | null>(null);
  const [points, setPoints] = useState<SystemPerformancePoint[]>([]);
  const [expanded, setExpanded] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [range, setRange] = useState<"3m" | "30m" | "run">("3m");
  const barRef = useRef<HTMLDivElement | null>(null);

  const toggle = useCallback(() => {
    setExpanded(current => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // 存不下就算了，只影响下次默认值。
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    let hasHistory = false;
    const update = async () => {
      try {
        if (document.hidden) return;
        const [point, previous] = await Promise.all([
          fetchSystemPerformanceNow(),
          hasHistory
            ? Promise.resolve(undefined)
            : fetchSystemPerformanceHistory({ from: Date.now() - TIMELINE_MS }).catch(() => undefined),
        ]);
        if (!active) return;
        if (previous) hasHistory = true;
        if (point) setLatest(point);
        if (point || previous) {
          setPoints(current => {
            const timeline = previous ?? current;
            if (!point) return timeline;
            const last = timeline[timeline.length - 1];
            if (last && atMs(last) >= atMs(point)) return timeline;
            return [...timeline.filter(sample => atMs(sample) >= atMs(point) - TIMELINE_MS), point].slice(-HISTORY_POINTS);
          });
        }
      } catch {
        // 后端暂时不可用时保留最后一次读数，不清零。
      } finally {
        if (active) timer = window.setTimeout(update, POLL_MS);
      }
    };
    void update();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const metrics = useMemo<MetricSpec[]>(() => {
    const disk = formatRate(latest?.disk ?? null);
    const network = formatRate(latest?.network ?? null);
    const tok = formatTokPerSecond(latest?.tokensPerSecond ?? null);
    const modelCount = latest?.modelCount ?? null;
    return [
      {
        key: "cpu",
        label: "CPU",
        secondary: formatTemp(latest?.cpuTempC ?? null),
        secondaryLevel: levelOfTemp(latest?.cpuTempC ?? null),
        value: formatPercent(latest?.cpu ?? null),
        level: levelOfPercent(latest?.cpu ?? null),
        series: points.map(point => point.cpu),
        max: 100,
      },
      {
        key: "memory",
        label: "内存",
        value: formatPercent(latest?.memory ?? null),
        level: levelOfPercent(latest?.memory ?? null),
        series: points.map(point => point.memory),
        max: 100,
      },
      {
        key: "disk",
        label: "磁盘",
        secondary: disk.value === "—" ? "—" : `${disk.value} ${disk.unit}`,
        value: formatPercent(latest?.diskPercent ?? null),
        level: levelOfPercent(latest?.diskPercent ?? null),
        series: points.map(point => point.diskPercent ?? null),
        max: 100,
      },
      {
        key: "network",
        label: "网络",
        value: network.value,
        unit: network.unit,
        level: null,
        series: points.map(point => point.network),
        max: null,
      },
      {
        key: "gpu",
        label: "GPU",
        secondary: formatTemp(latest?.gpuTempC ?? null),
        secondaryLevel: levelOfTemp(latest?.gpuTempC ?? null),
        value: formatPercent(latest?.gpu ?? null),
        level: levelOfPercent(latest?.gpu ?? null),
        series: points.map(point => point.gpu),
        max: 100,
      },
      {
        key: "service",
        label: "模型服务",
        secondary: modelCount == null ? "—" : `${modelCount} 模型`,
        value: tok.value,
        unit: tok.unit,
        level: null,
        series: points.map(point => point.tokensPerSecond ?? null),
        max: null,
      },
    ];
  }, [latest, points]);

  const panelSeries = useMemo(() => {
    const window = range === "3m" ? 3 * 60 * 1000 : range === "30m" ? TIMELINE_MS : TIMELINE_MS;
    const from = Date.now() - window;
    return points.filter(point => atMs(point) >= from);
  }, [points, range]);

  const at = latest ? atMs(latest) : null;

  return (
    <div className={expanded ? "sysbar is-expanded" : "sysbar"} ref={barRef}>
      <div className="sysbar-row">
      <button
        type="button"
        className="sysbar-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? "收起系统性能" : "展开系统性能"}
        title={expanded ? "收起系统性能" : "展开系统性能"}
        onClick={toggle}
      >
        <span>性能</span>
        <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M1 1.5 5 5l4-3.5" />
        </svg>
      </button>
      <div className="sysbar-items" role="group" aria-label="实时系统性能">
        {metrics.map(metric => {
          const path = sparkPath(metric.series, metric.max);
          return (
            <span className={`sys-metric${metric.level ? ` is-${metric.level}` : ""}`} key={metric.key}>
              <span className="sys-metric-text">
                <span className="sys-metric-key">{metric.label}</span>
                {metric.secondary ? (
                  <span className={`sys-metric-sec${metric.secondaryLevel ? ` is-${metric.secondaryLevel}` : ""}`}>
                    {metric.secondary}
                  </span>
                ) : null}
                <span className="sys-metric-value">{metric.value}</span>
                {metric.unit ? <span className="sys-metric-unit">{metric.unit}</span> : null}
              </span>
              <span className="sys-metric-spark" aria-hidden="true">
                {path ? (
                  <svg viewBox="0 0 100 20" preserveAspectRatio="none">
                    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
                  </svg>
                ) : null}
              </span>
            </span>
          );
        })}
      </div>
      </div>
      {expanded ? (
        <div className="sysbar-panel" role="region" aria-label="系统性能详情">
          <div className="sysbar-panel-head">
            <h3>系统性能</h3>
            <span className="sysbar-panel-sub">
              {range === "3m" ? "近 3 分钟" : range === "30m" ? "近 30 分钟" : "本次运行"} · 每 {POLL_MS / 1000} 秒采样
            </span>
            <span className="sysbar-chips" role="tablist" aria-label="时间区间">
              {([["3m", "3 分钟"], ["30m", "30 分钟"], ["run", "本次运行"]] as const).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  role="tab"
                  aria-selected={range === key}
                  className={range === key ? "is-on" : undefined}
                  onClick={() => setRange(key)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div className="sysbar-cards">
            <PanelCard label="CPU" value={formatPercent(latest?.cpu ?? null)} peak={peakOf(points, "cpu", formatPercent)} level={levelOfPercent(latest?.cpu ?? null)} series={panelSeries.map(point => point.cpu)} max={100} />
            <PanelCard label="内存" value={formatPercent(latest?.memory ?? null)} peak={peakOf(points, "memory", formatPercent)} level={levelOfPercent(latest?.memory ?? null)} series={panelSeries.map(point => point.memory)} max={100} />
            <PanelCard label="磁盘" value={formatPercent(latest?.diskPercent ?? null)} peak={peakOf(points, "diskPercent", formatPercent)} level={levelOfPercent(latest?.diskPercent ?? null)} series={panelSeries.map(point => point.diskPercent ?? null)} max={100} />
            <PanelCard label="网络" value={formatRateShort(latest?.network ?? null)} peak={peakOf(points, "network", formatRateShort)} level={null} series={panelSeries.map(point => point.network)} max={null} />
            <PanelCard label="GPU" value={formatPercent(latest?.gpu ?? null)} peak={peakOf(points, "gpu", formatPercent)} level={levelOfPercent(latest?.gpu ?? null)} series={panelSeries.map(point => point.gpu)} max={100} />
            <PanelCard label="CPU 温度" value={formatTemp(latest?.cpuTempC ?? null)} peak={peakOf(points, "cpuTempC", formatTemp)} level={levelOfTemp(latest?.cpuTempC ?? null)} series={panelSeries.map(point => point.cpuTempC ?? null)} max={100} />
            <PanelCard label="GPU 温度" value={formatTemp(latest?.gpuTempC ?? null)} peak={peakOf(points, "gpuTempC", formatTemp)} level={levelOfTemp(latest?.gpuTempC ?? null)} series={panelSeries.map(point => point.gpuTempC ?? null)} max={100} />
            <PanelCard label="模型服务" value={formatTokShort(latest?.tokensPerSecond ?? null)} peak={peakOf(points, "tokensPerSecond", formatTokShort)} level={null} series={panelSeries.map(point => point.tokensPerSecond ?? null)} max={null} />
          </div>
          <span className="sysbar-panel-foot">采样时刻 {at ? new Date(at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
        </div>
      ) : null}
    </div>
  );
}

function PanelCard(props: {
  label: string;
  value: string;
  peak: string;
  level: Level | null;
  series: (number | null)[];
  max: number | null;
}) {
  const path = sparkPath(props.series, props.max);
  return (
    <div className={`sysbar-card${props.level ? ` is-${props.level}` : ""}`}>
      <div className="sysbar-card-head">
        <span className="sysbar-card-key">{props.label}</span>
        <span className="sysbar-card-value">{props.value}</span>
        <span className="sysbar-card-peak">峰 {props.peak}</span>
      </div>
      <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
    </div>
  );
}

const atMs = (point: SystemPerformancePoint) =>
  typeof point.at === "number" ? point.at : Date.parse(point.at);

type NumericKey =
  | "cpu" | "memory" | "disk" | "network" | "gpu"
  | "diskPercent" | "cpuTempC" | "gpuTempC" | "tokensPerSecond" | "modelCount";

function peakOf(
  points: readonly SystemPerformancePoint[],
  key: NumericKey,
  format: (value: number | null) => string,
): string {
  let peak: number | null = null;
  for (const point of points) {
    const value = point[key];
    if (value == null || Number.isNaN(value)) continue;
    if (peak == null || value > peak) peak = value;
  }
  return format(peak);
}

function formatRateShort(value: number | null): string {
  const rate = formatRate(value);
  return rate.unit ? `${rate.value} ${rate.unit}` : rate.value;
}

function formatTokShort(value: number | null): string {
  const tok = formatTokPerSecond(value);
  return `${tok.value} ${tok.unit}`;
}
