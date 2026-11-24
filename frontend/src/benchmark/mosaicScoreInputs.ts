import { sha256Hex } from "../fileFingerprint";
import type { MosaicBox } from "../gameMosaic";
import type { ImageBenchmarkInput } from "./imageBenchmarkHistory";
import type { AnnotatedSampleSet } from "./imageSampleSet";

export type MosaicTruth = {
  state: "present" | "none" | "uncertain";
  boxes?: MosaicBox[];
  boxCoverage?: "complete" | "partial";
  partialBoxes?: boolean;
};

export type MosaicScoreFreeze = { version: 1; inputs: string; truth: string };
export const mosaicWallClock = "whole-wall-v1";

export function orderedMosaicBoxes(boxes: readonly MosaicBox[] = []) {
  return boxes.map(box => [...box] as MosaicBox).sort(([ax, ay, ar, ab], [bx, by, br, bb]) =>
    ax - bx || ay - by || ar - br || ab - bb);
}

export function mosaicBoxCoverage(truth: MosaicTruth) {
  return truth.boxCoverage ?? (truth.partialBoxes === true ? "partial" : "unknown");
}

function canonicalMosaicTruth(truth: MosaicTruth): MosaicTruth {
  const coverage = mosaicBoxCoverage(truth);
  return { state: truth.state, boxes: orderedMosaicBoxes(truth.boxes), boxCoverage: coverage === "unknown" ? undefined : coverage };
}

export function mosaicTruthLookup(dataset?: AnnotatedSampleSet) {
  const byHash = new Map(dataset?.images.map(image => [image.sourceHash, image]));
  const byProject = new Map(dataset?.images.filter(image => image.projectImageId && image.projectSourceHash)
    .map(image => [image.projectImageId + "\0" + image.projectSourceHash, image]));
  return (sample: ImageBenchmarkInput): MosaicTruth | null => {
    const image = byHash.get(sample.sourceHash) ?? byProject.get(sample.id + "\0" + sample.sourceHash);
    if (!image) return null;
    if (image.width !== sample.width || image.height !== sample.height) throw new Error("标注样本尺寸与归档不一致：" + sample.file);
    const truth = image.annotation.mosaic;
    return truth ? canonicalMosaicTruth(truth) : null;
  };
}

const digest = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)).buffer);

export async function freezeMosaicInputs(samples: readonly ImageBenchmarkInput[]) {
  const originals = new Map<string, string>();
  const inputs = [], truths = [];
  for (const sample of samples) {
    const seed = [sample.width, sample.height, sample.category, sample.checked, orderedMosaicBoxes(sample.boxes)];
    // Preserve the v1 field order used when freezing, even after native JSON round trips.
    const truth = sample.mosaicTruth ? canonicalMosaicTruth(sample.mosaicTruth) : sample.mosaicTruth;
    const manifest = JSON.stringify([seed, truth]);
    const previous = originals.get(sample.sourceHash);
    if (previous !== undefined && previous !== manifest) throw new Error("同一原图的标注或初筛种子冲突：" + sample.file);
    originals.set(sample.sourceHash, manifest);
    inputs.push([sample.id, sample.sourceHash, seed]);
    truths.push([sample.sourceHash, truth]);
  }
  const [inputHash, truthHash] = await Promise.all([digest(inputs), digest(truths)]);
  return { version: 1, inputs: inputHash, truth: truthHash } satisfies MosaicScoreFreeze;
}
