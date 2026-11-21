import { gameModelExecution, measureGameAsync, measureGameWork } from "./gameModelPerformance";
import type { OllamaOutput } from "./gameOllama";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import type { Settings } from "./api";
import { requestGameModelJson } from "./gameModelRequest";
import { gameImageDigest, readImageCheckpoint, removeImageCheckpoint, saveImageCheckpoint } from "./gameImageCheckpoints";
import { gameJapaneseTextIssue } from "./gameDisplayText";
import { gameLetteringProof, mapGameOcrCrop, prepareGameOcrCrop, recognizeLocalGameImage } from "./gameImageRecognitionInput";
import { gameOcrMissingTile, isGameLogoName, prepareGameOcrSheet, renderPlacedGameImage, type GameImagePlacement } from "./gameImagePlacement";
import { correctGameLogoText, gameImageNameHint, gameLetteringCandidate, type ImageNameMemory } from "./gameImageNames";
import { TRANSLATION_PROMPT_LEAK, unityTranslationProblem, unityTranslationTokens } from "./unityTokens";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { renderUnityImage, UnityImageLayoutError } from "./unityImages";
import type { UnityImageRegion } from "./unityOffline";
import { IMAGE_PRESENCE_CONFLICT, IMAGE_PRESENCE_REVIEW_HINT, type ImagePresence } from "./gameImageScreening";

class InvalidImageRegions extends Error {}

