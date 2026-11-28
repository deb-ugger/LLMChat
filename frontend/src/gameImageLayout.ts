import type { UnityImageRegion } from "./unityOffline";

export type ImageLayoutRegion = {
  index: number; width: number; height: number; source: string; fontSize: number; maxLines: number; chunks: string[];
};

export const GAME_IMAGE_LAYOUT_PROMPT = "为游戏译文选择自然断行。保留全部文字、标点和片段顺序。参考原文行数与字号，横向短按钮、标签和标题优先单行；正文各行尽量均衡。姓名、技能名、数字与单位保持整体。不要在行首放结束标点，或在行尾放开始标点。空间不足时不能删改译文。";

export function imageLayoutRegions(regions: UnityImageRegion[], target?: string): ImageLayoutRegion[] {
  const segmenter = new Intl.Segmenter(target, { granularity: "word" });
  return regions.flatMap((region, index) => {
    if (!region.selected) return [];
    const chunks = Array.from(segmenter.segment(region.translation), item => item.segment);
    const width = region.x1 - region.x0, height = region.y1 - region.y0;
    const sourceLines = Math.max(1, region.text.split(/\r\n|\r|\n/).length);
    const fontSize = Math.max(1, Math.round(height / sourceLines));
    const maxLines = Math.max(1, Math.floor(height / (fontSize * .75)));
    if (chunks.length < 2 || maxLines === 1) return [];
    return [{ index, width, height, source: region.text, fontSize, maxLines, chunks }];
  });
}

export function imageLayoutPrompt(regions: ImageLayoutRegion[], preset = "") {
  return [preset, GAME_IMAGE_LAYOUT_PROMPT,
    'chunks 中每项的 id 是片段编号。只有真正要拆成下一行时，才在 breakAfter 填该片段的 id，不能标记句末。必须严格递增，不能包含最后一项。已有换行保留。只返回 {"regions":[{"index":原区域索引,"breakAfter":[片段id]}]}，每个区域恰好一项。',
    '示例：index=99，chunks=[{"id":1,"text":"攻击力"},{"id":2,"text":"提高"}]。单行输出 {"index":99,"breakAfter":[]}；分成两行输出 {"index":99,"breakAfter":[1]}。填写 [2] 是错误的，因为句末没有下一行。不要照抄示例 index。',
    JSON.stringify(regions.map(region => ({ ...region, chunks: region.chunks.map((text, index) => ({ id: index + 1, text })) })))].filter(Boolean).join("\n");
}

export function imageLayoutText(chunks: string[], breakAfter: unknown): string | undefined {
  if (!Array.isArray(breakAfter) || !breakAfter.every((position, index) =>
    Number.isInteger(position) && position > 0 && position < chunks.length &&
    (index === 0 || position > breakAfter[index - 1]) &&
    !/[(（[【「『]$/u.test(chunks[position - 1].trimEnd()) &&
    !/^[，。！？、：；,.!?;:）)\]】」』]/u.test(chunks[position].trimStart()))) return;
  const breaks = new Set<number>(breakAfter);
  return chunks.map((chunk, index) => breaks.has(index + 1) &&
    !/[\r\n]/.test(chunk + (chunks[index + 1] ?? "")) ? chunk + "\n" : chunk).join("");
}
