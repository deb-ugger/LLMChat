import type { MosaicBox, MosaicScan } from "./gameMosaic";

type GridPass = {
  tile: number; minimumSize: number; stride: number; sampleStep: number;
  minPeriod: number; maxPeriod: number; periodTolerance: number;
  strongEdge: number; meanEdge: number; contrast: number; ratio: number;
};

const gridPasses: readonly GridPass[] = [
  { tile: 64, minimumSize: 48, stride: 32, sampleStep: 4, minPeriod: 4, maxPeriod: 24,
    periodTolerance: 0, strongEdge: 10, meanEdge: 14, contrast: 10, ratio: 3.2 },
  // Smaller, closely spaced windows retain local grid evidence against textured surroundings.
  { tile: 32, minimumSize: 24, stride: 8, sampleStep: 2, minPeriod: 3, maxPeriod: 14,
    periodTolerance: 2, strongEdge: 4, meanEdge: 6, contrast: 4, ratio: 2.9 },
];

function tileStarts(size: number, tile: number, stride: number) {
  const starts: number[] = [];
  for (let start = 0; start + tile < size; start += stride) starts.push(start);
  starts.push(size - tile);
  return starts;
}

// Reject windows whose strongest edge cannot reach the required contrast.
function edgeTotal(edges: Float64Array, pass: GridPass) {
  let min = Infinity, max = 0, total = 0, strong = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    total += edge;
    min = Math.min(min, edge);
    max = Math.max(max, edge);
    if (edge >= pass.strongEdge) strong++;
  }
  return strong >= 3 && max >= pass.meanEdge && max >= pass.ratio * Math.max(3, min) ? total : 0;
}

function matchesPeriod(edges: Float64Array, total: number, period: number, pass: GridPass) {
  for (let phase = 0; phase < period; phase++) {
    const count = Math.ceil((edges.length - phase) / period);
    if (count < 3) continue;
    let strong = 0, sum = 0;
    for (let i = phase; i < edges.length; i += period) {
      const edge = edges[i];
      sum += edge;
      if (edge >= pass.strongEdge) strong++;
    }
    const mean = sum / count;
    if (strong * 4 < count * 3 || mean < pass.meanEdge) continue;
    const elsewhere = (total - sum) / (edges.length - count);
    if (mean - elsewhere >= pass.contrast && mean / Math.max(3, elsewhere) >= pass.ratio) return true;
  }
  return false;
}

function union(a: MosaicBox, b: MosaicBox): MosaicBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function mergeCandidate(boxes: MosaicBox[], next: MosaicBox) {
  for (let index = 0; index < boxes.length;) {
    const box = boxes[index];
    if (box[0] < next[2] && box[2] > next[0] && box[1] < next[3] && box[3] > next[1]) {
      next = union(box, next);
      boxes.splice(index, 1);
      index = 0;
    } else index++;
  }
  boxes.push(next);
}

export function sceneSignature(rgba: Uint8ClampedArray, width: number, height: number) {
  const signature: number[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const index = (Math.floor((y + 0.5) * height / 16) * width + Math.floor((x + 0.5) * width / 16)) * 4;
    const luma = (rgba[index] * 54 + rgba[index + 1] * 183 + rgba[index + 2] * 19) / 256;
    signature.push(Math.round((luma - 127) * rgba[index + 3] / 255 + 127));
  }
  return signature;
}

export function scanMosaicPixels(rgba: Uint8ClampedArray, width: number, height: number, signature = sceneSignature(rgba, width, height)): MosaicScan {
  const boxes: MosaicBox[] = [];
  const shortest = Math.min(width, height);
  const stride = width * 4;
  const distance = (a: number, b: number) =>
    rgba[a + 3] < 64 || rgba[b + 3] < 64 ? 0 :
      (Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2])) / 3;

  for (const pass of gridPasses) {
    if (shortest < pass.minimumSize) continue;
    const size = Math.min(pass.tile, shortest);
    const edgeCount = size - 1;
    const windowStride = Math.min(Math.floor(size / 2), pass.stride);
    const xs = tileStarts(width, size, windowStride);
    const ys = tileStarts(height, size, windowStride);
    const vertical = new Float64Array(edgeCount);
    const samples = Math.ceil(size / pass.sampleStep);
    const horizontalStrip = new Float64Array(width - 1);
    // Windows on the same row share their horizontal edge samples.
    for (const y of ys) {
      horizontalStrip.fill(0);
      for (let offset = 0; offset < size; offset += pass.sampleStep) {
        const start = (y + offset) * stride;
        for (let edge = 0, a = start; edge < horizontalStrip.length; edge++, a += 4) {
          horizontalStrip[edge] += distance(a, a + 4);
        }
      }
      for (let edge = 0; edge < horizontalStrip.length; edge++) horizontalStrip[edge] /= samples;

      for (const x of xs) {
        if (pass.periodTolerance && boxes.some(([left, top, right, bottom]) =>
          left <= x && top <= y && right >= x + size && bottom >= y + size)) continue;
        const horizontal = horizontalStrip.subarray(x, x + edgeCount);
        const across = edgeTotal(horizontal, pass);
        if (!across) continue;
        let down: number | undefined;
        for (let period = pass.minPeriod; period <= pass.maxPeriod; period++) {
          if (!matchesPeriod(horizontal, across, period, pass)) continue;
          if (down === undefined) {
            const origin = y * stride + x * 4;
            for (let edge = 0; edge < edgeCount; edge++) {
              let sum = 0;
              let a = origin + edge * stride;
              for (let sample = 0; sample < samples; sample++, a += 4 * pass.sampleStep) {
                sum += distance(a, a + stride);
              }
              vertical[edge] = sum / samples;
            }
            down = edgeTotal(vertical, pass);
          }
          if (!down) break;
          const first = Math.max(pass.minPeriod, period - pass.periodTolerance);
          const last = Math.min(pass.maxPeriod, period + pass.periodTolerance);
          let matched = false;
          for (let step = first; step <= last; step++) {
            if (matchesPeriod(vertical, down, step, pass)) { matched = true; break; }
          }
          if (matched) {
            mergeCandidate(boxes, [Math.floor(x), Math.floor(y), Math.floor(x + size), Math.floor(y + size)]);
            break;
          }
        }
      }
    }
  }
  return { boxes, signature };
}
