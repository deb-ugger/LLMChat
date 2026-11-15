export type GamePatchWorkflow = { textSkipped: boolean; imagesSkipped: boolean };
export function gamePatchCanGenerate(text: { sourcePath: string; selected: number; done: number; changed: number }, images: { complete: boolean }, supportsImages: boolean, workflow: GamePatchWorkflow) {
  return !!text.sourcePath && text.changed > 0 && (text.done === text.selected || workflow.textSkipped) && (!supportsImages || images.complete || workflow.imagesSkipped);
}
