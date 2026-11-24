export type SystemPerformancePoint = {
  /** 采样时刻，ISO 字符串或毫秒时间戳 */
  at: string | number;
  /** CPU 总占用率，0–100；null 表示该平台取不到 */
  cpu: number | null;
  /** 物理内存占用率，0–100 */
  memory: number | null;
  /** 磁盘读写速率合计，字节/秒 */
  disk: number | null;
  /** 以太网收发速率合计，字节/秒 */
  network: number | null;
  /** GPU 引擎占用率，0–100 */
  gpu: number | null;
  /** 磁盘占用率（% Disk Time），0–100；取不到为 null */
  diskPercent?: number | null;
  /** CPU 封装温度，摄氏度；取不到为 null */
  cpuTempC?: number | null;
  /** GPU 温度，摄氏度；取不到为 null */
  gpuTempC?: number | null;
  /** 温度来源：lhm / acpi / null */
  tempSource?: "lhm" | "acpi" | null;
  /** 最近窗口内的生成速率，token/秒 */
  tokensPerSecond?: number | null;
  /** 当前有请求的模型数量 */
  modelCount?: number | null;
  /** 正在调用的模型实例数；同一模型的并发请求分别计数。 */
  modelInstanceCount?: number | null;
};

export type SystemPerformanceSource = "formal" | "benchmark";
export type SystemPerformanceMetric = "cpu" | "memory" | "disk" | "network" | "gpu";

export type SystemPerformanceSample = {
  /** 本轮各指标的均值与峰值 */
  average: Record<SystemPerformanceMetric, number | null>;
  peak: Record<SystemPerformanceMetric, number | null>;
  samples: number;
  timelines: SystemPerformancePoint[][];
};
