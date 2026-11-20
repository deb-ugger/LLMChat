import { scanMosaicPixels } from "./gameMosaicGrid";

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    const bitmap = await createImageBitmap(data);
    try {
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("无法读取图片像素");
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height);
      self.postMessage(scanMosaicPixels(pixels.data, width, height));
    } finally { bitmap.close(); }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
