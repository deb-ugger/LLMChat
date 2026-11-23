import { useCallback, useEffect, useState } from "react";
import { readGameFormalHistory } from "../gameTextBenchmark";
import { gameDuration, type StepPerformance } from "../gameModelPerformance";

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function runSummary(run: StepPerformance) {
  const meters = Object.values(run.models ?? {}).filter(meter => meter.requests > 0);
  const outputs = meters.map(meter => meter.usage?.completionTokens ?? meter.tokens);
  return {
    elapsed: run.elapsedMs == null ? "—" : gameDuration(run.elapsedMs),
    requests: run.models ? meters.reduce((sum, meter) => sum + meter.requests, 0) : "—",
    tokens: meters.length && outputs.every(value => value != null) ? outputs.reduce((sum, value) => sum + value, 0) : "—",
    models: [...new Set(meters.map(meter => meter.model).filter(Boolean))].join(" + "),
  };
}

export function FormalRunRecords({ scope, step }: { scope: string; step: string }) {
  const [runs, setRuns] = useState<StepPerformance[]>([]);
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
        <p className="hint">当前步骤暂无正式运行记录。工作流中实际执行过的步骤会在这里归档。</p>
      ) : null}
      {runs.length > 0 ? (
        <ol className="game-benchmark-formal-list">
          {runs.map((run, index) => {
            const summary = runSummary(run);
            const endedAt = run.endedAt || run.beginTime;
            return (
              <li key={`${run.taskId ?? index}-${endedAt ?? ""}`} className="game-benchmark-formal-item">
                <div className="game-benchmark-formal-row">
                  <time dateTime={endedAt}>{formatTime(endedAt)}</time>
                  <span className="game-benchmark-formal-models" title={summary.models || undefined}>
                    {summary.models || "无模型调用"}
                  </span>
                  <span className="game-benchmark-formal-metrics">
                    <span>用时 <strong>{summary.elapsed}</strong></span>
                    <span>请求 <strong>{summary.requests}</strong></span>
                    <span>Token <strong>{summary.tokens}</strong></span>
                  </span>
                </div>
                {run.itemsDone != null && <p className="hint">已处理 {run.itemsDone}
                  {!!run.failures && ` · 失败 ${run.failures}`}
                </p>}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
