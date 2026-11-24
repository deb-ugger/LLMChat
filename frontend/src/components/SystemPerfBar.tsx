import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SystemPerformancePoint } from "../benchmark/systemPerformanceTypes";
import { fetchSystemPerformanceHistory, fetchSystemPerformanceNow } from "../systemPerformance";

/**
 * 底部系统性能条。
 *
 * 收起态（38px）：性能⌄ │ CPU 56°C 12% ▁▂▃ │ 内存 72% ▁▂▃ │ 磁盘 9.4MB/s 62% ▁▂▃ │
 *               网络 477KB/s ▁▂▃ │ GPU 84°C 88% ▁▂▃ │ 模型服务 2路调用 53.0tok/s ▁▂▃
 * 展开态：向上浮起随内容定高的面板，7 张卡片（CPU / 内存 / 磁盘 / 网络 / GPU / CPU 温度 / 模型服务）。
 *
 * 取不到的字段（温度、磁盘占用率、tok/s、模型数量）显示「—」，不参与取档，
 * 避免把「没采到」误画成绿色正常。
 */

type Level = "lo" | "mid" | "hi";
type Tone = "cpu" | "memory" | "disk" | "network" | "gpu" | "temp" | "service";

const PERCENT_MID = 50;
const PERCENT_HIGH = 80;
const TEMP_MID = 65;
const TEMP_HIGH = 80;

const TIMELINE_MS = 30 * 60 * 1000;
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

function formatTemp(value: number | null, spaceBeforeUnit = false): string {
  return value == null || Number.isNaN(value) ? "—" : `${value.toFixed(0)}${spaceBeforeUnit ? " " : ""}°C`;
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

const sparkKeys = {
  cpu: "cpu", memory: "memory", disk: "diskPercent", network: "network",
  gpu: "gpu", temp: "cpuTempC", service: "tokensPerSecond",
} as const;

function PerformanceSpark({ points, tone, max }: {
  points: readonly SystemPerformancePoint[];
  tone: Tone;
  max: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { samples, path } = useMemo(() => {
    const first = points[0], last = points.at(-1);
    if (!first || !last) return { samples: [], path: "" };
    const start = atMs(first), duration = atMs(last) - start;
    const key = sparkKeys[tone];
    const top = max ?? points.reduce((highest, point) => Math.max(highest, point[key] ?? 0), 1);
    const samples = points.map(point => {
      const value = point[key];
      return { point, x: duration > 0 ? 100 * (atMs(point) - start) / duration : 0,
        y: typeof value === "number" && Number.isFinite(value) ? 20 - Math.min(value / top, 1) * 18 : null };
    });
    let drawing = false;
    const path = samples.map(({ x, y }) => {
      if (y === null) { drawing = false; return ""; }
      const command = (drawing ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      drawing = true;
      return command;
    }).join(" ");
    return { samples, path };
  }, [points, tone, max]);

  const sample = hover === null ? samples.at(-1) : samples.reduce<(typeof samples)[number] | undefined>((nearest, candidate) =>
    !nearest || Math.abs(candidate.x - hover) < Math.abs(nearest.x - hover) ? candidate : nearest, undefined);
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"
      data-tooltip={sample ? sampleHint(sample.point, tone) : undefined}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width > 0) setHover(100 * (event.clientX - rect.left) / rect.width);
      }}
      onPointerLeave={() => setHover(null)}>
      <rect width="100" height="20" fill="transparent" />
      <g pointerEvents="none">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        {hover !== null && sample &&
          <line x1={sample.x} x2={sample.x} y1="0" y2="20" stroke="currentColor" opacity=".65" vectorEffect="non-scaling-stroke" />}
      </g>
    </svg>
  );
}

function sampleHint(point: SystemPerformancePoint, tone: Tone) {
  const memory = (bytes?: number | null) => bytes == null ? "—" : (bytes / 1024 ** 3).toFixed(1) + " GB";
  const time = new Date(atMs(point)).toLocaleTimeString("zh-CN", { hour12: false });
  switch (tone) {
    case "cpu": return time + "\nCPU 占用率 " + formatPercent(point.cpu) + "\nCPU 温度 " + formatTemp(point.cpuTempC ?? null);
    case "memory": return time + "\n内存占用率 " + formatPercent(point.memory) +
      "\n已用 " + memory(point.memoryUsedBytes) + "\n可用 " + memory(point.memoryAvailableBytes);
    case "disk": return time + "\n磁盘占用率 " + formatPercent(point.diskPercent ?? null) +
      "\n总速率 " + formatRateShort(point.disk) + "\n读取 " + formatRateShort(point.diskReadBytesPerSec ?? null) +
      "\n写入 " + formatRateShort(point.diskWriteBytesPerSec ?? null);
    case "network": return time + "\n网络总速率 " + formatRateShort(point.network) +
      "\n接收 " + formatRateShort(point.networkReceiveBytesPerSec ?? null) + "\n发送 " + formatRateShort(point.networkSendBytesPerSec ?? null);
    case "gpu": return time + "\nGPU 占用率 " + formatPercent(point.gpu) + "\nGPU 温度 " + formatTemp(point.gpuTempC ?? null);
    case "temp": return time + "\nCPU 温度 " + formatTemp(point.cpuTempC ?? null);
    case "service": return time + "\n生成速率 " + formatTokShort(point.tokensPerSecond ?? null) +
      "\n正在调用 " + (point.modelInstanceCount == null ? "—" : point.modelInstanceCount + " 路");
  }
}

