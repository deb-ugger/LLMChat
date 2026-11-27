import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { hostname: "localhost" } };
const result = await build({
  stdin: { contents: `export * as presets from './gameModelPreset'; export * as prompts from './gamePrompts'; export {gameDefaultTextModel} from './gameModelPerformance';`, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
});
const { presets, prompts, gameDefaultTextModel } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
const current = {
  text: { options: { source: "en", target: "en", kind: "engine", joinLines: true, wrapMode: "join", lineMode: "model", onlySourceLanguage: false, skipTargetLanguage: false, engines: [] }, roles: {} },
  images: { options: { mode: "english", concurrency: 1, strategy: "full", translation: { source: "en", target: "en", kind: "engine", provider: "bing", engines: [] } }, roles: {} },
  detectedSource: "en",
};
const original = JSON.stringify(current);
const all = presets.builtinGameTestConfigurations(current);
assert.equal(all.length, 3);
assert.equal(new Set(all.map(row => row.id)).size, 3);
for (const preset of all) {
  assert.equal(preset.value.text.options.wrapMode, "natural");
  assert.equal(preset.value.text.options.joinLines, true);
  assert.equal(preset.value.text.options.lineMode, "local");
  assert.equal(preset.value.text.options.lineModel, undefined);
}
assert.equal(JSON.stringify(current), original);
const textScenes = ["textScreen", "text", "dialogue", "names", "line"];
const imageScenes = ["screen", "refine", "recognize", "image", "review", "layout"];
const catalog = prompts.gamePromptCatalog();
assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length);
for (const r18 of [false, true]) {
  const id = r18 ? presets.JAPANESE_R18_GAME_TEST_CONFIGURATION_ID : presets.JAPANESE_GAME_TEST_CONFIGURATION_ID;
  const value = all.find(row => row.id === id).value;
  for (const options of [value.text.options, value.images.options.translation]) {
    assert.equal(options.source, "ja"); assert.equal(options.target, "zh-CN");
    assert.equal(options.onlySourceLanguage, true); assert.equal(options.skipTargetLanguage, true);
  }
  assert.equal(value.detectedSource, "ja");
  assert.equal(value.images.options.mode, "manga");
  assert.equal(value.images.options.refine.method, "local");
  assert.equal(value.text.roles.text.concurrency, gameDefaultTextModel.concurrency);
  assert.equal(value.text.roles.dialogue.concurrency, gameDefaultTextModel.concurrency);
  assert.equal(value.text.roles.names.concurrency, 1);
  assert.equal(value.images.roles.image.concurrency, gameDefaultTextModel.concurrency);
  assert.equal(value.images.roles.recognize.concurrency, 2);
  for (const [part, scenes] of [[value.text, textScenes], [value.images, imageScenes]]) {
    for (const scene of scenes) {
      const role = part.roles[scene]; assert.ok(role, `missing ${scene}`);
      assert.equal(role.prompt, prompts.gameJapanesePromptId(scene, r18));
      const prompt = catalog.find(item => item.id === role.prompt);
      assert.equal(prompt.scene, scene); assert.ok(prompt.name.includes("日语"));
      assert.equal(prompt.tags.includes("R18"), r18);
      assert.ok(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prompt.prompt));
      if (r18) assert.ok(prompt.prompt.includes("R18"));
      const text = prompts.gameTaskPrompt(scene, { [scene]: role.prompt }, { source: "ja", target: "简体中文" });
      if (["text", "dialogue", "names", "image", "review"].includes(scene)) assert.ok(text.includes(prompts.GAME_STRUCTURE_PROMPT));
      if (["line", "layout"].includes(scene)) assert.ok(text.includes(prompts.GAME_LAYOUT_STRUCTURE_PROMPT));
      if (["textScreen", "screen", "refine", "recognize"].includes(scene)) assert.ok(!text.includes("只翻译当前正文"), "detection tasks must not inherit translation instructions");
    }
  }
}
assert.equal(presets.builtinGameTestConfigurations({ text: current.text }).find(row => row.id === presets.JAPANESE_R18_GAME_TEST_CONFIGURATION_ID).value.images, undefined);

