import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/gameTextProject.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm",
  define: { "import.meta.env.VITE_API_BASE": '""' },
});
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hostname: "localhost" } };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
const { importGameText, gameTextProblem } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const entry = (id, source, translation = "") => ({ id, source, translation, error: "", selected: true });
const run = (entries, dictionary, mode = "replace") => importGameText(entries, JSON.stringify(dictionary), false, mode);

const sample180 = "\\F[dungeon03]懐かしいわね、全てはこんな形をしていたはずなのに……\nこの空も周りの景色も、全部幻だなんて笑える話だわ";
const firstLine = "懐かしいわね、全てはこんな形をしていたはずなのに……";
const secondLine = "この空も周りの景色も、全部幻だなんて笑える話だわ";
const face = run([entry("180", sample180)], { [firstLine]: "真令人怀念啊……", [secondLine]: "这一切都是幻象。" });
assert.equal(face.entries[0].translation, "\\F[dungeon03]真令人怀念啊……\n这一切都是幻象。");
const alternate = run([entry("180", sample180)], {
  [firstLine + "\n" + secondLine]: "怀念过去……\n原来都是幻象。",
  [firstLine]: "真令人怀念啊……", [secondLine]: "这一切都是幻象。",
});
assert.equal(alternate.audit.fileUsed, 1);
assert.equal(alternate.audit.fileUnused, 2);
assert.equal(alternate.unmatched, 0);
assert.equal(alternate.audit.details.filter(row => row.status === "备选未使用").length, 2);

const parameters = [
  entry("1", "%1が出現！"),
  entry("2", "%1 の%2を得た"),
  entry("3", "%1\\G 手に入れた！"),
  entry("4", "\\P[1]が戻ってきた\nまた会いましょう"),
  entry("5", "\\c[1]こんにちは\\c[0]、\\N[2]さん"),
];
const snapshot = JSON.stringify(parameters);
const dict = { "が出現！": "出现了！", "の": "的", "を得た": "已获得", "手に入れた！": "获得了！", "が戻ってきた\nまた会いましょう": "回来了\n再会吧", "こんにちは": "你好", "、": "，", "さん": "先生" };
const result = run(parameters, dict);
assert.deepEqual(result.entries.map(row => row.translation), ["%1出现了！", "%1 的%2已获得", "%1\\G 获得了！", "\\P[1]回来了\n再会吧", "\\c[1]你好\\c[0]、\\N[2]先生"]);
assert.equal(result.issues.length, 0);
assert.equal(result.fragmentMatched, 5);
assert.equal(JSON.stringify(parameters), snapshot);
for (const row of result.entries) assert.equal(gameTextProblem(row.source, row.translation), "");
assert.equal(run(result.entries, dict, "fill").audit.fileUsed, result.audit.fileUsed);

