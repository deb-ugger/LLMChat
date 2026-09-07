export type PdfOcrTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  coreX0: number;
  coreY0: number;
  coreX1: number;
  coreY1: number;
};

/** Keep OCR resolution; bound each raster allocation instead of shrinking large pages. */
export function planPdfOcrTiles(width: number, height: number): PdfOcrTile[] {
  const maxSide = 3200;
  const maxPixels = 6_000_000;
  const overlap = 192;
  const tileWidth = Math.min(width, maxSide);
  const tileHeight = Math.min(height, maxSide, Math.floor(maxPixels / tileWidth));
  const coreWidth = width <= tileWidth ? width : tileWidth - overlap * 2;
  const coreHeight = height <= tileHeight ? height : tileHeight - overlap * 2;
  const tiles: PdfOcrTile[] = [];
  for (let y = 0; y < height; y += coreHeight) {
    for (let x = 0; x < width; x += coreWidth) {
      const left = Math.max(0, x - overlap);
      const top = Math.max(0, y - overlap);
      const right = Math.min(width, x + coreWidth + overlap);
      const bottom = Math.min(height, y + coreHeight + overlap);
      tiles.push({
        x: left, y: top, width: right - left, height: bottom - top,
        coreX0: x, coreY0: y,
        coreX1: Math.min(width, x + coreWidth),
        coreY1: Math.min(height, y + coreHeight),
      });
    }
  }
  return tiles;
}

/** Overlap supplies context; one core owns each line so seams do not duplicate text. */
export function tileOwnsLine(tile: PdfOcrTile, line: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const x = (line.x0 + line.x1) / 2 + tile.x;
  const y = (line.y0 + line.y1) / 2 + tile.y;
  return x >= tile.coreX0 && x < tile.coreX1 && y >= tile.coreY0 && y < tile.coreY1;
}
