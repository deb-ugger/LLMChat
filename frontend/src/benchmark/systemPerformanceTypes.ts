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
};

export type SystemPerformanceSample = {
  /** 本轮各指标的均值与峰值 */
  average: Omit<SystemPerformancePoint, "at">;
  peak: Omit<SystemPerformancePoint, "at">;
  samples: number;
};
