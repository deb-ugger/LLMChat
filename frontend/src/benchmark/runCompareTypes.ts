/** 模型比较面板的输入结构。数据来自 benchmark/benchmarkCompare.ts，界面只负责渲染。 */
export type QualityPoint = {
  /** 模型名（可能是「模型 · 并发」） */
  label: string;
  /** 吞吐，token/s 或 张/s */
  speed: number;
  /** 质量指标：0–1 之间越高越好；无标注时为 null */
  quality: number | null;
  /** 样本数 */
  samples: number;
  /** 失败率 0–1 */
  failureRate: number;
};

export type ConcurrencyCell = {
  model: string;
  concurrency: number;
  /** 平均吞吐 */
  speed: number;
  /** 平均单请求耗时，毫秒 */
  latencyMs: number;
  requests: number;
};

export type StageBar = {
  stage: string;
  /** 每个模型一条，顺序与 models 一致 */
  values: number[];
};

export type RunCompare = {
  models: string[];
  points: QualityPoint[];
  cells: ConcurrencyCell[];
  stages: StageBar[];
};
