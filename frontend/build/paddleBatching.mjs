import fs from "node:fs";
export function batchPaddleRecognition(source){
  if(!source.includes("const perImageItems = [];"))return source;
  const start=source.indexOf("        const perImageItems = [];");
  const end=source.indexOf("        sumRecMs +=",start);
  if(start<0||end<0||!source.slice(start,end).includes("cropByPoly"))throw new Error("PaddleOCR recognition pipeline changed; update batch adapter");
  const replacement=`        const perImageItems = [];
        const crops = [], owners = [];
        try {
          for (let imageIndex=0; imageIndex<detResults.length; imageIndex++) {
            const boxes=detResults[imageIndex]?.boxes??[];
            perImageItems.push([]);
            for (const box of boxes) {
              crops.push(cropByPoly(cv,sourceImages[imageIndex].mat,box.poly));
              owners.push({imageIndex,poly:box.poly});
            }
          }
          const results=crops.length?await recModel.predict(cv,crops):[];
          if(results.length!==owners.length)throw new Error("OCR crop/result count mismatch");
          for(let index=0;index<results.length;index++){
            const rec=results[index],owner=owners[index];
            if(rec.text&&rec.score>=resolved.pipeline.scoreThresh)perImageItems[owner.imageIndex].push({poly:owner.poly,text:rec.text,score:rec.score});
          }
        }finally{for(const crop of crops)crop.delete();}
`;
  return source.slice(0,start)+replacement+source.slice(end);
}
export function paddleBatchingPlugin(){
 return {name:"paddle-cross-image-recognition",
  transform(code,id){if(id.replaceAll("\\","/").includes("@paddleocr/paddleocr-js/dist/"))return batchPaddleRecognition(code);},
  generateBundle(_options,bundle){for(const item of Object.values(bundle)){if(item.type==="asset"&&item.fileName.endsWith(".js"))item.source=batchPaddleRecognition(typeof item.source==="string"?item.source:new TextDecoder().decode(item.source));else if(item.type==="chunk")item.code=batchPaddleRecognition(item.code);}},
  configureServer(server){server.middlewares.use((req,res,next)=>{const url=(req.url??"").split("?")[0];if(!url.includes("@paddleocr/paddleocr-js/dist/assets/worker-entry-")||!url.endsWith(".js"))return next();const file=new URL("../node_modules/"+url.split("/node_modules/")[1],import.meta.url);try{res.setHeader("Content-Type","text/javascript");res.end(batchPaddleRecognition(fs.readFileSync(file,"utf8")));}catch(error){next(error);}});}
 };
}
