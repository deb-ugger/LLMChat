import { useEffect, useState } from "react";
import { gameImageDigest } from "./gameImageCheckpoints";
import { gameImageExportApi, type GameImageConfirmationBox, type GameImageConfirmationInput } from "./gameImageExport";
import type { UnityImage, UnityImageRegion } from "./unityOffline";

type Rect = GameImageConfirmationBox["rect"];
type Role = GameImageConfirmationBox["role"];
type CandidateMetadata = Omit<GameImageConfirmationInput, "gamePath" | "imageId" | "sourceHash" | "candidateVersion" | "pngSha256">;

export const reconfirmGameImage = "确认记录来自旧版本，或源文件、框选已变化。请重新生成或采用候选后确认。";

export function supportsGameImageConfirmation(image: UnityImage) {
  return (image.kind === "RPG PNG" || image.kind === "WOLF PNG") && !("archive" in image);
}

export function confirmationBoxes(image: UnityImage, role: Role, rectangles: readonly Rect[], round = false) {
  const start = round ? Math.round : Math.floor;
  const end = round ? Math.round : Math.ceil;
  const unique = new Map<string, Rect>();
  for (const [x0, y0, x1, y1] of rectangles) {
    const rect: Rect = [Math.max(0, start(x0)), Math.max(0, start(y0)), Math.min(image.width, end(x1)), Math.min(image.height, end(y1))];
    if (rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3]) unique.set(rect.join(","), rect);
  }
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])
    .map((rect, index): GameImageConfirmationBox => ({ id: role[0] + (index + 1), role, rect }));
}

export function renderedConfirmation(image: UnityImage, regions: readonly UnityImageRegion[], targetLanguage: string, round = false): CandidateMetadata {
  const boxes = confirmationBoxes(image, "translate", regions.filter(region => region.selected && region.translation.trim())
    .map(({ x0, y0, x1, y1 }) => [x0, y0, x1, y1]), round);
  return { layer: "translation", renderedKind: "generated", targetLanguage, maskMode: "boxes", boxes };
}

export function importedConfirmation(image: UnityImage): CandidateMetadata {
  return { layer: "translation", renderedKind: "imported", targetLanguage: image.renderedTarget ?? "", maskMode: "whole-image", boxes: [] };
}

export async function saveGameImageConfirmation(gamePath: string, image: UnityImage, blob: Blob, metadata: CandidateMetadata,
  candidateVersion?: string, signal?: AbortSignal) {
  if (!supportsGameImageConfirmation(image) || (metadata.maskMode === "boxes" && !metadata.boxes.length)) return;
  const pngSha256 = await gameImageDigest(await blob.arrayBuffer());
  signal?.throwIfAborted();
  try {
    await gameImageExportApi.confirm({ ...metadata, gamePath, imageId: image.id, sourceHash: image.sourceHash,
      candidateVersion: candidateVersion ?? pngSha256, pngSha256 }, signal);
  } catch (error) {
    // Archived WOLF resources keep their existing local workflow.
    if ((error as { code?: string })?.code !== "WOLF_ARCHIVE_ENTRY_UNSUPPORTED") throw error;
  }
}

export function useImageConfirmationNotice(gamePath: string, image: UnityImage | undefined,
  layer: CandidateMetadata["layer"], enabled: boolean) {
  const supported = !!image && supportsGameImageConfirmation(image);
  const imageId = image?.id;
  const sourceHash = image?.sourceHash;
  const renderedHash = image?.renderedHash;
  const [stale, setStale] = useState("");
  const key = JSON.stringify([gamePath, imageId, sourceHash, renderedHash, layer]);
  useEffect(() => {
    setStale("");
    if (!enabled || !imageId || !supported) return;
    const controller = new AbortController();
    void gameImageExportApi.confirmationStatus({ gamePath, imageId, layer }, controller.signal).then(result => {
      if (!controller.signal.aborted && result.state === "needsConfirmation") setStale(key);
    }).catch(() => { /* The confirmation status is independent of the preview request. */ });
    return () => controller.abort();
  }, [enabled, gamePath, imageId, key, layer, supported]);
  return enabled && stale === key ? reconfirmGameImage : "";
}