const user = structuredClone(all.find(row => row.id === presets.JAPANESE_GAME_TEST_CONFIGURATION_ID));
user.id = "user-ja"; user.name = "我的日语配置";
user.value.text.roles.text = { model: "my-model", prompt: "builtin:text", concurrency: 3 };
user.value.text.roles.dialogue.prompt = "custom:dialogue";
user.value.images.roles.image = { model: "my-image-model", prompt: "builtin:image", concurrency: 2 };
delete user.value.text.roles.names;
const adult = structuredClone(user); adult.id = "user-ja-r18"; adult.name = "日语 R18";
const english = { id: "en-custom", name: "英语配置", value: structuredClone(current) };
presets.saveGameTestConfigurations("project", [user, adult, english]);
const snapshot = JSON.stringify(english);
presets.refreshSavedGameTestConfigurations();
const migrated = presets.readGameTestConfigurations("project");
const japanese = migrated.find(row => row.id === user.id);
assert.equal(japanese.value.text.roles.text.prompt, prompts.gameJapanesePromptId("text"));
assert.equal(japanese.value.text.roles.text.model, "my-model");
assert.equal(japanese.value.text.roles.text.concurrency, 3);
assert.equal(japanese.value.text.roles.dialogue.prompt, "custom:dialogue");
assert.equal(japanese.value.text.roles.names.prompt, prompts.gameJapanesePromptId("names"));
assert.equal(japanese.value.images.roles.image.prompt, prompts.gameJapanesePromptId("image"));
assert.equal(japanese.value.images.roles.image.model, "my-image-model");
assert.equal(migrated.find(row => row.id === adult.id).value.text.roles.text.prompt, prompts.gameJapanesePromptId("text", true));
assert.equal(JSON.stringify(migrated.find(row => row.id === english.id)), snapshot);
const migratedOnce = JSON.stringify(migrated);
presets.refreshSavedGameTestConfigurations();
assert.equal(JSON.stringify(presets.readGameTestConfigurations("project")), migratedOnce);

const applied = [];
presets.applyGameTestRoles(all.find(row => row.id === presets.JAPANESE_R18_GAME_TEST_CONFIGURATION_ID).value.text.roles, { scope: "test:text", select: (scene, prompt) => applied.push([scene, prompt]) });
assert.equal(applied.length, textScenes.length);
assert.ok(applied.every(([scene, prompt]) => prompt === prompts.gameJapanesePromptId(scene, true)));
console.log("PASS Japanese and R18 built-ins: all scene bindings, Japanese prompts, structure rules, models/concurrency, missing steps, source-language options, saved configuration refresh and role application");

storage.delete("llmchat-game-test-config-natural-lines-v1");
storage.set("llmchat-game-test-config-japanese-prompts-v2", "1");
const oldDefaults = all.map(preset => {
  const saved = structuredClone(preset);
  Object.assign(saved.value.text.options, { wrapMode: "join", lineMode: "model", lineModel: "old-line-model" });
  return saved;
});
const custom = structuredClone(user);
custom.value.text.options.wrapMode = "keep";
custom.value.text.roles.text.prompt = "builtin:text";
presets.saveGameTestConfigurations("migration", [...oldDefaults, custom]);
const customBefore = JSON.stringify(presets.readGameTestConfigurations("migration").find(row => row.id === custom.id));
presets.refreshSavedGameTestConfigurations();
const updated = presets.readGameTestConfigurations("migration");
for (const preset of updated.filter(row => row.id.startsWith("builtin:"))) {
  assert.equal(preset.value.text.options.wrapMode, "natural");
  assert.equal(preset.value.text.options.lineModel, undefined);
}
assert.equal(JSON.stringify(updated.find(row => row.id === custom.id)), customBefore, "refresh saved defaults while retaining custom wrap settings and prompts");
console.log("PASS all default configurations use integrated natural wrapping and saved defaults update without changing custom configurations");
