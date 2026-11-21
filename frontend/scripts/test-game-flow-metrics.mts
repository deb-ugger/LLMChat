import assert from "node:assert/strict";
import { deriveFlowMetrics } from "../src/gameFlowMetrics.ts";

function check(name: string, verify: () => void) {
  verify();
  console.log("PASS " + name);
}

check("纯 LLM：只有请求计时时回退，有生成计时时用实际生成速率", () => {
  const input = { tokens: 120, requestMs: 2000 };
  assert.deepEqual(deriveFlowMetrics(input), [
    { key: "generationRate", label: "纯生成", value: "60.0", unit: "tok/s" },
    { key: "requestRate", label: "请求平均", value: "60.0", unit: "tok/s" },
  ]);
  assert.deepEqual(
    deriveFlowMetrics({ ...input, generationTokens: 100, generationMs: 1250 }).map(metric => metric.value),
    ["80.0", "60.0"],
  );
});

check("纯检测：按已处理张数计算处理速度与每张耗时", () => {
  assert.deepEqual(deriveFlowMetrics({ items: 20, itemsDone: 3, elapsedMs: 2000 }), [
    { key: "itemsRate", label: "处理速度", value: "1.50", unit: "张/s" },
    { key: "secondsPerItem", label: "每张耗时", value: "0.67", unit: "秒/张" },
  ]);
});

check("混合：同时产出 Token 和图片速率", () => {
  const metrics = deriveFlowMetrics({ tokens: 200, requestMs: 4000, itemsDone: 8, elapsedMs: 4000 });
  assert.deepEqual(metrics.map(metric => metric.unit), ["tok/s", "tok/s", "张/s", "秒/张"]);
  assert.deepEqual(metrics.map(metric => metric.value), ["50.0", "50.0", "2.00", "0.50"]);
});

check("只有张数与用时：输出两项基础指标，保留明确的零张进度", () => {
  assert.deepEqual(deriveFlowMetrics({ items: 12, elapsedMs: 1800 }), [
    { key: "itemsDone", label: "已处理", value: "12", unit: "张" },
    { key: "elapsedMs", label: "用时", value: "1.80 秒" },
  ]);
  assert.equal(deriveFlowMetrics({ items: 12, itemsDone: 0, elapsedMs: 1800 })[0].value, "0");
  assert.equal(deriveFlowMetrics({ items: 12, itemsDone: 3 })[0].value, "3");
});

check("全空输入：保留零张和零秒，没有空值占位", () => {
  assert.deepEqual(deriveFlowMetrics({}).map(metric => metric.value), ["0", "0.00 秒"]);
});

check("分项耗时：按顺序显示提供的秒数，保留明确的零秒", () => {
  const metrics = deriveFlowMetrics({ queueMs: 250, processingMs: 1125, saveMs: 125, busyMs: 1000, idleMs: 0 });
  assert.deepEqual(metrics.slice(2), [
    { key: "queueMs", label: "排队", value: "0.25 秒" },
    { key: "processingMs", label: "处理与校验", value: "1.13 秒" },
    { key: "saveMs", label: "保存", value: "0.13 秒" },
    { key: "busyMs", label: "模型请求占用", value: "1.00 秒" },
    { key: "idleMs", label: "无在途模型请求", value: "0.00 秒" },
  ]);
});

check("失败张数：正值追加，零值不显示", () => {
  assert.deepEqual(deriveFlowMetrics({ itemsDone: 3, elapsedMs: 1000, failures: 2 }).at(-1),
    { key: "failures", label: "失败", value: "2", unit: "张" });
  assert.ok(!deriveFlowMetrics({ failures: 0 }).some(metric => metric.key === "failures"));
});

check("异常输入：零分母、负数、NaN 和 Infinity 按零处理", () => {
  const empty = deriveFlowMetrics({});
  assert.deepEqual(deriveFlowMetrics({ tokens: 100, requestMs: 0 }), empty);
  assert.deepEqual(deriveFlowMetrics({ tokens: Infinity, requestMs: 500, itemsDone: -1, elapsedMs: NaN, failures: -1 }), empty);
  assert.deepEqual(deriveFlowMetrics({ tokens: 20, requestMs: 1000, generationMs: -1 }).map(metric => metric.value), ["20.0", "20.0"]);
  assert.deepEqual(deriveFlowMetrics({ tokens: 20, requestMs: 1000, generationMs: 500, generationTokens: NaN }).map(metric => metric.value), ["0", "20.0"]);
  assert.equal(deriveFlowMetrics({ busyMs: Infinity }).at(-1)?.value, "0.00 秒");
});

check("小数格式：极小正值显示 <0.1，正常值保留规定的小数位", () => {
  assert.equal(deriveFlowMetrics({ tokens: 1, requestMs: 25000 })[0].value, "<0.1");
  assert.equal(deriveFlowMetrics({ tokens: 1, requestMs: 20000 })[0].value, "0.1");
  assert.equal(deriveFlowMetrics({ itemsDone: 1, elapsedMs: 30000 })[0].value, "<0.1");
  assert.equal(deriveFlowMetrics({ itemsDone: 1, elapsedMs: 20 })[1].value, "<0.1");
  assert.equal(deriveFlowMetrics({ queueMs: 1 }).at(-1)?.value, "<0.1 秒");
});

console.log("PASS 9/9 步骤指标用例");