export function gameImageTranslationProblem(source: string, translation: string, target = "") {
  const base = unityTranslationProblem(source, translation);
  if (base) return base;
  if (/\ufffd/.test(translation) && !/\ufffd/.test(source)) return "译文包含乱码，请重译此区域";
  const original = source.normalize("NFKC");
  const output = translation.normalize("NFKC");
  const prompts = /将图片中识别出的游戏文字从|保留全部格式占位符|仅返回译文,不要解释或代码围栏|\bTranslate from [\w-]+ to [\w-]+\b|\bOutput only the translation text\b|\btranslation_instructions\b/gi;
  if ([...output.matchAll(prompts)].some(([marker]) => !original.toLowerCase().includes(marker.toLowerCase()))) return TRANSLATION_PROMPT_LEAK;
  if (!target.startsWith("zh")) return "";
  const visible = output.replace(unityTranslationTokens(), "").trim();
  const roleMarkers = /(?:^|[^\p{Script=Latin}])(user|assistant|system)(?=[ \t]*(?:\r?\n|$))/giu;
  if ([...visible.matchAll(roleMarkers)].some(([, role]) => !original.toLowerCase().includes(role.toLowerCase()))) return TRANSLATION_PROMPT_LEAK;
  const residue = gameJapaneseTextIssue(source, translation, target);
  if (residue) return residue;
  if (/[\p{Script=Cyrillic}\p{Script=Greek}]{2,}/u.test(visible) && !/[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(original) ||
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(original) &&
      /\p{L}/u.test(visible) && !/\p{Script=Han}/u.test(visible) && !/^[A-Z]{1,5}(?:[0-9]+)?$/.test(visible)) {
    return "译文不像目标语言，请核对识字原文或重译此区域";
  }
  return "";
}

export function parseImagePresence(value: unknown): ImagePresence {
  if (!value || typeof value !== "object") throw new Error("复筛模型未返回文字存在判断");
  const result = value as Record<string, unknown>;
  if (typeof result.text_probability !== "number" || !Number.isFinite(result.text_probability) || result.text_probability < 0 || result.text_probability > 100) {
    throw new Error("复筛模型的文字存在概率无效");
  }
  if (result.text_probability === 0 && typeof result.text === "string" && result.text.trim()) throw new Error(`${IMAGE_PRESENCE_CONFLICT}。${IMAGE_PRESENCE_REVIEW_HINT}`);
  return { textProbability: result.text_probability };
}

export async function classifyGameImagePresence(settings: Settings, model: string, blob: Blob, signal: AbortSignal,
  selection: GamePromptSelection | undefined, variables: { source?: string; target?: string }, report: OllamaOutput | undefined, threshold = 50): Promise<ImagePresence> {
  const execution = gameModelExecution(selection, "refine", model);
  const bitmap = await measureGameAsync(execution, "processingMs", () => createImageBitmap(blob));
  try {
    const prompt = gameTaskPrompt("refine", selection, variables) +
      '\n输出只包含 text_probability 的 JSON 对象。以 0–100 的数值表示图片存在真实可读文字的概率：清楚看到文字接近 100，无法确定时填 50，确定没有文字时填 0。不输出文字证据、坐标或说明。';
    const classify = async (maxSide: number) => {
      signal.throwIfAborted();
      const image = measureGameWork(execution, "processingMs", () => {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      });
      const result = await requestGameModelJson(settings, model, prompt, signal, image, "game-images", report,
        { selection, role: "refine", imageClassification: true });
      return measureGameWork(execution, "processingMs", () => parseImagePresence(result));
    };
    const initial = await classify(1024);
    const certainty = Math.max(initial.textProbability, 100 - initial.textProbability);
    if (Math.max(bitmap.width, bitmap.height) <= 1024 || certainty >= Math.max(75, threshold)) return initial;
    return await classify(1600);
  } finally { bitmap.close(); }
}

export function parseGameImageRegions(value: unknown, width: number, height: number, onClipped?: (edges: string[]) => void): PaddleOcrLine[] {
  const rows: unknown = value && typeof value === "object" && "regions" in value ? value.regions : value;
  if (!Array.isArray(rows)) throw new InvalidImageRegions("识别模型未返回文字区域数组");
  const clipped: string[] = [];
  const lines = rows.map((line, index) => {
    const region = `第 ${index + 1} 个识别区域`;
    if (!line || typeof line.text !== "string" || !line.text.trim()) throw new InvalidImageRegions(`${region}缺少文字`);
    let clippedEdge = false;
    const number = (field: "x0" | "y0" | "x1" | "y1" | "confidence", max: number) => {
      const raw: unknown = line[field];
      const value = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      if (Number.isFinite(value) && value >= 0 && value <= max) return value;
      const start = field === "x0" || field === "y0";
      if (!clippedEdge && field !== "confidence" && Number.isFinite(value) && (start ? value < 0 : value > max)) {
        const boundary = start ? 0 : max;
        clippedEdge = true;
        clipped.push(`${region}坐标 ${field} 从 ${value} 裁到 ${boundary}`);
        return boundary;
      }
      const label = field === "confidence" ? "置信度" : `坐标 ${field}`;
      const received = raw === undefined ? "缺失" : typeof raw === "object" && raw !== null ? "非数值" : JSON.stringify(typeof raw === "string" ? raw.slice(0, 40) : raw);
      throw new InvalidImageRegions(`${region}${label}无效（返回 ${received}，应为 0–${max} 的数值）`);
    };
    const [left, top, right, bottom] = (["x0", "y0", "x1", "y1"] as const).map(field => number(field, 1000));
    const confidence = number("confidence", 100);
    const x0 = Math.min(left, right), x1 = Math.max(left, right);
    const y0 = Math.min(top, bottom), y1 = Math.max(top, bottom);
    if (x0 === x1 || y0 === y1) {
      throw new InvalidImageRegions(`${region}坐标无效（x0=${x0}，y0=${y0}，x1=${x1}，y1=${y1}，区域宽高必须大于 0）`);
    }
    return { text: line.text, confidence, x0: x0 * width / 1000, y0: y0 * height / 1000, x1: x1 * width / 1000, y1: y1 * height / 1000 };
  });
  if (clipped.length) onClipped?.(clipped);
  return lines;
}

// Join wrapped fields and clearly continuous CJK lines while keeping separate boxes intact.
export function mergeGameImageFieldLines<T extends PaddleOcrLine>(lines: T[], compatible?: (first: T, next: T) => boolean): T[] {
  const fieldStart = /^[^：:\r\n。！？]{1,24}[:：]/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const endsSentence = /[。！？!?…]$/u;
  const continuation = /^(?:的[\p{Script=Han}]|之[\p{Script=Han}]|[をがにでへともの][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[，、。！？])/u;
  const blocks: { box: T; tail: T }[] = [];
  for (const line of [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    let match: typeof blocks[number] | undefined;
    let minGap = Infinity;
    if (!fieldStart.test(line.text.trim()) && !/[\r\n]/.test(line.text)) {
      for (const block of blocks) {
        const { box, tail } = block;
        const previousText = tail.text.trim(), nextText = line.text.trim();
        if (/[\r\n]/.test(tail.text) || endsSentence.test(previousText) || compatible && !compatible(tail, line)) continue;
        const height = line.y1 - line.y0, previousHeight = tail.y1 - tail.y0;
        const gap = line.y0 - tail.y1;
        const overlap = Math.min(line.x1, tail.x1) - Math.max(line.x0, tail.x0);
        const narrower = Math.min(line.x1 - line.x0, tail.x1 - tail.x0);
        if (height < previousHeight * .7 || height > previousHeight * 1.4 || gap < -previousHeight * .15 || gap > previousHeight * .35 ||
            overlap < narrower * .75) continue;
        const leftAligned = Math.abs(line.x0 - tail.x0) <= previousHeight * .4;
        const centered = Math.abs(line.x0 + line.x1 - tail.x0 - tail.x1) <= previousHeight;
        const wrapsField = leftAligned && fieldStart.test(box.text.trim());
        const continuesSentence = (leftAligned || centered) && cjk.test(previousText) && cjk.test(nextText) &&
          [...previousText].length >= 4 && continuation.test(nextText);
        if (!wrapsField && !continuesSentence) continue;
        if (Math.abs(gap) < minGap) { match = block; minGap = Math.abs(gap); }
      }
    }
    if (!match) { blocks.push({ box: line, tail: line }); continue; }
    const previous = match.box.text.trimEnd(), following = line.text.trimStart();
    const separator = cjk.test(previous.at(-1) || "") && (cjk.test(following[0] || "") || /^[，、。！？]/u.test(following)) ? "" : " ";
    match.box = { ...match.box, text: previous + separator + following, confidence: Math.min(match.box.confidence, line.confidence),
      x0: Math.min(match.box.x0, line.x0), y0: Math.min(match.box.y0, line.y0),
      x1: Math.max(match.box.x1, line.x1), y1: Math.max(match.box.y1, line.y1) };
    match.tail = line;
  }
  return blocks.map(block => block.box);
}

/** Coordinates are normalized to 0–1000 so resized model input retains original pixel bounds. */
export async function recognizeGameImage(settings: Settings, model: string, blob: Blob, signal: AbortSignal, scene: "screen" | "refine" | "recognize" = "recognize", selection?: GamePromptSelection, variables?:GameImagePlacement & {source?:string;target?:string;names?:ImageNameMemory}, report?: OllamaOutput, fallback?: (blob: Blob) => Promise<PaddleOcrLine[]>): Promise<PaddleOcrLine[]> {
  const execution = gameModelExecution(selection, scene, model);
  const bitmap = await measureGameAsync(execution, "processingMs", () => createImageBitmap(blob));
  try {
    const { canvas, crop } = measureGameWork(execution, "processingMs", () => {
      const enhanced = scene === "recognize" ? prepareGameOcrCrop(bitmap) : undefined;
      if (enhanced) return enhanced;
      const canvas = document.createElement("canvas"), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { canvas, crop: undefined };
    });
    const logo = scene === "recognize" && isGameLogoName(variables?.assetName);
    const nameHint = scene === "recognize" ? gameImageNameHint(variables?.names,logo) : "";
    let emptyGroupCheckpoint: string | undefined;
    if (scene === "recognize" && !logo && (crop || variables?.cleanBase) && variables?.assetName) {
      const started = performance.now();
      let groupingPrepared = false;
      try {
        const sheet = await prepareGameOcrSheet(blob, variables, signal);
        if (sheet?.image && sheet.regions.length) {
          const mode = sheet.kind === "annotated" ? "对照无批注底图定位正文" : "透明花字分组旋平";
          report?.(`识字 · ${mode} · ${sheet.regions.length} 组`, "info");
          const groupPrompt = '抄录图中每个编号下方的原文。编号是定位标记，不能写进原文。保留同组文字的换行和句尾，箭头、爱心轮廓等独立装饰不抄成文字。不确定的字不要猜。只返回 {"regions":[{"index":1,"text":"原文","confidence":90}]}，每个编号至多一项，confidence 用 0–100 的百分数。' + nameHint;
          const key = await gameImageDigest(new TextEncoder().encode(JSON.stringify(["group-ocr-v1", model, sheet.kind, groupPrompt, sheet.image, sheet.regions])));
          const saved = await readImageCheckpoint("ocr", key);
          signal.throwIfAborted();
          const mapped = new Map<number, PaddleOcrLine>(saved?.lines);
          const checked = new Set(saved?.checked);
          const save = () => saveImageCheckpoint("ocr", key, { lines: [...mapped], checked: [...checked] });
          const readRows = (value: unknown, onlyIndex?: number) => {
            const rows = Array.isArray(value) ? value : value && typeof value === "object" && "regions" in value && Array.isArray(value.regions) ? value.regions : undefined;
            if (!rows) throw new Error("分组识字未返回有效的区域数组");
            let matched = false;
            for (const row of rows) {
              const index = Number(row?.index) - 1;
              const region = sheet.regions[index];
              if (!region || (onlyIndex !== undefined && onlyIndex !== index) || typeof row.text !== "string" || !row.text.trim()) continue;
              const rawConfidence = Number(row.confidence);
              const confidence = rawConfidence > 0 && rawConfidence < 1 ? rawConfidence * 100 : rawConfidence;
              if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
              matched = true;
              if (confidence <= (mapped.get(index)?.confidence ?? -1)) continue;
              const [x0, y0, x1, y1] = region.box;
              mapped.set(index, { text: row.text.trim(), confidence, x0, y0, x1, y1 });
            }
            if (onlyIndex !== undefined && rows.length > 0 && !matched) throw new Error("局部识字返回的编号或内容无效");
          };
          if (!saved) {
            const raw = await requestGameModelJson(settings, model, groupPrompt, signal, "data:image/png;base64," + sheet.image,
              "game-images", report, { selection, role: scene, groupedImageOcr: true });
            readRows(raw);
            for (const [index, line] of mapped) if (line.confidence >= 50) checked.add(index);
            await save();
          }
          groupingPrepared = true;
          const failed: number[] = [];
          let firstError = "";
          for (const index of sheet.regions.keys()) {
            signal.throwIfAborted();
            if (checked.has(index)) continue;
            try {
              const tile = await gameOcrMissingTile(sheet, index);
              if (!tile) throw new Error("未能读取分组裁区");
              const recovered = await requestGameModelJson(settings, model,
                `只抄录编号 ${index + 1} 下的实际文字，保留原文和符号，辨认不清时返回空数组。JSON {"regions":[{"index":${index + 1},"text":"原文","confidence":90}]}。` + nameHint,
                signal, tile, "game-images", report, { selection, role: scene, groupedImageOcr: true });
              readRows(recovered, index);
              checked.add(index);
              await save();
            } catch (error) {
              signal.throwIfAborted();
              failed.push(index + 1);
              firstError ||= error instanceof Error ? error.message : String(error);
            }
          }
          if (failed.length) throw new Error(`分组 ${failed.join("、")} 补读失败：${firstError}`);
          if (mapped.size || sheet.contextImage) {
            const ordered = [...mapped.entries()].sort(([a],[b]) => a-b);
            const found = ordered.map(([,region]) => region);
            if (sheet.kind === "lettering") {
              const checks=ordered.flatMap(([index,region])=>{
                const candidate=gameLetteringCandidate(region.text,variables.names);
                return candidate ? [{region,index,...candidate}] : [];
              }).slice(0,2);
              for (const {region,index,word,candidate} of checks) {
                try {
                  const checked=await requestGameModelJson(settings,model,
                    '画像は同じ日本語の装飾文字を異なる方法で表示したものです。文字の形を見て判断してください。初回候補は「'+word+'」、作品内に実在する類似表記は「'+candidate+'」です。小さい濁点も確認し、画像に最も合う表記を選択してください。どちらでもない場合、初回表記を保留してください。JSON {"regions":[{"index":1,"text":"選んだ原文","confidence":95}]} だけ返してください。',
                    signal,gameLetteringProof(bitmap,region,sheet.regions[index].angle),"game-images",report,{selection,role:scene,groupedImageOcr:true});
                  const rows=Array.isArray(checked) ? checked : checked && typeof checked==="object" && "regions" in checked && Array.isArray(checked.regions) ? checked.regions : [];
                  const corrected=typeof rows[0]?.text==="string" && rows[0].text.trim().replace(/[♡♥❤。！!]+$/u,"")===candidate;
                  if (corrected) {
                    region.text=region.text.replace(word,candidate);
                    report?.("花字复读 · 已确认工程中已有的写法", "info");
                  }
                } catch (error) {
                  signal.throwIfAborted();
                  report?.("花字局部复读失败，已保留首次结果","info");
                }
              }
            }
            let labels: PaddleOcrLine[] = [];
            if (sheet.contextImage) {
              const labelResult = await requestGameModelJson(settings, model,
                '只抄录画面上的原始页标题、按钮名及短界面标签。图案、图标和空白按钮不要猜作文字。英文照抄。每个短标签单独画框。只返回 {"regions":[{"text":"原文","confidence":90,"x0":0,"y0":0,"x1":100,"y1":100}]}，横纵坐标分别按0–1000归一化。' + nameHint,
                signal, "data:image/png;base64," + sheet.contextImage, "game-images", report, { selection, role: scene });
              labels = parseGameImageRegions(labelResult,bitmap.width,bitmap.height);
              const heading = labels.find(row => /^[A-Z][A-Z '-]{7,}$/.test(row.text) && row.x1 - row.x0 >= 150);
              if (heading) {
                try {
                  const previous = heading.text;
                  const bytes = Uint8Array.from(atob(sheet.contextImage), char => char.charCodeAt(0));
                  const clean = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
                  const height = heading.y1 - heading.y0;
                  const x0 = Math.max(0, Math.floor(heading.x0 - height * .35));
                  const y0 = Math.max(0, Math.floor(heading.y0 - height * .3));
                  const x1 = Math.min(clean.width, Math.ceil(heading.x1 + height * .85));
                  const y1 = Math.min(clean.height, Math.ceil(heading.y1 + height * .35));
                  const focused = document.createElement("canvas");
                  const zoom = Math.min(2, 1200 / (x1 - x0));
                  focused.width = Math.ceil((x1 - x0) * zoom);
                  focused.height = Math.ceil((y1 - y0) * zoom);
                  focused.getContext("2d")!.drawImage(clean, x0, y0, x1-x0, y1-y0, 0, 0, focused.width, focused.height);
                  clean.close();
                  const reread = await requestGameModelJson(settings, model,
                    'Transcribe the large stylized English heading exactly, one printed letter at a time. Return only {"regions":[{"index":1,"text":"printed heading","confidence":95}]}.',
                    signal, focused.toDataURL("image/png"), "game-images", report, { selection, role: scene, groupedImageOcr: true });
                  const rows = Array.isArray(reread) ? reread : reread && typeof reread === "object" && "regions" in reread && Array.isArray(reread.regions) ? reread.regions : [];
                  const revised = typeof rows[0]?.text === "string" ? rows[0].text.trim() : "";
                  if (/^[A-Z][A-Z '-]{7,}$/.test(revised)) {
                    heading.text = revised;
                    if (revised !== previous) report?.("底图英文标题已局部复读", "info");
                  }
                } catch (error) {
                  signal.throwIfAborted();
                  report?.("底图英文标题局部复读失败，已保留首次结果", "info");
                }
              }
              if (!labels.length) report?.("未在底图识别到独立界面文字", "info");
              else report?.(`无批注底图 · 另识别 ${labels.length} 个标题或标签`, "info");
            }
            await removeImageCheckpoint("ocr", key);
            report?.(`识字完成 · ${model} · 已读 ${mapped.size}/${sheet.regions.length} 组 · ${((performance.now()-started)/1000).toFixed(2)} 秒`, "info");
            return [...found,...labels];
          }
          report?.("分组裁区未读出文字，改用整图核对", "info");
          emptyGroupCheckpoint = key;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (groupingPrepared) throw error;
        report?.(`分组识别失败，改用整图识别 · ${String(error)}`, "info");
      }
    }
    const image = measureGameWork(execution, "processingMs", () => canvas.toDataURL("image/png"));
    const prompt = gameTaskPrompt(scene, selection, variables) + '\n识别图片全部可读文字及位置，不翻译、不推测。仅返回包含 regions 数组的 JSON 对象。每项的 text 是原文字符串，confidence、x0、y0、x1、y1 是数值。坐标以收到的图片左上角为原点，横纵均归一化至0–1000，必须满足 0<=x0<x1<=1000、0<=y0<y1<=1000。confidence 必须为0–100的数值，不带百分号。无文字返回 {"regions":[]}，不要输出说明。' + (scene === "recognize" ? "同一段落或同一标签的内容因排版换行时，用一个区域包住整段，合成完整原文。不同列、独立标题或下一个带标签的字段分别返回。" : "");
    const recognize = async (instruction: string) => {
      const value = await requestGameModelJson(settings, model, instruction, signal, image, "game-images", report, { selection, role: scene });
      const recognized = measureGameWork(execution, "processingMs", () => {
        const lines = parseGameImageRegions(value, crop ? canvas.width : bitmap.width, crop ? canvas.height : bitmap.height, edges => {
          const detail = edges.length === 1 ? edges[0] : `已裁正 ${edges.length} 个越界坐标（${edges[0]}）`;
          report?.(`${model} · ${detail}。已保留识别结果。`, "error");
        });
        const original = crop ? mapGameOcrCrop(lines, crop, canvas.width, canvas.height) : lines;
        return logo ? original.map(region => ({ ...region, text: correctGameLogoText(region.text,variables?.names) }))
          : scene === "recognize" ? mergeGameImageFieldLines(original) : original;
      });
      if (emptyGroupCheckpoint) await removeImageCheckpoint("ocr", emptyGroupCheckpoint);
      return recognized;
    };
    const instruction = logo
      ? prompt + "\n每段不同颜色、字号或位置的标题字给自己的紧框。独立的拉丁缩写及 & 也分别给框，禁止把彼此错行的字排成一个大框。坐标只包住这一组实际笔画。" + nameHint
      : scene === "recognize"
      ? prompt + "\n斜排、弧形或竖排的连续文字按阅读顺序抄成一个区域，不要逐字分框；不能辨认的笔画或装饰不要猜成假名。置信度按该区域字形是否清楚分别估计。" + nameHint
      : prompt;
    try { return await recognize(instruction); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof InvalidImageRegions)) throw error;
      report?.(`${model} · ${error.message}。正在重新识别一次。`, "error");
      return await recognize(instruction + '\n上次输出未通过校验：' + error.message + '。请重新检查所有区域的坐标范围、非零宽高和置信度，返回完整结果。');
    }
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as { code?: string; outputTokenLimit?: number; completionTokens?: number; promptTokens?: number } | null;
    const code = failure?.code;
    const truncated = code === "LLM_OUTPUT_TRUNCATED";
    const contextLimited = code === "OLLAMA_CONTEXT_LIMIT";
    const limit = failure?.outputTokenLimit;
    const tokens = failure?.completionTokens;
    const input = failure?.promptTokens;
    const limitLabel = limit === undefined ? "未记录" : limit > 0 ? `${limit} token` : "未指定，使用服务设置";
    const usage = tokens !== undefined && tokens > 0 ? input !== undefined && input > 0
      ? `，输入 ${input} + 输出 ${tokens} = ${input + tokens} token` : `，服务报告已生成 ${tokens} token` : "";
    const message = error instanceof Error ? error.message : String(error);
    const reason = truncated && !message.startsWith("Ollama") ? `视觉识字输出被截断（请求输出上限 ${limitLabel}${usage}）` : message;
    if (!fallback || !(error instanceof InvalidImageRegions || code === "GAME_MODEL_INVALID_JSON" || truncated || contextLimited || code === "LLM_NO_FINAL_ANSWER")) {
      if (reason !== message) throw Object.assign(new Error(reason, { cause: error }), { code });
      throw error;
    }
    report?.(`${model} · ${reason.replace(/。$/, "")}。软件已自动启动本地 OCR。`, "error");
    try {
      const lines = await measureGameAsync(execution, "processingMs", () => scene === "recognize" ? recognizeLocalGameImage(blob, fallback, signal) : fallback(blob));
      signal.throwIfAborted();
      const regions = scene === "recognize" ? mergeGameImageFieldLines(lines) : lines;
      report?.(`本地 OCR 已完成，${regions.length ? `得到 ${regions.length} 个文字区域` : "未识别到文字"}。`, "success");
      return regions;
    } catch (fallbackError) {
      signal.throwIfAborted();
      throw Object.assign(new Error(reason.replace(/。$/, "") + "；本地 OCR 也未完成：" +
        (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)), { cause: fallbackError }), { code });
    }
  } finally { bitmap.close(); }
}

export async function renderGameImage(settings: Settings, model: string, blob: Blob, regions: UnityImageRegion[], signal: AbortSignal, selection?: GamePromptSelection, variables?:{source?:string;target?:string}, report?: OllamaOutput, placement?: GameImagePlacement) {
  const failures = regions.flatMap((region, index) => {
    if (!region.selected) return [];
    const message = gameImageTranslationProblem(region.text, region.translation, variables?.target);
    return message ? [{ index, message }] : [];
  });
  if (failures.length) throw new UnityImageLayoutError(failures);
  const execution = gameModelExecution(selection, "layout", model);
  const render = (values: UnityImageRegion[]) => measureGameAsync(execution, "processingMs", async () => {
    if (placement) {
      const image = await renderPlacedGameImage(blob, values, placement, signal, report);
      if (image) return image;
      report?.("未检测到本地重绘环境，使用原位嵌字", "info");
    }
    return renderUnityImage(blob, values);
  });
  if (!model) return render(regions);
  const segmenter = new Intl.Segmenter(variables?.target, { granularity: "word" });
  const selected = regions.flatMap((region, index) => {
    if (!region.selected) return [];
    const chunks = Array.from(segmenter.segment(region.translation), item => item.segment);
    return chunks.length < 2 ? [] : [{ index, width: region.x1 - region.x0, height: region.y1 - region.y0, chunks }];
  });
  if (!selected.length) return render(regions);
  const prompt = gameTaskPrompt("layout", selection, variables) +
    '\n只选择断行位置。chunks 是依序排列的原译文片段，编号从 1 开始。breakAfter 填要在其后换行的片段编号，不能填最后一段。原译文中已有的换行会保留。返回 {"regions":[{"index":原区域索引,"breakAfter":[编号]}]}，每个区域一项，无需新增换行时填空数组。只返回编号和 JSON，不抄写译文。\n' +
    JSON.stringify(selected);
  let result: unknown;
  try {
    result = await requestGameModelJson(settings, model, prompt, signal, undefined, "game-images", report, { selection, role: "layout" });
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as { code?: string } | null)?.code;
    if (code !== "GAME_MODEL_INVALID_JSON" && code !== "LLM_OUTPUT_TRUNCATED" && code !== "OLLAMA_CONTEXT_LIMIT" && code !== "LLM_NO_FINAL_ANSWER") throw error;
    report?.(`${model} · ${error instanceof Error ? error.message : String(error)}。本图自动换行。`, "error");
    return render(regions);
  }
  signal.throwIfAborted();
  const rows = result && typeof result === "object" && "regions" in result && Array.isArray(result.regions) ? result.regions : [];
  const layouts = new Map<number, string>();
  const seen = new Set<number>();
  const byIndex = new Map(selected.map(region => [region.index, region.chunks]));
  for (const item of rows) {
    const chunks = byIndex.get(item?.index);
    if (!chunks) continue;
    if (seen.has(item.index)) { layouts.delete(item.index); continue; }
    seen.add(item.index);
    if (!Array.isArray(item.breakAfter) || !item.breakAfter.every((position: unknown) =>
      typeof position === "number" && Number.isInteger(position) && position > 0 && position < chunks.length)) continue;
    const breaks = new Set<number>(item.breakAfter);
    layouts.set(item.index, chunks.map((chunk, index) => breaks.has(index + 1) && !/[\r\n]/.test(chunk + (chunks[index + 1] ?? "")) ? chunk + "\n" : chunk).join(""));
  }
  if (layouts.size < selected.length) {
    report?.(`${model} · ${selected.length - layouts.size} 个区域未收到有效断点，已改为自动换行。`, "error");
  }
  const planned = regions.map((region, index) => ({ ...region, translation: layouts.get(index) ?? region.translation }));
  try { return await render(planned); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof UnityImageLayoutError)) throw error;
    const retry = new Set(error.failures.map(item => item.index).filter(index => planned[index].translation !== regions[index].translation));
    if (!retry.size) throw error;
    report?.(`${model} · ${retry.size} 个区域的断点超出排版空间，正在自动换行。`, "error");
    return render(planned.map((region, index) => retry.has(index) ? regions[index] : region));
  }
}
