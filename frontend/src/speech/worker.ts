import { SPEECH_MODELS, normalizeSpeechChunks, type SpeechRequest, type SpeechResponse } from "./transcription";

type ASR = import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline;
let transcriber: ASR | null = null;
let busy = false;
const send = (message: SpeechResponse) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<SpeechRequest>) => {
  const request = event.data;
  if (busy) { send({ id: request.id, type: "error", message: "识别线程忙碌" }); return; }
  busy = true;
  try {
    const modelInfo = SPEECH_MODELS.find(model => model.id === request.model);
    if (!modelInfo) throw new Error("不支持的语音模型");
    const { pipeline, env, WhisperTextStreamer, Tensor } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // Ship the WASM runtime with the application, just as for Manga OCR.
    env.backends.onnx.wasm!.numThreads = 1;
    env.backends.onnx.wasm!.proxy = false;
    env.backends.onnx.wasm!.wasmPaths = {
      mjs: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.mjs", request.assetBase).href,
      wasm: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.wasm", request.assetBase).href,
    };
    if (!transcriber) {
      send({ id: request.id, type: "progress", progress: { phase: "download", message: "加载语音识别模型…" } });
      transcriber = await pipeline("automatic-speech-recognition", request.model, {
        device: "wasm", dtype: "q8",
        // This shipped ORT build has a QDQ transpose optimizer regression for
        // Whisper decoders (onnxruntime#28306). Keep the quantized graph intact.
        session_options: { graphOptimizationLevel: "disabled" },
        progress_callback: info => {
          if (info.status === "progress") send({ id: request.id, type: "progress", progress: {
            phase: "download", percent: info.progress,
            message: `${info.file} · ${(info.loaded / 1048576).toFixed(1)} / ${(info.total / 1048576).toFixed(1)} MiB`,
          } });
          else if (info.status === "done") send({ id: request.id, type: "progress", progress: { phase: "download", message: `${info.file} 已就绪` } });
        },
      });
      // Some fine-tuned exports require an explicit position vector, which this
      // SDK's encoder/decoder generation helper omits. Derive it from token IDs.
      const model = transcriber.model;
      if (model.sessions.decoder_model_merged.inputNames.includes("cache_position")) {
        const prepare = model.prepare_inputs_for_generation.bind(model);
        model.prepare_inputs_for_generation = (...args) => {
          const inputs = prepare(...args);
          const length = inputs.decoder_input_ids.dims[1];
          const start = args[0][0].length - length;
          inputs.cache_position = new Tensor("int64", BigInt64Array.from({ length }, (_, index) => BigInt(start + index)), [length]);
          return inputs;
        };
      }
    }
    const duration = request.pcm.length / 16000;
    const windows = Math.max(1, Math.ceil((duration - 30) / 20) + 1);
    let complete = 0, preview = "", lastPreview = 0;
    const language = modelInfo.language === "auto" ? request.language : modelInfo.language;
    let detectedLanguage = language === "auto" ? undefined : language;
    const streamer = new WhisperTextStreamer(transcriber.tokenizer as import("@huggingface/transformers").WhisperTokenizer, {
      skip_prompt: true,
      callback_function: text => {
        if (request.preview === false) return;
        preview = (preview + text).slice(-4000);
        if (performance.now() - lastPreview > 180) {
          send({ id: request.id, type: "preview", text: preview }); lastPreview = performance.now();
        }
      },
      on_finalize: () => {
        complete++;
        send({ id: request.id, type: "progress", progress: { phase: "recognize", percent: Math.min(99, complete / windows * 100), message: `已识别 ${Math.min(complete, windows)} / ${windows} 个音频片段` } });
      },
    });
    const put = streamer.put.bind(streamer);
    streamer.put = value => {
      if (!detectedLanguage && value[0]?.length) {
        const prefix = transcriber!.tokenizer.decode(value[0], { skip_special_tokens: false });
        detectedLanguage = prefix.match(/<\|([a-z]{2,3})\|>/)?.[1];
      }
      if (request.preview !== false) put(value);
    };
    send({ id: request.id, type: "progress", progress: { phase: "recognize", percent: 0, message: "正在本地识别并生成时间戳" } });
    const result = await transcriber(request.pcm, {
      return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
      ...(modelInfo.englishOnly ? {} : { task: "transcribe", ...(language === "auto" ? {} : { language }) }), streamer,
    });
    const output = Array.isArray(result) ? result[0] : result;
    const cues = normalizeSpeechChunks(output.chunks ?? [], duration);
    send({ id: request.id, type: "result", result: { text: output.text.trim(), cues, language: detectedLanguage } });
  } catch (error) {
    send({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
