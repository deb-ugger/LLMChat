import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  models: { type: "string", default: "qwen3.5:4b,qwen3.5:latest" },
  endpoint: { type: "string", default: "http://127.0.0.1:11434" },
  python: { type: "string", default: "E:/ComfyUI_windows_portable/python_embeded/python.exe" },
  output: { type: "string", default: "backend/build/image-layout-comparison" },
} });
const bundle = await build({
  stdin: { contents: "export * from './gameImageLayout'", resolveDir: resolve("frontend/src"), loader: "ts" },
  bundle: true, write: false, format: "esm",
});
const { imageLayoutRegions, imageLayoutPrompt, imageLayoutText } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
assert.equal(imageLayoutText(["攻击", "力", "提高"], [0]), undefined);
assert.equal(imageLayoutText(["攻击", "力", "提高"], [2, 1]), undefined);
assert.equal(imageLayoutText(["奖励", "，", "金币"], [1]), undefined);
assert.equal(imageLayoutText(["攻击力", "提高"], [1]), "攻击力\n提高");

const rows = [
  ["ロード", "读取存档", 150, 34],
  ["ゲーム設定", "游戏设置", 145, 32],
  ["攻撃力が上がる", "攻击力提高", 185, 32],
  ["HPを50回復する", "恢复50点生命值", 205, 34],
  ["クエスト完了", "任务完成", 180, 40],
  ["魔法防御力+20%", "魔法防御力+20%", 210, 32],
  ["次の目的地へ\n向かいましょう", "请前往下一个目的地", 170, 68],
  ["敵全体に炎属性の\nダメージを与える", "对全体敌人造成火属性伤害", 190, 70],
  ["毒状態を解除し、\nHPを30回復する", "解除中毒状态，恢复30点生命值", 205, 72],
  ["効果は３ターン\n持続します", "效果持续3回合", 170, 68],
  ["アイテムが不足\nしています", "所需物品不足，请先收集材料。", 190, 70],
  ["スキル「火炎斬り」を\n覚えました", "学会了技能「烈焰斩」。", 210, 72],
].map(([source, translation, width, height], index) => ({
  id: index, text: source, translation, selected: true, x0: 0, y0: 0, x1: width, y1: height,
}));
const inputs = imageLayoutRegions(rows, "zh-CN");
const schema = { type: "object", required: ["regions"], additionalProperties: false, properties: {
  regions: { type: "array", items: { type: "object", required: ["index", "breakAfter"], additionalProperties: false,
    properties: { index: { type: "integer" }, breakAfter: { type: "array", items: { type: "integer" } } } } },
} };
const report = { created: new Date().toISOString(), note: "Synthetic UI text fixtures; font-fit and format checks, not human visual scores.", runs: [] };
await mkdir(values.output, { recursive: true });
for (const model of values.models.split(",").filter(Boolean)) {
  for (let round = 1; round <= 2; round++) {
    const started = performance.now();
    const response = await fetch(values.endpoint + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: 0, format: schema,
        options: { temperature: .2, seed: 7, num_ctx: 8192, num_predict: 2048 },
        messages: [{ role: "user", content: imageLayoutPrompt(inputs) }] }),
    });
    const output = await response.json();
    if (!response.ok) throw Error(model + ": " + JSON.stringify(output));
    let result;
    try { result = JSON.parse(output.message?.content ?? ""); } catch { result = {}; }
    const parsed = inputs.map(input => {
      const matching = Array.isArray(result.regions) ? result.regions.filter(row => row.index === input.index) : [];
      const text = matching.length === 1 ? imageLayoutText(input.chunks, matching[0].breakAfter) : undefined;
      return { index: input.index, valid: text !== undefined, text: text ?? rows[input.index].translation,
        width: input.width, height: input.height, fontSize: input.fontSize };
    });
    const scored = spawnSync(values.python, ["-B", resolve("scripts/test-game-image-layout.py"), "--score"], {
      input: JSON.stringify(parsed), encoding: "utf8", windowsHide: true,
    });
    if (scored.status !== 0) throw Error(scored.stderr || scored.error?.message || "Font scoring failed");
    const fits = JSON.parse(scored.stdout);
    const fallbackRows = parsed.map((row, index) => ({ ...row,
      text: row.valid && fits[index].fit ? row.text : rows[row.index].translation }));
    const rescored = spawnSync(values.python, ["-B", resolve("scripts/test-game-image-layout.py"), "--score"], {
      input: JSON.stringify(fallbackRows), encoding: "utf8", windowsHide: true,
    });
    if (rescored.status !== 0) throw Error(rescored.stderr || "Automatic layout scoring failed");
    const finalFits = JSON.parse(rescored.stdout);
    const run = { model, round, seconds: Math.round((performance.now() - started) / 10) / 100,
      tokens: output.eval_count, inputTokens: output.prompt_eval_count, loadSeconds: (output.load_duration ?? 0) / 1e9,
      valid: parsed.filter(row => row.valid).length, fit: fits.filter((row, index) => row.fit && parsed[index].valid).length,
      automaticFallbackFit: fits.filter((row, index) => row.fit && !parsed[index].valid).length,
      finalFit: finalFits.filter(row => row.fit).length,
      fontRetention: fits.reduce((sum, row) => sum + (row.retention ?? 0), 0) / fits.length,
      regions: parsed.map((row, index) => ({ ...row, ...fits[index], final: finalFits[index] })), raw: output.message?.content };
    report.runs.push(run);
    await writeFile(resolve(values.output, "results.json"), JSON.stringify(report, null, 2));
    console.log(model + " round " + round + ": format " + run.valid + "/" + inputs.length +
      ", fit " + run.fit + "/" + inputs.length + ", final " + run.finalFit + "/" + inputs.length + ", " + run.seconds + "s");
  }
}
