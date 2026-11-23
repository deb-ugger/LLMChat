import { useCallback, useEffect, useState } from "react";
import { readGameFormalHistory } from "../gameTextBenchmark";
import type { BenchmarkResult } from "../gameTextBenchmark";
import { gameDuration } from "../gameModelPerformance";
import type { BenchmarkTarget as Target } from "../benchmark/benchmarkRunner";

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function runSummary(run: BenchmarkResult) {
  const performance = run.performance;
  const models = Object.values(performance.models ?? {}).filter((meter) => meter.requests > 0);
  const tokens = models.reduce((sum, meter) => sum + (meter.tokens ?? 0), 0);
  return {
    elapsed: Math.max(0, performance.elapsedMs ?? 0),
    requests: models.reduce((sum, meter) => sum + meter.requests, 0),
    tokens,
    models: [...new Set(models.map((meter) => meter.model).filter(Boolean))] as string[],
  };
}

export function FormalRunRecords({ scope, step }: { scope: string; step: Target }) {
  const [runs, setRuns] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    readGameFormalHistory(scope, step)
      .then((list) => {
        if (!alive) return;
        setRuns(list);
      })
      .catch((reason) => {
        if (!alive) return;
        setError(String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, step, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  return (
    <section className="game-benchmark-section game-benchmark-formal" aria-label="正式运行记录">
      <header className="game-benchmark-records-head">
        <h3>正式运行</h3>
        <button type="button" className="unity-btn is-ghost" disabled={loading} onClick={refresh}>
          刷新
        </button>
      </header>
      {loading ? <p className="hint" role="status">正在读取正式运行记录…</p> : null}
      {error ? <p className="unity-offline-error" role="alert">{error}</p> : null}
      {!loading && !error && runs.length === 0 ? (
        <p className="hint">这一步还没有正式运行记录。正式运行指你在工作流里真正跑过的步骤，不是测试队列。</p>
      ) : null}
      {runs.length > 0 ? (
        <ol className="game-benchmark-formal-list">
          {runs.map((run, index) => {
            const summary = runSummary(run);
            const endedAt = run.performance.endedAt || run.performance.beginTime;
            return (
              <li key={`${endedAt ?? "run"}-${index}`} className="game-benchmark-formal-item">
                <div className="game-benchmark-formal-row">
                  <time>{formatTime(endedAt)}</time>
                  <span className="game-benchmark-formal-models">
                    {summary.models.length ? summary.models.join(" + ") : "无模型调用"}
                  </span>
                  <span className="game-benchmark-formal-metrics">
                    <span>用时 <strong>{gameDuration(summary.elapsed)}</strong></span>
                    <span>请求 <strong>{summary.requests}</strong></span>
                    {summary.tokens > 0 ? <span>token <strong>{summary.tokens}</strong></span> : null}
                  </span>
                </div>
                <p className="hint">
                  已处理 {run.translated}/{run.selected}
                  {run.failed > 0 ? ` · 失败 ${run.failed}` : ""}
                  {run.performance.benchmark?.detail ? ` · ${run.performance.benchmark.detail}` : ""}
                </p>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