type MetricSpec = {
  key: string;
  label: string;
  tone: Tone;
  secondary?: string;
  value: string;
  unit?: string;
  level: Level | null;
  secondaryLevel?: Level | null;
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
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const changeExpanded = useCallback((next: boolean) => {
    setExpanded(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // 存不下就算了，只影响下次默认值。
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
      changeExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeExpanded, expanded]);

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
            return [...timeline.filter(sample => atMs(sample) >= atMs(point) - TIMELINE_MS), point];
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

  const visiblePoints = useMemo(() => {
    const from = range === "run" ? performance.timeOrigin : Date.now() - (range === "3m" ? 3 * 60 * 1000 : TIMELINE_MS);
    return points.filter(point => atMs(point) >= from);
  }, [points, range]);

  const metrics = useMemo<MetricSpec[]>(() => {
    const disk = formatRate(latest?.disk ?? null);
    const network = formatRate(latest?.network ?? null);
    const tok = formatTokPerSecond(latest?.tokensPerSecond ?? null);
    const modelCount = latest?.modelInstanceCount ?? null;
    const gpuTemperature = formatTemp(latest?.gpuTempC ?? null);
    return [
      {
        key: "cpu",
        tone: "cpu",
        label: "CPU",
        secondary: formatTemp(latest?.cpuTempC ?? null),
        secondaryLevel: levelOfTemp(latest?.cpuTempC ?? null),
        value: formatPercent(latest?.cpu ?? null),
        level: levelOfPercent(latest?.cpu ?? null),
        max: 100,
      },
      {
        key: "memory",
        tone: "memory",
        label: "内存",
        value: formatPercent(latest?.memory ?? null),
        level: levelOfPercent(latest?.memory ?? null),
        max: 100,
      },
      {
        key: "disk",
        tone: "disk",
        label: "磁盘",
        secondary: disk.value === "—" ? "—" : `${disk.value} ${disk.unit}`,
        value: formatPercent(latest?.diskPercent ?? null),
        level: levelOfPercent(latest?.diskPercent ?? null),
        max: 100,
      },
      {
        key: "network",
        tone: "network",
        label: "网络",
        value: network.value,
        unit: network.unit,
        level: null,
        max: null,
      },
      {
        key: "gpu",
        tone: "gpu",
        label: "GPU",
        secondary: gpuTemperature === "—" ? undefined : gpuTemperature,
        secondaryLevel: levelOfTemp(latest?.gpuTempC ?? null),
        value: formatPercent(latest?.gpu ?? null),
        level: levelOfPercent(latest?.gpu ?? null),
        max: 100,
      },
      {
        key: "service",
        tone: "service",
        label: "模型服务",
        secondary: modelCount == null ? "—" : `${modelCount} 路调用`,
        value: tok.value,
        unit: tok.unit,
        level: null,
        max: null,
      },
    ];
  }, [latest]);

  const at = latest ? atMs(latest) : null;
  const gpuPanelTemperature = formatTemp(latest?.gpuTempC ?? null, true);
  const gpuPanelPeak = peakOf(visiblePoints, "gpu", formatPercent) + (gpuPanelTemperature === "—" ? "" : ` · ${gpuPanelTemperature}`);

  return (
    <div className={expanded ? "sysbar is-expanded" : "sysbar"}>
      <div className="sysbar-row">
      <button
        type="button"
        className="sysbar-toggle"
        ref={toggleRef}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        aria-label={expanded ? "收起系统性能" : "展开系统性能"}
        title={expanded ? "收起系统性能" : "展开系统性能"}
        onClick={() => changeExpanded(!expanded)}
      >
        <span>性能</span>
        <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M1 1.5 5 5l4-3.5" />
        </svg>
      </button>
      <div className="sysbar-items" role="group" aria-label="实时系统性能">
        {metrics.map(metric => {
          return (
            <span className={`sys-metric tone-${metric.tone}${metric.level ? ` is-${metric.level}` : ""}`} key={metric.key} data-tooltip={metric.key === "service" ? "正在进行的大模型服务调用数；同一模型并发调用分别计数。ONNX 推理路数在初筛配置中单独设置。" : undefined}>
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
                <PerformanceSpark points={visiblePoints} tone={metric.tone} max={metric.max} />
              </span>
            </span>
          );
        })}
      </div>
      </div>
      {expanded ? (
        <div className="sysbar-panel" ref={panelRef} id={panelId} role="region" aria-label="系统性能详情">
          <div className="sysbar-panel-head">
            <h3>系统性能</h3>
            <span className="sysbar-panel-sub">
              {range === "3m" ? "近 3 分钟" : range === "30m" ? "近 30 分钟" : "本次运行"} · 每 {POLL_MS / 1000} 秒采样
            </span>
            <span className="sysbar-panel-time">
              采样时刻 {at ? new Date(at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
            </span>
            <span className="sysbar-chips" role="group" aria-label="时间区间">
              {([["3m", "3 分钟"], ["30m", "30 分钟"], ["run", "本次运行"]] as const).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={range === key}
                  className={range === key ? "is-on" : undefined}
                  onClick={() => setRange(key)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div className="sysbar-cards">
            <PanelCard label="CPU" tone="cpu" value={formatPercent(latest?.cpu ?? null)} peak={peakOf(visiblePoints, "cpu", formatPercent)} peakLevel={levelOfPercent(peakValue(visiblePoints, "cpu"))} level={levelOfPercent(latest?.cpu ?? null)} points={visiblePoints} max={100} />
            <PanelCard label="内存" tone="memory" value={formatPercent(latest?.memory ?? null)} peak={peakOf(visiblePoints, "memory", formatPercent)} peakLevel={levelOfPercent(peakValue(visiblePoints, "memory"))} level={levelOfPercent(latest?.memory ?? null)} points={visiblePoints} max={100} />
            <PanelCard label="磁盘" tone="disk" value={formatPercent(latest?.diskPercent ?? null)} peak={peakOf(visiblePoints, "diskPercent", formatPercent)} peakLevel={levelOfPercent(peakValue(visiblePoints, "diskPercent"))} level={levelOfPercent(latest?.diskPercent ?? null)} points={visiblePoints} max={100} />
            <PanelCard label="网络" tone="network" value={formatRateShort(latest?.network ?? null)} peak={peakOf(visiblePoints, "network", formatRateShort)} peakLevel={null} level={null} points={visiblePoints} max={null} />
            <PanelCard label="GPU" tone="gpu" value={formatPercent(latest?.gpu ?? null)} peak={gpuPanelPeak} peakLevel={levelOfPercent(peakValue(visiblePoints, "gpu"))} level={levelOfPercent(latest?.gpu ?? null)} points={visiblePoints} max={100} />
            <PanelCard label="CPU 温度" tone="temp" value={formatTemp(latest?.cpuTempC ?? null)} peak={peakOf(visiblePoints, "cpuTempC", formatTemp)} peakLevel={levelOfTemp(peakValue(visiblePoints, "cpuTempC"))} level={levelOfTemp(latest?.cpuTempC ?? null)} points={visiblePoints} max={100} />
            <PanelCard label="模型服务" tone="service" value={formatTokShort(latest?.tokensPerSecond ?? null)} peak={peakOf(visiblePoints, "tokensPerSecond", formatTokShort)} peakLevel={null} level={null} points={visiblePoints} max={null} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PanelCard(props: {
  label: string;
  value: string;
  peak: string;
  peakLevel: Level | null;
  tone: Tone;
  level: Level | null;
  points: readonly SystemPerformancePoint[];
  max: number | null;
}) {
  return (
    <div className={`sysbar-card tone-${props.tone}${props.level ? ` is-${props.level}` : ""}`}>
      <div className="sysbar-card-head">
        <span className="sysbar-card-key">{props.label}</span>
        <span className="sysbar-card-value">{props.value}</span>
        <span className={`sysbar-card-peak${props.peakLevel ? ` is-${props.peakLevel}` : ""}`}>
          <span className="sysbar-card-peak-label">峰</span>
          <span className="sysbar-card-peak-value">{props.peak}</span>
        </span>
      </div>
      <PerformanceSpark points={props.points} tone={props.tone} max={props.max} />
    </div>
  );
}

const atMs = (point: SystemPerformancePoint) =>
  typeof point.at === "number" ? point.at : Date.parse(point.at);

type NumericKey =
  | "cpu" | "memory" | "disk" | "network" | "gpu"
  | "diskPercent" | "cpuTempC" | "tokensPerSecond" | "modelCount";

function peakValue(
  points: readonly SystemPerformancePoint[],
  key: NumericKey,
): number | null {
  let peak: number | null = null;
  for (const point of points) {
    const value = point[key];
    if (value == null || Number.isNaN(value)) continue;
    if (peak == null || value > peak) peak = value;
  }
  return peak;
}

function peakOf(
  points: readonly SystemPerformancePoint[],
  key: NumericKey,
  format: (value: number | null) => string,
): string {
  return format(peakValue(points, key));
}

function formatRateShort(value: number | null): string {
  const rate = formatRate(value);
  return rate.unit ? `${rate.value} ${rate.unit}` : rate.value;
}

function formatTokShort(value: number | null): string {
  const tok = formatTokPerSecond(value);
  return `${tok.value} ${tok.unit}`;
}