const missing = run([entry("1", "%1が出現！"), entry("2", "\\P[1]こんにちは\n未登録の文章")], { "が出現！": "出现了！", "こんにちは": "你好" });
assert.equal(missing.entries[0].translation, "%1出现了！");
assert.equal(missing.entries[1].translation, "");
assert.deepEqual(missing.issues[0].missingLines, ["未登録の文章"]);
const speaker = run([entry("1", "\\nc<リナ>こんにちは")], { "こんにちは": "你好" });
assert.equal(speaker.changed, 0, "do not silently preserve untranslated speaker names");
const collision = run([entry("1", "%1が出現！")], { " が出現！": "出现了！", "が出現！ ": "现身了！" });
assert.equal(collision.changed, 0);
assert.match(collision.issues[0].reason, /不同译文/);
const invalid = run([entry("1", "%1が出現！"), entry("2", "待って！", "原译")], { "が出現！": "出现了！", "待って！": "！！！" });
assert.equal(invalid.changed, 1);
assert.equal(invalid.entries[1].translation, "原译");
assert.equal(invalid.issues.length, 1);
const width = run([entry("TP", "TP")], { "ＴＰ": "TP" });
assert.equal(width.entries[0].translation, "TP");
assert.equal(width.audit.fileUsed, 1);
const widthConflict = run([entry("1", "ABC")], { "ＡＢＣ": "甲", "AＢＣ": "乙" });
assert.equal(widthConflict.changed, 0);
assert.match(widthConflict.issues[0].reason, /不同译文/);
const injected = run([entry("1", "%1が出現！")], { "が出現！": "%2出现了！" });
assert.equal(injected.changed, 0, "reject added parameters");
const csv = importGameText([entry("1", "こんにちは"), entry("2", "待って！")], "id,source,translation\n1,こんにちは,你好\n2,待って！,！！！", true, "replace");
assert.equal(csv.changed, 1);
assert.equal(csv.issues.length, 1);
const picnic = "『PICNIC』\n難易度が低く、ゲーム慣れしていない人でも気軽に楽しめるモードです";
const prompt = "このモードで始めますか？";
const picnicResult = run([entry("1209", picnic + "\n" + prompt)], { [picnic]: "『PICNIC』\n这是低难度模式", [prompt]: "要以此模式开始吗？" });
assert.equal(picnicResult.entries[0].translation, "『PICNIC』\n这是低难度模式\n要以此模式开始吗？");
const partition = run([entry("1", "一行目\n二行目\n三行目")], { "一行目\n二行目": "甲\n乙", "一行目": "甲", "二行目\n三行目": "乙\n丙" });
assert.equal(partition.entries[0].translation, "甲\n乙\n丙", "choose a complete partition rather than a dead-end longer prefix");
const backtrack = run([entry("1", "一行目\n二行目\n三行目")], { "一行目\n二行目": "甲乙", "一行目": "甲", "二行目\n三行目": "乙丙" });
assert.equal(backtrack.entries[0].translation, "甲\n乙丙", "backtrack when the longest block leaves an unmatched suffix");
const groupedFile = { "こんにちは\nまたね": "你好\n再见" };
const splitScan = run([entry("1", "こんにちは"), entry("2", "またね")], groupedFile);
assert.deepEqual(splitScan.entries.map(row => row.translation), ["你好", "再见"]);
assert.equal(splitScan.audit.fileUsed, 1);
const partialFile = run([entry("1", "こんにちは")], groupedFile);
assert.equal(partialFile.audit.filePartiallyUsed, 1);
assert.equal(partialFile.audit.fileUsed, 0);
assert.deepEqual(partialFile.audit.details[0].usedLines, [1]);
const uneven = run([entry("1", "こんにちは")], { "こんにちは\nまたね": "你好，再见" });
assert.equal(uneven.changed, 0);
assert.equal(uneven.audit.details[0].lineSplit.available, false);
const explicitLine = run([entry("1", "こんにちは")], { ...groupedFile, "こんにちは": "您好" });
assert.equal(explicitLine.entries[0].translation, "您好");
const crlf = run([entry("1", "一行目\r\n二行目\r\n三行目")], { "一行目\n二行目": "甲\n乙", "三行目": "丙" });
assert.equal(crlf.entries[0].translation, "甲\n乙\r\n丙");
const nightmare = "『NIGHTMARE』\n\\C[14]非常に高い難易度です\\C[0]\n敗北するほどクリアが難しくなります";
const nightmareResult = run([entry("1208", nightmare)], { "非常に高い難易度です": "这是极高难度", "敗北するほどクリアが難しくなります": "失败越多，通关越困难" });
assert.equal(nightmareResult.entries[0].translation, "『NIGHTMARE』\n\\C[14]这是极高难度\\C[0]\n失败越多，通关越困难");
assert.deepEqual(nightmareResult.audit.retainedFragments, [{ id: "1208", fragments: ["NIGHTMARE"] }]);
for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["【", "】"], ["「", "」"]]) {
  const source = "剣で与えたダメージが少し性感になって返ってくる\n" + open + "性感反動率+5%" + close;
  const value = run([entry("rate", source)], { "剣で与えたダメージが少し性感になって返ってくる": "剑造成的伤害有少量反弹", "性感反動率+5%": "反弹率+5%" });
  assert.equal(value.entries[0].translation, "剑造成的伤害有少量反弹\n" + open + "反弹率+5%" + close);
  assert.equal(gameTextProblem(source, value.entries[0].translation), "");
}
const missingStyle = run([entry("style", "\\C[14]非常に高い難易度です\\C[0]")], { "\\C[14]非常に高い難易度です\\C[0]": "这是极高难度" });
assert.equal(missingStyle.entries[0].translation, "\\C[14]这是极高难度\\C[0]");
assert.equal(missingStyle.audit.displayControlsRestored, 1);
const changedStyle = run([entry("style", "\\C[14]非常に高い難易度です\\C[0]")], { "\\C[14]非常に高い難易度です\\C[0]": "\\C[3]这是极高难度\\C[0]" });
assert.equal(changedStyle.changed, 0, "do not overwrite conflicting supplied controls");
const missingParameter = run([entry("param", "%1が出現！")], { "%1が出現！": "出现了！" });
assert.equal(missingParameter.changed, 0, "missing dynamic parameters still require validation");
const englishSource = importGameText([entry("en", "NIGHTMARE\nこんにちは")], JSON.stringify({ "こんにちは": "你好" }), false, "replace", false, "en");
assert.equal(englishSource.changed, 0, "do not retain untranslated English when English is the source language");
const controlFile = { "こんにちは\\C[2]またね": "你好\\C[2]再见" };
const splitControl = run([entry("1", "こんにちは"), entry("2", "またね")], controlFile);
assert.deepEqual(splitControl.entries.map(row => row.translation), ["你好", "再见"]);
assert.equal(splitControl.audit.fileUsed, 1);
const partialControl = run([entry("1", "こんにちは")], controlFile);
assert.equal(partialControl.audit.filePartiallyUsed, 1);
assert.equal(partialControl.audit.details[0].usedParts[0].text, "こんにちは");
const edgeAlias = run([entry("1", "こんにちは")], { "\\C[1]こんにちは\\C[0]": "你好" });
assert.equal(edgeAlias.entries[0].translation, "你好");
assert.equal(edgeAlias.audit.fileUsed, 1);
const actualPlaceholder = run([entry("1", "こんにちは{name}")], { "こんにちは": "你好" });
assert.equal(actualPlaceholder.entries[0].translation, "你好{name}");
assert.ok(gameTextProblem("こんにちは{name}", "你好{other}"));
assert.ok(gameTextProblem("こんにちは", '{"translation":""}'));
console.log("PASS game text import: face controls, parameters, literal fragments, multi-line blocks, missing fragments, ambiguity, partial validation and provenance");
