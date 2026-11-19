import type { PaddleOcrLine } from "./ocr/paddleOcr";

type Crop = { left: number; top: number; width: number; height: number };

export function gameOcrAlphaContent(pixels: Uint8ClampedArray, width: number, height: number) {
  const total = width * height;
  let left = width, top = height, right = 0, bottom = 0, visible = 0, brightness = 0, weight = 0;
  for (let index = 0; index < total; index++) {
    const offset = index * 4, alpha = pixels[offset + 3];
    if (alpha < 12) continue;
    if (++visible > total * .3) return undefined;
    const x = index % width, y = Math.floor(index / width);
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    brightness += alpha * (.2126 * pixels[offset] + .7152 * pixels[offset + 1] + .0722 * pixels[offset + 2]);
    weight += alpha;
  }
  if (!visible || (right - left) * (bottom - top) > total * .7) return undefined;
  return { left, top, right, bottom, background: brightness / weight >= 110 ? "#222222" : "#f6f6f6" };
}

export function prepareGameOcrCrop(bitmap: ImageBitmap) {
  const sample = document.createElement("canvas");
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  sample.width = Math.max(1, Math.round(bitmap.width * scale));
  sample.height = Math.max(1, Math.round(bitmap.height * scale));
  const analysis = sample.getContext("2d", { willReadFrequently: true })!;
  analysis.drawImage(bitmap, 0, 0, sample.width, sample.height);
  const content = gameOcrAlphaContent(analysis.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
  if (!content) return undefined;

  const scaleX = bitmap.width / sample.width, scaleY = bitmap.height / sample.height;
  const padding = Math.ceil(8 * Math.max(scaleX, scaleY));
  const left = Math.max(0, Math.floor(content.left * scaleX) - padding);
  const top = Math.max(0, Math.floor(content.top * scaleY) - padding);
  const right = Math.min(bitmap.width, Math.ceil(content.right * scaleX) + padding);
  const bottom = Math.min(bitmap.height, Math.ceil(content.bottom * scaleY) + padding);
  const crop: Crop = { left, top, width: right - left, height: bottom - top };
  const zoom = Math.min(3, 1600 / Math.max(crop.width, crop.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * zoom));
  canvas.height = Math.max(1, Math.round(crop.height * zoom));
  const context = canvas.getContext("2d", { alpha: false })!;
  context.fillStyle = content.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return { canvas, crop };
}

export function mapGameOcrCrop<T extends PaddleOcrLine>(lines: T[], crop: Crop, width: number, height: number): T[] {
  const x = (value: number) => crop.left + Math.max(0, Math.min(width, value)) * crop.width / width;
  const y = (value: number) => crop.top + Math.max(0, Math.min(height, value)) * crop.height / height;
  return lines.map(line => ({ ...line, x0: x(line.x0), x1: x(line.x1), y0: y(line.y0), y1: y(line.y1) }))
    .filter(line => line.x1 > line.x0 && line.y1 > line.y0);
}

export function gameLetteringProof(bitmap: ImageBitmap, box: PaddleOcrLine, angle: number) {
  const x=Math.max(0,Math.floor(box.x0)-5), y=Math.max(0,Math.floor(box.y0)-5);
  const width=Math.min(bitmap.width,Math.ceil(box.x1)+5)-x, height=Math.min(bitmap.height,Math.ceil(box.y1)+5)-y;
  const scale=Math.min(4,590/Math.max(width,height));
  const crop=document.createElement("canvas");
  crop.width=Math.ceil(width*scale); crop.height=Math.ceil(height*scale);
  const ink=crop.getContext("2d")!;
  ink.imageSmoothingEnabled=false;
  ink.drawImage(bitmap,x,y,width,height,0,0,crop.width,crop.height);

  const radians=angle*Math.PI/180, cosine=Math.abs(Math.cos(radians)), sine=Math.abs(Math.sin(radians));
  const rotatedWidth=Math.ceil(crop.width*cosine+crop.height*sine);
  const rotatedHeight=Math.ceil(crop.height*cosine+crop.width*sine);
  const sheet=document.createElement("canvas");
  sheet.width=Math.max(crop.width,rotatedWidth)+16; sheet.height=2*crop.height+rotatedHeight+48;
  const ctx=sheet.getContext("2d")!;
  ctx.fillStyle="white"; ctx.fillRect(0,0,sheet.width,sheet.height);
  ctx.fillStyle="#e7e8ee"; ctx.fillRect(8,8,crop.width,crop.height);
  ctx.drawImage(crop,8,8);
  ctx.save();
  ctx.translate(8+rotatedWidth/2,20+crop.height+rotatedHeight/2);
  ctx.rotate(-radians);
  ctx.drawImage(crop,-crop.width/2,-crop.height/2);
  ctx.restore();
  ink.globalCompositeOperation="source-in";
  ink.fillStyle="#171717"; ink.fillRect(0,0,crop.width,crop.height);
  ctx.drawImage(crop,8,32+crop.height+rotatedHeight);
  return sheet.toDataURL("image/png");
}

export async function recognizeLocalGameImage<T extends PaddleOcrLine>(blob: Blob, recognize: (input: Blob) => Promise<T[]>, signal: AbortSignal) {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  const enhanced = (() => {
    try { return prepareGameOcrCrop(bitmap); }
    finally { bitmap.close(); }
  })();
  signal.throwIfAborted();
  if (!enhanced) return recognize(blob);
  const { canvas, crop } = enhanced;
  const input = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法生成识字用图片")), "image/png"));
  signal.throwIfAborted();
  const lines = await recognize(input);
  signal.throwIfAborted();
  return mapGameOcrCrop(lines, crop, canvas.width, canvas.height);
}
