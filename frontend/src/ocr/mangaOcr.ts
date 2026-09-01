import { API_BASE, api } from "../api";

const MODEL_ID = "manga-ocr-base-ONNX";
const DECODER_START_TOKEN_ID = 2;
const EOS_TOKEN_ID = 3;
const MAX_NEW_TOKENS = 192;

type OrtModule = typeof import("onnxruntime-web");
type TransformersModule = typeof import("@huggingface/transformers");
type MangaProcessor = Awaited<
  ReturnType<TransformersModule["AutoProcessor"]["from_pretrained"]>
>;

interface MangaRuntime {
  ort: OrtModule;
  vocabulary: string[];
  processor: MangaProcessor;
  RawImage: TransformersModule["RawImage"];
  encoder: import("onnxruntime-web").InferenceSession;
  decoder: import("onnxruntime-web").InferenceSession;
}

function localAssetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

function modelFileUrl(path: string): string {
  return `${API_BASE}/api/ocr/model-files/${MODEL_ID}/${path}`;
}

async function fetchModel(path: string): Promise<ArrayBuffer> {
  const response = await fetch(modelFileUrl(path));
  if (!response.ok) {
    throw new Error(`Manga OCR 模型文件读取失败：${path} (${response.status})`);
  }
  return response.arrayBuffer();
}

interface MangaTokenizerJson {
  model?: {
    vocab?: Record<string, number>;
  };
}

async function fetchVocabulary(): Promise<string[]> {
  const tokenizerBytes = await fetchModel("tokenizer.json");
  const tokenizer = JSON.parse(
    new TextDecoder().decode(tokenizerBytes),
  ) as MangaTokenizerJson;
  const vocabulary: string[] = [];
  for (const [token, id] of Object.entries(tokenizer.model?.vocab ?? {})) {
    if (Number.isInteger(id) && id >= 0) vocabulary[id] = token;
  }
  if (!vocabulary.length) throw new Error("Manga OCR 词表读取失败");
  return vocabulary;
}

async function createMangaRuntime(): Promise<MangaRuntime> {
  await api.ensureOcrMode("manga");
  const [{ env, AutoProcessor, RawImage }, ort] = await Promise.all([
    import("@huggingface/transformers"),
    import("onnxruntime-web"),
  ]);

  // Tokenizer and image processor stay under backend model management. Avoid
  // WebView2's cache so the 117 MiB model is not stored a second time.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${API_BASE}/api/ocr/model-files/`;
  env.useBrowserCache = false;

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: localAssetUrl(
      "./manga-ort/ort-wasm-simd-threaded.asyncify.mjs",
    ),
    wasm: localAssetUrl(
      "./manga-ort/ort-wasm-simd-threaded.asyncify.wasm",
    ),
  };

  const modelOptions = { local_files_only: true } as const;
  const [vocabulary, processor, encoderBytes, decoderBytes] = await Promise.all([
    fetchVocabulary(),
    AutoProcessor.from_pretrained(MODEL_ID, modelOptions),
    fetchModel("onnx/encoder_model_quantized.onnx"),
    fetchModel("onnx/decoder_model_quantized.onnx"),
  ]);
  const sessionOptions = { executionProviders: ["wasm"] } as const;
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(encoderBytes, sessionOptions),
    ort.InferenceSession.create(decoderBytes, sessionOptions),
  ]);

  return { ort, vocabulary, processor, RawImage, encoder, decoder };
}

function argmaxLastToken(logits: import("onnxruntime-web").Tensor): number {
  const vocabSize = logits.dims[logits.dims.length - 1];
  if (!vocabSize) throw new Error("Manga OCR 解码器返回了无效的词表维度");
  const values = logits.data as ArrayLike<number>;
  const offset = values.length - vocabSize;
  let bestToken = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let token = 0; token < vocabSize; token += 1) {
    const score = Number(values[offset + token]);
    if (score > bestScore) {
      bestScore = score;
      bestToken = token;
    }
  }
  return bestToken;
}

function decodeTokenIds(tokenIds: number[], vocabulary: string[]): string {
  return tokenIds
    .map((id) => vocabulary[id] ?? "")
    .filter(
      (token) =>
        token &&
        token !== "[PAD]" &&
        token !== "[UNK]" &&
        token !== "[CLS]" &&
        token !== "[SEP]" &&
        token !== "[MASK]",
    )
    .map((token) => (token.startsWith("##") ? token.slice(2) : token))
    .join("")
    .replace(/[ \t\r\n]+/g, "")
    .trim();
}

async function recognizeWithRuntime(
  runtime: MangaRuntime,
  image: Blob,
): Promise<string> {
  const rawImage = await runtime.RawImage.fromBlob(image);
  const processed = await runtime.processor(rawImage);
  const pixelValues = processed.pixel_values;
  if (!pixelValues) throw new Error("Manga OCR 图片预处理失败");

  const encoderResult = await runtime.encoder.run({
    pixel_values: new runtime.ort.Tensor(
      "float32",
      pixelValues.data as Float32Array,
      [...pixelValues.dims],
    ),
  });
  const hiddenState = encoderResult.last_hidden_state;
  if (!hiddenState) throw new Error("Manga OCR 编码器没有返回图像特征");

  const tokenIds = [DECODER_START_TOKEN_ID];
  for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
    const decoderResult = await runtime.decoder.run({
      input_ids: new runtime.ort.Tensor(
        "int64",
        BigInt64Array.from(tokenIds.map((token) => BigInt(token))),
        [1, tokenIds.length],
      ),
      encoder_hidden_states: hiddenState,
    });
    const logits = decoderResult.logits;
    if (!logits) throw new Error("Manga OCR 解码器没有返回文字概率");
    const nextToken = argmaxLastToken(logits);
    if (nextToken === EOS_TOKEN_ID) break;
    tokenIds.push(nextToken);
  }

  return decodeTokenIds(tokenIds, runtime.vocabulary);
}

export class LocalMangaOcr {
  private instance: MangaRuntime | null = null;
  private initializing: Promise<MangaRuntime> | null = null;

  private async create(): Promise<MangaRuntime> {
    if (this.instance) return this.instance;
    if (!this.initializing) {
      this.initializing = createMangaRuntime()
        .then((instance) => {
          this.instance = instance;
          return instance;
        })
        .finally(() => {
          this.initializing = null;
        });
    }
    return this.initializing;
  }

  async recognize(image: Blob): Promise<string> {
    return recognizeWithRuntime(await this.create(), image);
  }

  async dispose(): Promise<void> {
    const pending = this.initializing;
    this.initializing = null;
    let instance = this.instance;
    this.instance = null;
    if (!instance && pending) {
      try {
        instance = await pending;
      } catch {
        return;
      }
    }
    if (!instance) return;
    await Promise.all([instance.encoder.release(), instance.decoder.release()]);
  }
}
