import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MosaicBox } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import type { MosaicTruth } from "./mosaicScoreInputs";

export type ImageBenchmarkInput = {
  id: string; file: string; width: number; height: number; sourceHash: string;
  category: string; checked: boolean; boxes?: MosaicBox[];
  mosaicTruth?: MosaicTruth | null;
};
export type ImageBenchmarkOutcome = {
  category: string; boxes?: MosaicBox[]; checked?: boolean; reason?: string;
  status?: "完成" | "失败" | "跳过";
  regions?: { box: MosaicBox; text: string; translation?: string; reason?: string }[];
};
export type RecordImageBenchmarkOutcome = (id: string, outcome: ImageBenchmarkOutcome) => void;
export type ImageBenchmarkDetails = { samples: ImageBenchmarkInput[]; results: Record<string, ImageBenchmarkOutcome> };

const imageCategories = { candidate: "待正式识别", review: "待复核", "no-text": "未检测到文字", "not-needed": "无需翻译", failed: "识别失败" };

export function benchmarkImageInput(image: UnityImage, category?: string, checked = image.selected, boxes?: MosaicBox[]): ImageBenchmarkInput {
  const { id, file, width, height, sourceHash } = image;
  return { id, file, width, height, sourceHash, checked, boxes,
    category: category ?? (image.screening ? imageCategories[image.screening.state] : image.ocrCompleted ? "已识别" : "待筛选") };
}

export function imageScreenOutcome(image: UnityImage): ImageBenchmarkOutcome {
  const screening = image.screening;
  return { category: benchmarkImageInput(image).category, checked: image.selected,
    boxes: screening?.recognition?.lines.map(line => [line.x0,line.y0,line.x1,line.y1]),
    reason: image.error || screening?.sourceSkip || screening?.reason,
    status: screening?.state === "failed" || screening?.refineFailed || image.error ? "失败" : screening?.sourceSkip || screening?.state === "not-needed" ? "跳过" : "完成" };
}

export async function saveImageBenchmarkDetails(queueId: string, runId: string, samples: readonly ImageBenchmarkInput[] | undefined,
  results: Record<string, ImageBenchmarkOutcome>) {
  if (isTauri()) return invoke("write_game_benchmark_image_details", { queueId, runId, samples, results });
  const key = "llmchat-benchmark-images:" + queueId;
  if (samples) localStorage.setItem(key,JSON.stringify(samples));
  localStorage.setItem(key + ":" + runId, JSON.stringify(results));
}

export async function readImageBenchmarkDetails(queueId: string, runId: string): Promise<ImageBenchmarkDetails> {
  if (isTauri()) return invoke("read_game_benchmark_image_details",{queueId,runId});
  const key = "llmchat-benchmark-images:" + queueId;
  const samples = localStorage.getItem(key);
  const results = localStorage.getItem(key + ":" + runId);
  if (!samples || !results) throw new Error("找不到本轮逐图结果");
  return { samples: JSON.parse(samples), results: JSON.parse(results) };
}
