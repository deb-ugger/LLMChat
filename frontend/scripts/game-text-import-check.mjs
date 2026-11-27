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
console.log("PASS game text import: face controls, parameters, literal fragments, multi-line blocks, missing fragments, ambiguity, partial validation and provenance");
