import type { MosaicBox, MosaicScan } from "./gameMosaic";

function tileStarts(size: number, tile: number) {
  const starts: number[] = [];
  for (let start = 0; start + tile < size; start += tile / 2) starts.push(start);
  starts.push(size - tile);
  return starts;
}

// Reject windows whose strongest edge cannot reach the required contrast.
function edgeTotal(edges: Float64Array) {
  let min = Infinity, max = 0, total = 0, strong = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    total += edge;
    min = Math.min(min, edge);
    max = Math.max(max, edge);
    if (edge >= 10) strong++;
  }
  return strong >= 3 && max >= 14 && max >= 3.2 * Math.max(3, min) ? total : 0;
}

function matchesPeriod(edges: Float64Array, total: number, period: number) {
  for (let phase = 0; phase < period; phase++) {
    const count = Math.ceil((edges.length - phase) / period);
    if (count < 3) continue;
    let strong = 0, sum = 0;
    for (let i = phase; i < edges.length; i += period) {
      const edge = edges[i];
      sum += edge;
      if (edge >= 10) strong++;
    }
    const mean = sum / count;
    if (strong * 4 < count * 3 || mean < 14) continue;
    const elsewhere = (total - sum) / (edges.length - count);
    if (mean - elsewhere >= 10 && mean / Math.max(3, elsewhere) >= 3.2) return true;
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

export function scanMosaicPixels(rgba: Uint8ClampedArray, width: number, height: number): MosaicScan {
  const boxes: MosaicBox[] = [];
  const signature = sceneSignature(rgba, width, height);
  if (Math.min(width, height) < 48) return { boxes, signature };

  const size = Math.min(64, width, height);
  const horizontal = new Float64Array(size - 1);
  const vertical = new Float64Array(size - 1);
  const distance = (a: number, b: number) =>
    Math.min(rgba[a + 3], rgba[b + 3]) < 64 ? 0 :
      (Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2])) / 3;

  const xs = tileStarts(width, size);
  const stride = width * 4;
  const samples = Math.ceil(size / 4);
  function measure(edges: Float64Array, origin: number, axis: number, cross: number) {
    for (let edge = 0; edge < edges.length; edge++) {
      let index = origin + edge * axis, sum = 0;
      for (let sample = 0; sample < samples; sample++, index += 4 * cross) {
        sum += distance(index, index + axis);
      }
      edges[edge] = sum / samples;
    }
    return edgeTotal(edges);
  }
  for (const y of tileStarts(height, size)) for (const x of xs) {
    const origin = y * stride + x * 4;
    const across = measure(horizontal, origin, 4, stride);
    if (!across) continue;
    let down: number | undefined;
    for (let period = 4; period <= 24; period++) {
      if (!matchesPeriod(horizontal, across, period)) continue;
      down ??= measure(vertical, origin, stride, 4);
      if (!down) break;
      if (matchesPeriod(vertical, down, period)) {
        mergeCandidate(boxes, [Math.floor(x), Math.floor(y), Math.floor(x + size), Math.floor(y + size)]);
        break;
      }
    }
  }
  return { boxes, signature };
}
