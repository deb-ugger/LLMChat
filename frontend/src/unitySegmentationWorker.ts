import * as ort from "onnxruntime-web";
import { predictWtpBoundaries, wtpHashes } from "./wtpSegmentation.mjs";

async function load(base: string) {
  const asset = (name: string) => new URL(name, base).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: asset("manga-ort/ort-wasm-simd-threaded.asyncify.mjs"), wasm: asset("manga-ort/ort-wasm-simd-threaded.asyncify.wasm") };
  const response = await fetch(asset("wtp/model.onnx"));
  if (!response.ok) throw new Error(`多语言分段模型读取失败（${response.status}）`);
  return ort.InferenceSession.create(await response.arrayBuffer(), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
}
let runtime: ReturnType<typeof load> | undefined;

self.onmessage = async (event: MessageEvent<{ id: number; text: string; base: string }>) => {
  const { id, text, base } = event.data;
  try {
    runtime ??= load(base);
    const session = await runtime;
    const ends = await predictWtpBoundaries(text, async part => {
      const length = Array.from(part).length;
      const ids = new ort.Tensor("int64", wtpHashes(part), [1, length, 8]);
      const mask = new ort.Tensor("float32", new Float32Array(length).fill(1), [1, length]);
      try {
        const output = await session.run({ hashed_ids: ids, attention_mask: mask });
        try {
          const logits = output.logits;
          if (logits.dims[1] !== length || logits.dims[2] !== 127) throw new Error("多语言分段模型输出格式不匹配");
          return Array.from({ length }, (_, i) => Number(logits.data[i * 127]));
        } finally { for (const tensor of Object.values(output)) tensor.dispose(); }
      } finally { ids.dispose(); mask.dispose(); }
    });
    self.postMessage({ id, ends });
  } catch (error) { self.postMessage({ id, error: `本地多语言分段失败：${error instanceof Error ? error.message : String(error)}` }); }
};
