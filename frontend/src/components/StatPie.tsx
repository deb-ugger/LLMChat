import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { LabelLayout } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption, EChartsType } from "echarts/core";

echarts.use([
  PieChart,
  TooltipComponent,
  LabelLayout,
  CanvasRenderer,
]);

export type PieSlice = {
  label: string;
  value: number;
  color: string;
};

type GroupProps = {
  slices: PieSlice[];
  height?: number;
};

type MidTip = {
  label: string;
  color: string;
  value: number;
  pct: string;
};

/** Former donut ["42%","64%"] (width 22pp); ring thickened +10% → width 24.2pp. */
const DONUT_RADIUS: [string, string] = ["39.8%", "64%"];
const SOLID_RADIUS: [string, string] = ["0%", "62%"];

function pieSeries(
  id: "count" | "ratio",
  slices: PieSlice[],
  center: [string, string],
): NonNullable<EChartsCoreOption["series"]> {
  const isRatio = id === "ratio";
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  const empty = total <= 0;
  // Swapped forms: count = donut (left), ratio = solid pie (right)
  const radius = isRatio ? SOLID_RADIUS : DONUT_RADIUS;

  const data = empty
    ? [
        {
          name: `__empty__${id}`,
          value: 1,
          itemStyle: { color: "#edf1f6" },
          label: { show: false },
          labelLine: { show: false },
          tooltip: { show: false },
          emphasis: { disabled: true },
        },
      ]
    : slices
        .filter((s) => s.value > 0)
        .map((s) => ({
          name: `${s.label}__${id}`,
          value: s.value,
          itemStyle: { color: s.color },
        }));

  return {
    id,
    type: "pie",
    name: isRatio ? "占比" : "数量",
    radius,
    center,
    padAngle: empty ? 0 : 2,
    minAngle: empty ? 0 : 2,
    avoidLabelOverlap: true,
    stillShowZeroSum: true,
    legendHoverLink: false,
    itemStyle: {
      borderRadius: isRatio ? 4 : 6,
      borderColor: "#ffffff",
      borderWidth: 2,
    },
    label: {
      show: !empty,
      position: "outside",
      formatter: (params: unknown) => {
        const p = params as { name: string; value: number; percent: number };
        const label = p.name.replace(/__(count|ratio)$/, "");
        return isRatio
          ? `{name|${label}}\n{val|${p.percent.toFixed(1)}%}`
          : `{name|${label}}\n{val|${p.value}}`;
      },
      rich: {
        name: {
          fontSize: 11,
          color: "#6b778a",
          lineHeight: 15,
          fontFamily: "Source Sans 3, Noto Sans SC, sans-serif",
        },
        val: {
          fontSize: 13,
          fontWeight: 700,
          color: "#1c2430",
          lineHeight: 18,
          fontFamily: "Source Sans 3, Noto Sans SC, sans-serif",
        },
      },
    },
    labelLine: {
      show: !empty,
      length: 8,
      length2: 6,
      smooth: 0.2,
      lineStyle: { width: 1, color: "#c5d0de" },
    },
    emphasis: {
      scale: true,
      scaleSize: 5,
      focus: "self",
      blurScope: "series",
      itemStyle: {
        shadowBlur: 12,
        shadowOffsetY: 2,
        shadowColor: "rgba(28, 36, 48, 0.16)",
      },
    },
    data,
  };
}

/**
 * Dual pies + custom legend.
 * - Hover a slice: only that chart's native tooltip (count OR %).
 * - Hover legend: dual highlight + mid bubble with both metrics.
 * - Click legend: toggle visibility on both pies.
 */
