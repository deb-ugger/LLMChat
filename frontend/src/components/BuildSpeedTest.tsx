import { useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

const tests = {
  "wasm-full": { label: "WASM 全量 Release", description: "空编译目录，比较内嵌和外置。" },
  "wasm-incremental": { label: "WASM 增量 Release", description: "复用依赖产物，模拟主库源文件更新，再比较内嵌和外置。" },
  "cargo-cache": { label: "Cargo 无改动重跑", description: "从全量构建开始，连续重跑三次，记录耗时、缓存命中和重编原因。" },
  "frontend-preview": { label: "纯前端预览", description: "对比前端有改动和缓存命中时的编译与预览发布耗时。" },
  "backend-only": { label: "仅 C++ 后端改动", description: "同一次后端重编，对比仅更新后端和走标准构建流程。" },
  parallel: { label: "前后端串行与并行", description: "模拟前后端同时改动，交替各跑两轮，记录准备阶段和完整耗时。" },
} as const;
type TestId = keyof typeof tests;
const testIds = Object.keys(tests) as TestId[];

const presets: Record<string, { label: string; tests: readonly TestId[] }> = {
  all: { label: "全部测试", tests: testIds },
  frontend: { label: "前端预览", tests: ["frontend-preview"] },
  backend: { label: "C++ 后端更新", tests: ["backend-only"] },
  wasm: { label: "WASM 内嵌与外置", tests: ["wasm-full", "wasm-incremental"] },
  cache: { label: "Cargo 缓存", tests: ["cargo-cache"] },
  pipeline: { label: "构建流程与并行", tests: ["frontend-preview", "backend-only", "parallel"] },
};
const selectionKey = "llmchat-build-speed-test-selection";
const resultKey = "llmchat-build-speed-test";

type ReleaseMeasurement = {
  variant: "embedded" | "external";
  phase: "full" | "incremental" | "nochange";
  round?: number;
  seconds: number;
  dirty?: number;
  fresh?: number;
  reason?: string;
};
type PipelineMeasurement = {
  test: "frontend-preview" | "backend-only" | "parallel";
  scenario: string;
  round?: number;
  seconds: number;
  preparation?: number;
  front?: number;
  backend?: number;
  cargo?: number;
  package?: number;
};
type Measurement = ReleaseMeasurement | PipelineMeasurement;

function readList(key: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

const time = (seconds: number) => seconds.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " 秒";
const scenarioLabels: Record<string, string> = {
  embedded: "WASM 内嵌", external: "WASM 外置",
  changed: "有前端改动", cached: "前端缓存命中",
  sidecar: "仅编译与更新后端", standard: "标准构建流程",
  serial: "串行", parallel: "并行",
};

function progressLabel(value: string) {
  const [first, second, round] = value.split(" ");
  switch (first) {
    case "waiting": return "等待构建锁…";
    case "prepare": return "正在准备隔离目录…";
    case "cleanup": return "正在清理测试产物…";
    case "pipeline-warmup": return "正在预热前端和后端构建缓存…";
    case "frontend-preview": return "正在测试前端预览 · " + scenarioLabels[second];
    case "backend-only": return "正在编译并校验后端产物…";
  }
  if (first === "embedded" || first === "external") {
    const phases: Record<string, string> = {
      full: "全量 Release", incremental: "增量 Release", nochange: "无改动重跑 · 第 " + round + " 次",
      warmup: "预热", "pipeline-warmup": "桌面构建预热", "backend-only-standard": "后端改动走标准构建",
      serial: "串行 · 第 " + round + " 轮 · 桌面构建", parallel: "并行 · 第 " + round + " 轮 · 桌面构建",
    };
    return (phases[second] ?? "正在构建桌面程序") + " · " + scenarioLabels[first];
  }
  const [scenario, pair] = first.split("-");
  if (scenario === "serial" || scenario === "parallel")
    return scenarioLabels[scenario] + " · 第 " + pair + " 轮 · 前后端构建";
  return "正在构建…";
}

function measurementTest(row: Measurement): TestId {
  if ("test" in row) return row.test;
  if (row.phase === "nochange") return "cargo-cache";
  return row.phase === "full" ? "wasm-full" : "wasm-incremental";
}

function measurementScenario(row: Measurement) {
  const scenario = "test" in row ? row.scenario : row.variant;
  return (scenarioLabels[scenario] ?? scenario) + (row.round && ("test" in row || row.phase === "nochange") ? " · 第 " + row.round + " 轮" : "");
}

function measurementsDetail(row: Measurement) {
  if ("test" in row) {
    const phases = [
      ["前后端准备", row.preparation], ["前端", row.front], ["后端", row.backend],
      ["Cargo", row.cargo], ["发布和校验", row.package],
    ] as const;
    return phases.flatMap(([label, seconds]) => seconds === undefined ? [] : [label + " " + time(seconds)]).join(" · ");
  }
  return row.dirty === undefined ? "" : "重编 " + row.dirty + " 项 · 复用 " + (row.fresh ?? "—") + " 项";
}

export function BuildSpeedTest({ onRunningChange }: { onRunningChange?: (running: boolean) => void }) {
  const [selection, setSelection] = useState<TestId[]>(() => {
    const saved = readList(selectionKey);
    return saved ? testIds.filter(id => saved.includes(id)) : [...testIds];
  });
  const [result, setResult] = useState<Measurement[]>(() => (readList(resultKey) ?? []) as Measurement[]);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const canRun = isTauri();
  const preset = Object.keys(presets).find(key => {
    const presetTests = presets[key].tests;
    return presetTests.length === selection.length && presetTests.every(id => selection.includes(id));
  }) ?? "custom";
  const applySelection = (next: readonly TestId[]) => {
    const ordered = testIds.filter(id => next.includes(id));
    setSelection(ordered);
    localStorage.setItem(selectionKey, JSON.stringify(ordered));
  };

  async function start() {
    if (progress || !selection.length) return;
    onRunningChange?.(true);
    setError("");
    setProgress(progressLabel("waiting"));
    try {
      const channel = new Channel<string>();
      channel.onmessage = phase => setProgress(progressLabel(phase));
      const measurements = await invoke<Measurement[]>("run_build_speed_test", { progress: channel, tests: selection });
      setResult(measurements);
      localStorage.setItem(resultKey, JSON.stringify(measurements));
    } catch (cause) { setError(String(cause)); }
    finally {
      setProgress("");
      onRunningChange?.(false);
    }
  }

  return <section className="game-workflow-help app-help-view" aria-label="构建测速">
    <header className="game-workflow-help-header">
      <h1>构建测速</h1>
      <button type="button" className="unity-btn unity-btn-primary" disabled={!canRun || !!progress || !selection.length}
        onClick={() => void start()}>开始测速</button>
    </header>
    <div className="game-workflow-help-content">
      <p className="game-workflow-help-summary">选择预设或单独勾选测试项。测速使用隔离目录，结束后清理测试产物。</p>
      <fieldset disabled={!!progress}>
        <legend>测试配置</legend>
        <label>测试预设 <select value={preset} onChange={event => {
          const choice = presets[event.target.value];
          if (choice) applySelection(choice.tests);
        }}>
          {Object.entries(presets).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
          <option value="custom" disabled>自定义勾选</option>
        </select></label>
        {testIds.map(id => <section className="game-workflow-help-section" key={id}>
          <label>
            <input type="checkbox" checked={selection.includes(id)}
              onChange={event => applySelection(event.target.checked ? [...selection, id] : selection.filter(item => item !== id))} />
            {" "}{tests[id].label}
          </label>
          <p className="hint">{tests[id].description}</p>
        </section>)}
      </fieldset>
      {!canRun && <p className="hint">请在桌面版中运行构建测速。</p>}
      {progress && <p role="status">{progress}</p>}
      {error && <pre role="alert" className="hint">{error}</pre>}
      {!!result.length && <section className="game-workflow-help-section" aria-labelledby="build-speed-results">
        <h2 id="build-speed-results">最近一次测速结果</h2>
        <table aria-label="最近一次构建测速结果">
          <thead><tr><th scope="col">测试项</th><th scope="col">场景</th><th scope="col">耗时</th><th scope="col">分项与原因</th></tr></thead>
          <tbody>
            {result.map(row => {
              const test = measurementTest(row);
              const scenario = measurementScenario(row);
              return <tr key={test + scenario}>
                <th scope="row">{tests[test].label}</th><td>{scenario}</td><td>{time(row.seconds)}</td>
                <td>{measurementsDetail(row) || "—"}
                  {"reason" in row && row.reason && <details><summary>重编原因</summary><p>{row.reason}</p></details>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>}
    </div>
  </section>;
}
