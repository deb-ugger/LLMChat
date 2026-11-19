import fs from "node:fs";
function replaceSdkCode(source, before, after) {
  const patched = source.replace(before, () => after);
  if (patched === source) throw new Error("PaddleOCR inference pipeline changed; update memory adapter");
  return patched;
}

export function batchPaddleRecognition(source) {
  if (!source.includes("const perImageItems = [];")) return source;
  const start = source.indexOf("        const perImageItems = [];");
  const end = source.indexOf("        sumRecMs +=", start);
  if (start < 0 || end < 0 || !source.slice(start, end).includes("cropByPoly"))
    throw new Error("PaddleOCR recognition pipeline changed; update batch adapter");
  const replacement = `        const perImageItems = detResults.map(() => []);
        const cropBatchSize = Math.max(1, Math.floor(this.pipelineConfig.textRecognitionBatchSize));
        const crops = [], owners = [];
        const releaseCrops = () => {
          for (const crop of crops) crop.delete();
          crops.length = 0;
          owners.length = 0;
        };
        const recognizeCrops = async () => {
          try {
            const results = await recModel.predict(cv, crops);
            if (results.length !== owners.length) throw new Error("OCR crop/result count mismatch");
            for (let index = 0; index < results.length; index++) {
              const rec = results[index], owner = owners[index];
              if (rec.text && rec.score >= resolved.pipeline.scoreThresh)
                perImageItems[owner.imageIndex].push({ poly: owner.poly, text: rec.text, score: rec.score });
            }
          } finally { releaseCrops(); }
        };
        try {
          for (let imageIndex = 0; imageIndex < detResults.length; imageIndex++) {
            for (const box of detResults[imageIndex]?.boxes ?? []) {
              crops.push(cropByPoly(cv, sourceImages[imageIndex].mat, box.poly));
              owners.push({ imageIndex, poly: box.poly });
              if (crops.length === cropBatchSize) await recognizeCrops();
            }
          }
          if (crops.length) await recognizeCrops();
        } finally { releaseCrops(); }
`;
  let patched = source.slice(0, start) + replacement + source.slice(end);
  patched = replaceSdkCode(patched,
    /async function runInference\(session, inputTensor\) \{[\s\S]*?\n\}/,
    `async function runInference(session, inputTensor, readOutput) {
  let outputMap;
  try {
    outputMap = await session.run({ [session.inputNames[0]]: inputTensor });
    return readOutput(outputMap[session.outputNames[0]]);
  } finally {
    inputTensor.dispose();
    if (outputMap) for (const tensor of Object.values(outputMap)) tensor.dispose();
  }
}`);
  patched = replaceSdkCode(patched,
    /const fullOutput = await runInference\(sessionState\.session, inputTensor\);\s*const internals = postprocess\$1\(runCtx, fullOutput, preps, params\);/,
    "const internals = await runInference(sessionState.session, inputTensor, output => postprocess$1(runCtx, output, preps, params));");
  patched = replaceSdkCode(patched,
    /const output = await runInference\(sessionState\.session, inputTensor\);\s*const batchResults = postprocess\(output, charDict\);/,
    "const batchResults = await runInference(sessionState.session, inputTensor, output => postprocess(output, charDict));");
  return replaceSdkCode(patched, /executionProviders,\s*graphOptimizationLevel: "all"/,
    'executionProviders: executionProviders.map(provider => provider === "webgpu" ? { name: provider, storageBufferCacheMode: "lazyRelease" } : provider),\n        graphOptimizationLevel: "all"');
}
export function paddleBatchingPlugin(){
 return {name:"paddle-cross-image-recognition",
  transform(code,id) {
    const file = id.replaceAll("\\", "/").split("?")[0];
    if (!file.includes("@paddleocr/paddleocr-js/dist/")) return;
    const patched = batchPaddleRecognition(code);
    if (!file.endsWith("/index.mjs")) return patched;
    if (!patched.includes("function createDefaultWorker()")) throw new Error("PaddleOCR worker factory changed; update OCR worker adapter");
    return patched + "\nexport { createDefaultWorker as createPaddleWorker };\n";
  },
  generateBundle(_options,bundle){for(const item of Object.values(bundle)){if(item.type==="asset"&&item.fileName.endsWith(".js"))item.source=batchPaddleRecognition(typeof item.source==="string"?item.source:new TextDecoder().decode(item.source));else if(item.type==="chunk")item.code=batchPaddleRecognition(item.code);}},
  configureServer(server){server.middlewares.use((req,res,next)=>{const url=(req.url??"").split("?")[0];if(!url.includes("@paddleocr/paddleocr-js/dist/assets/worker-entry-")||!url.endsWith(".js"))return next();const file=new URL("../node_modules/"+url.split("/node_modules/")[1],import.meta.url);try{res.setHeader("Content-Type","text/javascript");res.end(batchPaddleRecognition(fs.readFileSync(file,"utf8")));}catch(error){next(error);}});}
 };
}
