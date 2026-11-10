let API_BASE = "";
let assetBase = "";
import { OcrRuntime } from "./runtime";

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
  deviceMessage:string;
  fallback:boolean;
  vocabulary: string[];
  processor: MangaProcessor;
  RawImage: TransformersModule["RawImage"];
  encoder: import("onnxruntime-web").InferenceSession;
  decoder: import("onnxruntime-web").InferenceSession;
  decoderStep: import("onnxruntime-web").InferenceSession;
}

function localAssetUrl(path: string): string {
  return new URL(path, assetBase).href;
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
  const [{ env, AutoProcessor, RawImage }, ort] = await Promise.all([
    import("@huggingface/transformers"),
    import("onnxruntime-web/webgpu"),
  ]);

  // Tokenizer and image processor stay under backend model management. Avoid
  // WebView2's cache so the 117 MiB model is not stored a second time.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${API_BASE}/api/ocr/model-files/`;
  env.useBrowserCache = false;

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {mjs:localAssetUrl("./ort/ort-wasm-simd-threaded.jsep.mjs"),wasm:localAssetUrl("./ort/ort-wasm-simd-threaded.jsep.wasm")};

  const modelOptions = { local_files_only: true } as const;
  const [vocabulary, processor, encoderBytes, decoderBytes,decoderStepBytes] = await Promise.all([
    fetchVocabulary(),
    AutoProcessor.from_pretrained(MODEL_ID, modelOptions),
    fetchModel("onnx/encoder_model_quantized.onnx"),
    fetch(localAssetUrl("./ocr/manga-kv/decoder_kv_init_quantized.onnx")).then(response=>{if(!response.ok)throw new Error("日文增强 KV 首步模型缺失");return response.arrayBuffer();}),
    fetch(localAssetUrl("./ocr/manga-kv/decoder_kv_step_quantized.onnx")).then(response=>{if(!response.ok)throw new Error("日文增强 KV 缓存模型缺失");return response.arrayBuffer();}),
  ]);
  const create=async(provider:"webgpu"|"wasm")=>{
    const options={executionProviders:[provider]};
    const encoder=await ort.InferenceSession.create(encoderBytes,options);
    try{const decoder=await ort.InferenceSession.create(decoderBytes,options);try{const decoderStep=await ort.InferenceSession.create(decoderStepBytes,options);return {encoder,decoder,decoderStep};}catch(error){await decoder.release();throw error;}}
    catch(error){await encoder.release();throw error;}
  };
  try{
    const pair=await create("webgpu");
    return {ort,vocabulary,processor,RawImage,...pair,deviceMessage:"日文增强：GPU · WebGPU · KV 缓存",fallback:false};
  }catch(error){
    const reason=error instanceof Error?error.message:String(error);
    const pair=await create("wasm");
    return {ort,vocabulary,processor,RawImage,...pair,deviceMessage:`日文增强：CPU · KV 缓存，GPU 不可用：${reason}`,fallback:true};
  }
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
  image: Blob | ImageBitmap,
  signal: AbortSignal,
): Promise<string> {
  let rawImage;
  if(image instanceof ImageBitmap){try{const canvas=new OffscreenCanvas(image.width,image.height);canvas.getContext("2d")!.drawImage(image,0,0);rawImage=runtime.RawImage.fromCanvas(canvas);}finally{image.close();}}
  else rawImage=await runtime.RawImage.fromBlob(image);
  const processed = await runtime.processor(rawImage);
  const pixelValues = processed.pixel_values;
  if (!pixelValues) throw new Error("Manga OCR 图片预处理失败");

  if (signal.aborted) throw new Error("识别已取消");
  const pixels = new runtime.ort.Tensor(
    "float32",
    pixelValues.data as Float32Array,
    [...pixelValues.dims],
  );
  let past:Record<string,import("onnxruntime-web").Tensor>={};
  let encoderResult: Awaited<ReturnType<MangaRuntime["encoder"]["run"]>> = {};
  try {
    encoderResult = await runtime.encoder.run({ pixel_values: pixels });
    const hiddenState = encoderResult.last_hidden_state;
    if (!hiddenState) throw new Error("Manga OCR 编码器没有返回图像特征");

    const tokenIds = [DECODER_START_TOKEN_ID];
    const tokenBuffer = new BigInt64Array(MAX_NEW_TOKENS + 1);
    tokenBuffer[0] = BigInt(DECODER_START_TOKEN_ID);
    let lastYield = performance.now();
    for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
      // WASM promises may resolve without yielding to browser timers/painting.
      // Give progress and cancellation a turn without delaying every token.
      if (performance.now() - lastYield >= 50) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
      if (signal.aborted) throw new Error("识别已取消");
      const inputIds = new runtime.ort.Tensor(
        "int64",
        tokenBuffer.subarray(tokenIds.length-1,tokenIds.length),
        [1,1],
      );
      let decoderResult: Awaited<ReturnType<MangaRuntime["decoder"]["run"]>> = {};
      try {
        const session=step===0?runtime.decoder:runtime.decoderStep;
        const feeds:Record<string,import("onnxruntime-web").Tensor>={input_ids:inputIds};
        if(session.inputNames.includes("encoder_hidden_states"))feeds.encoder_hidden_states=hiddenState;
        for(const name of session.inputNames)if(name.startsWith("past.")){if(!past[name])throw new Error("日文增强 KV 缓存缺少："+name);feeds[name]=past[name];}
        decoderResult=await session.run(feeds);
        const next:Record<string,import("onnxruntime-web").Tensor>={};
        for(const [name,tensor] of Object.entries(decoderResult))if(name.startsWith("present."))next[name.replace("present.","past.")]=tensor;
        const retained=new Set(Object.values(next));for(const tensor of Object.values(past))if(!retained.has(tensor))tensor.dispose();past=next;
        const logits = decoderResult.logits;
        if (!logits) throw new Error("Manga OCR 解码器没有返回文字概率");
        const nextToken = argmaxLastToken(logits);
        if (nextToken === EOS_TOKEN_ID) break;
        tokenBuffer[tokenIds.length] = BigInt(nextToken);
        tokenIds.push(nextToken);
      } finally {
        inputIds.dispose();
        const retained=new Set(Object.values(past));for (const tensor of Object.values(decoderResult))if(!retained.has(tensor))tensor.dispose();
      }
    }
    return decodeTokenIds(tokenIds, runtime.vocabulary);
  } finally {
    for(const tensor of Object.values(past))tensor.dispose();
    pixels.dispose();
    for (const tensor of Object.values(encoderResult)) tensor.dispose();
  }
}

const runtime = new OcrRuntime(createMangaRuntime,
  (instance) => Promise.all([instance.encoder.release(), instance.decoder.release(),instance.decoderStep.release()]));
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; image: Blob | ImageBitmap; apiBase: string; assetBase: string }>) => {
  const request = event.data;
  queue = queue.then(async () => {
    API_BASE = request.apiBase;
    assetBase = request.assetBase;
    try {
      const text = await runtime.run(async (instance, signal) => {
        self.postMessage({ id: request.id, type: "ready",deviceMessage:instance.deviceMessage,fallback:instance.fallback });
        return recognizeWithRuntime(instance, request.image, signal);
      });
      self.postMessage({ id: request.id, type: "result", text });
    } catch (error) {
      if(request.image instanceof ImageBitmap)request.image.close();
      self.postMessage({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
};
