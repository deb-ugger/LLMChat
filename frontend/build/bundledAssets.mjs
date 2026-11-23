import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const paddleSource = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/";
const paddleAssets = [
  ["PP-OCRv6_small_det_onnx_infer.tar", "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4"],
  ["PP-OCRv6_small_rec_onnx_infer.tar", "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1"],
];
const ortAssets = [
  {
    packageDir: "node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web",
    publicDir: "ort",
    files: [
      ["ort-wasm-simd-threaded.jsep.mjs", "3d68fa7af88c48894d4b0c8629de12018ab73b77519bc0b05dc8d908ad82749f"],
      ["ort-wasm-simd-threaded.jsep.wasm", "db816fadbab47a755170c08f933961e231412ac17f5981f9a62e519708a44dea"],
    ],
  },
  {
    packageDir: "node_modules/onnxruntime-web",
    publicDir: "manga-ort",
    files: [
      ["ort-wasm-simd-threaded.asyncify.mjs", "5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9"],
      ["ort-wasm-simd-threaded.asyncify.wasm", "e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786"],
    ],
  },
];

async function sha256(file) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareAsset(destination, checksum, staging, materialize) {
  if (await sha256(destination) === checksum) return;
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  await mkdir(staging, { recursive: true });
  const temporary = path.join(staging, randomUUID() + ".tmp");
  try {
    await materialize(temporary);
    if (await sha256(temporary) !== checksum) {
      throw new Error("SHA-256 mismatch for " + path.basename(destination));
    }
    await rename(temporary, destination);
    console.log("Prepared bundled asset " + path.basename(destination));
  } finally {
    await rm(temporary, { force: true });
  }
}

function prepareDownload(destination, checksum, staging, url) {
  return prepareAsset(destination, checksum, staging, async temporary => {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) }).catch(cause => {
      throw new Error("Failed to download " + url, { cause });
    });
    if (!response.ok || !response.body) {
      throw new Error("Failed to download " + url + " (HTTP " + response.status + ")");
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
  });
}

export async function prepareFrontendAssets(frontendRoot) {
  const publicRoot = path.join(frontendRoot, "public");
  const staging = path.resolve(frontendRoot, "../backend/build/bundled-assets");
  const wasm = ortAssets.flatMap(({ packageDir, publicDir, files }) => files.map(([file, checksum]) =>
    prepareAsset(path.join(publicRoot, publicDir, file), checksum, staging, temporary => {
      const source = path.join(frontendRoot, packageDir, "dist", file);
      return copyFile(source, temporary).catch(error => {
        if (error.code === "ENOENT") throw new Error("Missing " + source + ". Run npm ci in frontend.");
        throw error;
      });
    })
  ));
  await Promise.all([
    ...wasm,
    ...paddleAssets.map(([file, checksum]) => prepareDownload(path.join(publicRoot, "ocr", file), checksum, staging, paddleSource + file)),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  await prepareDownload(
    path.join(repository, "assets/fonts/NotoSansCJKsc-Regular.otf"),
    "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
    path.join(repository, "backend/build/bundled-assets"),
    "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
  );
}
