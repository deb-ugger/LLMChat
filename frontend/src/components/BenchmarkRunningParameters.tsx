import type { BenchmarkParameter } from "../benchmark/benchmarkParameters";

export function BenchmarkRunningParameters({ parameters, stacked = false }: {
  parameters: readonly BenchmarkParameter[];
  stacked?: boolean;
}) {
  return <div className={"game-benchmark-running-params" + (stacked ? " is-stacked" : "")} role="group" aria-label="当前配置参数">
    {parameters.map(({ label, value }) => <span className="kv" key={label}>
      <span>{label}</span><b title={value} data-tooltip={value}>{value}</b>
    </span>)}
  </div>;
}
