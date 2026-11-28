import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
Error.stackTraceLimit = 0;
globalThis.localStorage = { getItem: () => null };
globalThis.window = { location: { hostname: "localhost" } };
const bundle = await build({ stdin: { contents: `export * as display from './gameDisplayText'; export * as params from './gameTextParameters'; export * as semantics from './gameTextSemantics'; export * as review from './gameTextReview'; export * as project from './gameTextProject'; export * as context from './gameTranslationContext'; export * as prompts from './gamePrompts';`, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "esm", define: { "import.meta.env.VITE_API_BASE": '""' } });
const { display, params, semantics, review, project, context, prompts } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const source = String.raw`\C[2]\P[1]は本を開いた。`;
let calls = 0;
assert.equal(await display.translateGameDisplayText(source, async (input, reference) => {
  calls++; assert.match(input, /^\{LLMCHAT_FORMAT_1\}/); assert.match(reference, /队伍成员姓名/);
  assert.ok(!input.includes("FORMAT_0"), "presentation prefix is still restored locally");
  return input.replace("は本を開いた。", "打开了书。");
}, "zh-CN", "ja"), String.raw`\C[2]\P[1]打开了书。`);
assert.equal(calls, 1);
assert.match(params.gameSystemMessageContext("obtainExp"), /%1 表示获得的经验数量/);
assert.match(params.gameSystemMessageContext("actorDrain"), /%3 表示被吸取的数量/);
for (const [message, source, translated] of [
  ["obtainExp", "%1 の%2を得た", "获得了%1点%2"],
  ["actorDrain", "%1は%2を%3奪われた！", "%1被吸取了%3点%2！"],
  ["actorRecovery", "%1の%2が%3回復した！", "%1恢复了%3点%2！"],
]) { assert.equal(display.translateRpgSystemMessage({source, rpgSystemMessage:message}, "zh-CN"), translated); assert.equal(project.gameTextProblem(source, translated), ""); }
assert.equal(params.knownGameSystemTranslation({ source: "%1は別のことをした", rpgSystemMessage: "obtainExp" }, "zh-CN"), undefined, "custom system wording is not replaced by a field-name-only template");
const row = (id, source, translation) => ({ id, source, translation, selected: true, error: "", translationTarget: "zh-CN" });
const rows = [row("1", String.raw`\P[1]は本を開いた。`, String.raw`\P[1]她打开了书。`), row("2", "こちらを見た。", "看见了我。"), row("3", "魔力が50増えた。", "魔力增加了5。"), row("4", "できない", "可以"), row("5", "普通の文", "普通的句子")];
assert.ok(semantics.gameTextSemanticIssues(rows[0], "zh-CN").some(issue => issue.code === "subject"));
assert.ok(semantics.gameTextSemanticIssues(rows[1], "zh-CN").some(issue => issue.code === "perspective"));
let requests = 0, persisted = 0;
const result = await review.reviewGameText(rows, { target: "zh-CN", terms: [], signal: new AbortController().signal,
  request: async items => { requests++; assert.equal(items.length, 4, "only risk entries go to review"); return items.map(({id,entry}) => ({id,verdict:entry.id === "2" ? "uncertain" : "revise",reason:"核对当前原文",translation:entry.id === "1" ? String.raw`\P[1]打开了书。` : entry.id === "3" ? "魔力增加了50。" : "不可以"})); },
  validate: project.gameTextProblem, persist: async () => { persisted++; },
});
assert.deepEqual(result, {total:4,changed:3,unresolved:1}); assert.equal(requests,1); assert.equal(persisted,4);
assert.equal(rows[1].translation,"看见了我。"); assert.equal(rows[1].semanticReview.state,"uncertain");
assert.equal(rows[0].semanticReview.previous,String.raw`\P[1]她打开了书。`);
assert.equal(semantics.outstandingGameSemanticIssues(rows[0],"zh-CN").length,0);
const malformed = row("bad", "こちらを見た。", "看见了我。");
await review.reviewGameText([malformed], { target:"zh-CN", terms:[], signal:new AbortController().signal, request:async()=>[{id:8,verdict:"keep",reason:"ok"}],validate:project.gameTextProblem,persist:async()=>{} });
assert.equal(malformed.translation,"看见了我。"); assert.equal(malformed.semanticReview.state,"failed");
const broken = row("control", String.raw`\P[1]は見た。`, String.raw`\P[1]她看见了。`);
await review.reviewGameText([broken], {target:"zh-CN",terms:[],signal:new AbortController().signal,request:async()=>[{id:0,verdict:"revise",reason:"修订",translation:"看见了。"}],validate:project.gameTextProblem,persist:async()=>{}});
assert.equal(broken.translation,String.raw`\P[1]她看见了。`); assert.equal(broken.semanticReview.state,"failed");
const aborted = new AbortController();
await assert.rejects(review.reviewGameText([malformed], {target:"zh-CN",terms:[],signal:aborted.signal,request:async()=>{aborted.abort();return[];},validate:project.gameTextProblem,persist:async()=>{throw Error("must not persist after abort");}}), /abort/i);
for (const preset of prompts.BUILTIN_GAME_PROMPTS.filter(row => row.scene === "textReview")) { assert.match(preset.prompt,/JSON/); assert.ok(!preset.prompt.includes(prompts.GAME_STRUCTURE_PROMPT),"review JSON protocol must not be contradicted by translation-only output rule"); }
assert.match(context.createGameTranslationContext([],false)({ ...rows[0],rpgSystemMessage:"actorDrain"},undefined,"参数上下文").map(item=>item.source).join("\n"),/被吸取的数量/);
console.log("PASS semantic parameters, verified system templates, risk-only batched review, safe uncertainty, invalid responses, control validation and cancellation");
