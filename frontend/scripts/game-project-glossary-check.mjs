import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
Error.stackTraceLimit=0;
const bundle=await build({stdin:{contents:`export * from './gameProjectGlossary'; export {translateGameDisplayText} from './gameDisplayText'; export {clearGameTermMemory} from './gameTermMemory'; export {outstandingGameSemanticIssues} from './gameTextSemantics';`,resolveDir:fileURLToPath(new URL("../src",import.meta.url)),loader:"ts"},bundle:true,write:false,platform:"browser",format:"esm",define:{"import.meta.env.VITE_API_BASE":'""'}});
const g=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const formal=[{src:"マナポット",dst:"魔力药水",target:"zh-CN"},{src:"Potion",dst:"Potion",target:"en"}];
const merged=g.mergeGameGlossary([{src:"マナポット",dst:"魔力药剂"},{src:"skip",dst:"排除",enabled:false}],formal,"zh-CN");assert.equal(merged.length,1);assert.equal(merged[0].dst,"魔力药水");
assert.ok(g.gameProjectTermProblem({src:"A",dst:String.raw`\V[1]`,target:"zh-CN"}));
const store=new Map([["llmchat-game-terms:fixture:zh-CN",JSON.stringify({old:"旧译"})]]);globalThis.localStorage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
const before=JSON.stringify(formal);g.clearGameTermMemory("fixture","zh-CN");assert.equal(JSON.stringify(formal),before,"formal project terms are independent of disposable term memory");
assert.equal(await g.translateGameDisplayText("攻击",async()=>{throw Error("confirmed term must not be screened out as already Chinese");},"zh-CN","ja",new Map([["攻击","进攻"]])),"进攻");
const entry={id:"1",source:"マナポット",translation:"魔力药剂",selected:true,error:"",rpgTextKind:"item"};
assert.deepEqual(g.gameGlossaryCandidates([entry],"zh-CN"),[{src:"マナポット",dst:"魔力药剂",target:"zh-CN"}]);
assert.ok(g.outstandingGameSemanticIssues({...entry,semanticReview:{translation:entry.translation,target:"zh-CN",state:"checked",reason:"已确认",issues:[]}},"zh-CN",formal).some(value=>value.code==="term"));
console.log("PASS target-specific project glossary priority, explicit candidates, shared-Han terms, cache isolation and new term revalidation");

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
const root=fileURLToPath(new URL("../..",import.meta.url));
const ui=await build({stdin:{contents:`import {useState} from 'react';import {createRoot} from 'react-dom/client';import {GameProjectGlossary} from './components/GameProjectGlossary';import {GameTextEntryEditor} from './components/GameTextEntryEditor';import {editGameScene} from './gameTextScenes';
function Fixture(){const [open,setOpen]=useState(true);const [terms,setTerms]=useState([]);const [project,setProject]=useState({entries:[{id:'1',source:'大丈夫？',translation:'没事吧？',selected:true,error:'',dialoguePositions:[{page:0,line:1},{page:1,line:1}]}],dialoguePages:[{file:'Map001.json',event:1,page:0,commands:[1,3],lines:['受傷した人','大丈夫？']},{file:'CommonEvents.json',event:2,page:0,commands:[0,2],lines:['準備が終わった','大丈夫？']}]});window.fixture={terms,project};return <><button onClick={()=>setOpen(true)}>词表</button><GameTextEntryEditor project={project} entry={project.entries[0]} target="zh-CN" disabled={false} onChange={()=>{}} onSceneChange={scene=>setProject(editGameScene(project,scene))}/>{open&&<GameProjectGlossary terms={terms} entries={[{id:'2',source:'マナポット',translation:'魔力药剂',selected:true,error:'',rpgTextKind:'item'}]} target="zh-CN" onClose={()=>setOpen(false)} onSave={async values=>{setTerms(values);return true;}}/>}</>};createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:join(root,"frontend/src"),loader:"tsx"},bundle:true,write:false,outdir:"fixture",platform:"browser",format:"iife",jsx:"automatic",define:{"import.meta.env.VITE_API_BASE":'""'}});
const script=ui.outputFiles.find(value=>value.path.endsWith('.js')).text;
const base=await readFile(join(root,"frontend/src/unityOffline.css"),"utf8"),styles=ui.outputFiles.find(value=>value.path.endsWith('.css')).text;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?script:`<!doctype html><meta charset="utf-8"><style>:root{--text:#1b1a16;--panel:#fffdf9;--muted:#6a675c;--border:#dcd6c6;--line:#dcd6c6;--accent:#1b1a16;--accent-soft:#e8e2d4;--space-3:12px;--radius-lg:8px;--fs-body:14px}body{font:14px 'Segoe UI',sans-serif}input,textarea,select,button{font:inherit;box-sizing:border-box}input,textarea,select{max-width:100%} ${base}\n${styles}</style><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(join(tmpdir(),'llmchat-text-quality-check-'));let browser,socket,call;const pending=new Map();let sequence=0;
const waitFor=async work=>{const end=Date.now()+10000;while(Date.now()<end){const result=await work();if(result)return result;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('UI check timed out');};
try{
  browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  const port=await waitFor(async()=>{try{return Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{return null;}});
  const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const errors=[];socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result);});
  call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description);return result.result.value;};
  await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1000,height:850,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  await waitFor(()=>evaluate("!!document.querySelector('dialog[open]')"));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认').click()");await waitFor(()=>evaluate("document.querySelector('.game-glossary-list').textContent.includes('マナポット')"));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存词表').click()");await waitFor(()=>evaluate("window.fixture.terms.length===1&&!document.querySelector('.game-project-glossary')"));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='2 处场景').click()");await waitFor(()=>evaluate("!!document.querySelector('.game-text-scene-editor[open]')"));
  assert.match(await evaluate("document.querySelector('.game-scene-context').textContent"),/受傷/);
  await evaluate("(()=>{const el=document.querySelector('.game-text-scene-editor select');el.value='1';el.dispatchEvent(new Event('change',{bubbles:true}));})()");await waitFor(()=>evaluate("document.querySelector('.game-scene-context').textContent.includes('準備')"));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认当前译文').click()");await waitFor(()=>evaluate("window.fixture.project.sceneTranslations?.length===2"));
  assert.equal(await evaluate("window.fixture.project.sceneTranslations.filter(s=>s.contextKnown).length"),1,"manual scene confirmation materializes other unresolved locations safely");
  const screenshot=join(root,'backend/build/incremental/logs/text-quality-scene-editor.png');await mkdir(resolve(screenshot,'..'),{recursive:true});const capture=await call('Page.captureScreenshot',{format:'png'});await writeFile(screenshot,Buffer.from(capture.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:false});assert.ok(await evaluate("(()=>{const d=document.querySelector('dialog[open]'),r=d.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1})()"));
  assert.deepEqual(errors,[]);console.log('PASS browser glossary confirmation/save, independent scene switching/confirmation and narrow layout; screenshot: '+screenshot);
}finally{
  if(socket?.readyState===WebSocket.OPEN)try{await call('Browser.close');}catch{}
  socket?.close();if(browser){browser.kill();await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep)&&basename(profile).startsWith('llmchat-text-quality-check-'));await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