export function StatPieGroup({ slices, height = 168 }: GroupProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [midTip, setMidTip] = useState<MidTip | null>(null);
  const midTipActiveRef = useRef(false);

  const visibleSlices = useMemo(
    () => slices.filter((s) => !hidden.has(s.label)),
    [slices, hidden],
  );

  const totalAll = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  const totalVisible = visibleSlices.reduce(
    (a, s) => a + Math.max(0, s.value),
    0,
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, {
      renderer: "canvas",
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const option: EChartsCoreOption = {
      animationDuration: 360,
      animationEasing: "cubicOut",
      animationDurationUpdate: 240,
      color: visibleSlices.map((s) => s.color),
      legend: { show: false },
      tooltip: {
        trigger: "item",
        appendToBody: true,
        backgroundColor: "#fff",
        borderColor: "#e5eaf0",
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: "#1c2430", fontSize: 12 },
        extraCssText:
          "box-shadow: 0 6px 18px rgba(28,36,48,0.08); border-radius: 8px;",
        formatter: (params: unknown) => {
          if (midTipActiveRef.current) return "";
          const p = params as {
            seriesId?: string;
            name: string;
            value: number;
            percent: number;
            marker: string;
          };
          if (p.name.startsWith("__empty__")) return "";
          const label = p.name.replace(/__(count|ratio)$/, "");
          const isRatio = p.seriesId === "ratio" || p.name.endsWith("__ratio");
          return isRatio
            ? `${p.marker} ${label}&nbsp;&nbsp;<b>${p.percent.toFixed(1)}%</b>`
            : `${p.marker} ${label}&nbsp;&nbsp;<b>${p.value}</b>`;
        },
      },
      graphic: undefined,
      series: [
        pieSeries("count", visibleSlices, ["25%", "46%"]),
        pieSeries("ratio", visibleSlices, ["75%", "46%"]),
      ],
    };

    chart.setOption(option, true);
    requestAnimationFrame(() => chart.resize());
  }, [visibleSlices, totalVisible, height]);

  const highlightFromLegend = (label: string) => {
    if (hidden.has(label)) {
      setMidTip(null);
      midTipActiveRef.current = false;
      return;
    }
    const chart = chartRef.current;
    const slice = slices.find((s) => s.label === label);
    if (!slice) return;
    midTipActiveRef.current = true;
    if (chart) {
      chart.dispatchAction({ type: "hideTip" });
      chart.dispatchAction({ type: "downplay" });
      chart.dispatchAction({ type: "highlight", name: `${label}__count` });
      chart.dispatchAction({ type: "highlight", name: `${label}__ratio` });
    }
    setMidTip({
      label,
      color: slice.color,
      value: slice.value,
      pct:
        totalAll > 0 ? ((slice.value / totalAll) * 100).toFixed(1) : "0.0",
    });
  };

  const clearLegendHighlight = () => {
    const chart = chartRef.current;
    midTipActiveRef.current = false;
    if (chart) {
      chart.dispatchAction({ type: "downplay" });
      chart.dispatchAction({ type: "hideTip" });
    }
    setMidTip(null);
  };

  const toggleSlice = (label: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
    midTipActiveRef.current = false;
    setMidTip(null);
    chartRef.current?.dispatchAction({ type: "downplay" });
    chartRef.current?.dispatchAction({ type: "hideTip" });
  };

  return (
    <div className="stat-pie-group">
      <div className="stat-pie-stage" style={{ height }}>
        <div className="stat-pie-canvas" ref={hostRef} />
        {midTip && (
          <div className="stat-mid-tip" role="status">
            <span className="stat-mid-tip-arrow is-left" aria-hidden />
            <div className="stat-mid-tip-body">
              <div className="stat-mid-tip-title">
                <span
                  className="stat-mid-tip-dot"
                  style={{ background: midTip.color }}
                />
                <b>{midTip.label}</b>
              </div>
              <div className="stat-mid-tip-row">
                数量&nbsp;&nbsp;<b>{midTip.value}</b>
              </div>
              <div className="stat-mid-tip-row">
                占比&nbsp;&nbsp;<b>{midTip.pct}%</b>
              </div>
            </div>
            <span className="stat-mid-tip-arrow is-right" aria-hidden />
          </div>
        )}
      </div>
      <ul className="stat-shared-legend">
        {slices.map((s) => {
          const off = hidden.has(s.label);
          const pct =
            totalAll > 0 ? ((s.value / totalAll) * 100).toFixed(1) : "0.0";
          return (
            <li
              key={s.label}
              className={off ? "is-off" : undefined}
              onMouseEnter={() => highlightFromLegend(s.label)}
              onMouseLeave={clearLegendHighlight}
              onClick={() => toggleSlice(s.label)}
              title={
                off
                  ? `点击显示「${s.label}」`
                  : `点击隐藏「${s.label}」· ${s.value}（${pct}%）`
              }
            >
              <span
                className="stat-shared-swatch"
                style={{ background: off ? "#c5cdd8" : s.color }}
              />
              <span>{s.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
