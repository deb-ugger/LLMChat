export type PipelineStep = 1 | 2 | 3 | 4 | 5;

export type PipelineState = {
  visible: boolean;
  step: PipelineStep;
  detail: string;
  /** 0–1 overall progress */
  ratio: number;
  error?: string;
};

const STEP_LABELS: { step: PipelineStep; label: string }[] = [
  { step: 1, label: "打包窗口" },
  { step: 2, label: "断句重组" },
  { step: 3, label: "写回时间轴" },
  { step: 4, label: "翻译条目" },
  { step: 5, label: "保存导出" },
];

type Props = {
  state: PipelineState;
  /** Larger layout for modal */
  large?: boolean;
};

function stepClass(
  step: PipelineStep,
  current: PipelineStep,
  error?: string,
): string {
  if (error && step === current) return "is-error";
  if (step < current) return "is-done";
  if (step === current) return "is-active";
  return "is-pending";
}

export function RetimeProgressPanel({ state, large }: Props) {
  if (!state.visible) {
    return (
      <div className={`retime-pipeline ${large ? "is-large" : ""} is-idle`}>
        <p className="retime-pipeline-idle">
          开始翻译后将在此显示：打包 → 断句 → 写回 → 翻译 → 导出
        </p>
      </div>
    );
  }
  const pct = Math.min(100, Math.round(state.ratio * 1000) / 10);

  return (
    <div className={`retime-pipeline ${large ? "is-large" : ""}`}>
      <ol className="retime-pipeline-steps">
        {STEP_LABELS.map(({ step, label }, i) => (
          <li key={step} className={stepClass(step, state.step, state.error)}>
            {i > 0 && <span className="retime-pipeline-line" aria-hidden />}
            <span className="retime-pipeline-dot">{step}</span>
            <span className="retime-pipeline-label">{label}</span>
          </li>
        ))}
      </ol>
      <div className="retime-pipeline-detail">
        {state.error ? state.error : state.detail || "…"}
      </div>
      <div className="retime-pipeline-bar">
        <div
          className="retime-pipeline-fill"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="retime-pipeline-pct">{pct.toFixed(1)}%</div>
    </div>
  );
}
