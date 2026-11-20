import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const queueSource = readFileSync(new URL("../src/speech/queue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(queueSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\s*/gm, "").replace(/^export /gm, "");

const job = {
  id: "replay", folder: "replay", offset: 60, cueCount: 2,
  source: { path: "test.wav", name: "test.wav", duration: 60, size: 10, modified: 1 },
  options: { model: "local", language: "auto", chineseScript: "original", formats: ["srt"] },
};
const missingProgress = { folder: "missing-progress", name: "缺进度", loadError: "进度文件缺失", canClean: true };
const brokenMetadata = { folder: "invalid", name: "坏任务文件", loadError: "任务文件无效", canClean: false };
const outputError = "字幕输出修复失败：文件被占用";
let cleanupAttempts = 0;
let canWriteOutput = false;
const native = {
  list: async () => [
    { ...job, id: "complete", folder: "complete" },
    { ...job, recoveryError: outputError },
    missingProgress, brokenMetadata,
  ],
  resume: async () => {
    if (!canWriteOutput) throw new Error(outputError);
    return job;
  },
  saveElapsed: async () => 0,
  cancel: async (folder: string) => {
    assert.equal(folder, missingProgress.folder, "unreadable job manifests cannot be used for cleanup");
    if (++cleanupAttempts === 1) throw new Error("任务文件被占用");
  },
};
const unexpected = () => assert.fail("output-only repair must not start recognition");
class Client {
  release() {}
}
const names = ["useSyncExternalStore", "SpeechClient", "speechNative", "getSpeechPreferences", "downloadSpeechModel",
  "cancelSpeechModelDownload", "setSpeechModelInUse", "refreshSpeechModels", "planSpeechCommit", "nextSpeechWindow",
  "validateSpeechRanges", "createSpeechOnline", "writeOutput"];
const noop = () => {};
const SpeechQueue = new Function(...names, compiled + "\nreturn SpeechQueue;")(
  noop, Client, native, () => ({ concurrency: 1 }), unexpected,
  noop, noop, noop, unexpected, unexpected, unexpected, unexpected, noop,
);
const queue = new SpeechQueue();
await queue.restore("fixture");
await queue.restore("fixture");
const item = (id: string) => queue.snapshot().items.find((candidate: typeof job) => candidate.id === id);
assert.equal(item("complete").status, "done");
assert.equal(item("replay").status, "paused", "a final checkpoint with bad output stays in the unfinished queue");
assert.equal(item("replay").message, outputError);
assert.equal(queue.snapshot().brokenJobs.length, 2, "broken records stay visible and don't duplicate on restore");

const waitForStatus = async (status: string) => {
  for (let attempt = 0; attempt < 100 && item("replay").status !== status; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(item("replay").status, status);
};
queue.start("replay");
await waitForStatus("error");
assert.equal(item("replay").message, outputError);
canWriteOutput = true;
queue.start("replay");
await waitForStatus("done");
assert.equal(item("replay").recoveryError, undefined);

await queue.cleanBroken(brokenMetadata.folder);
assert.equal(cleanupAttempts, 0);
await queue.cleanBroken(missingProgress.folder);
assert.match(queue.snapshot().brokenJobs.find((candidate: typeof missingProgress) => candidate.folder === missingProgress.folder).loadError, /任务文件被占用/);
await queue.cleanBroken(missingProgress.folder);
assert.equal(cleanupAttempts, 2);
assert.deepEqual(queue.snapshot().brokenJobs, [brokenMetadata]);
console.log("Speech queue recovery behavior passed.");

const backend = spawnSync("cargo", ["test", "--locked", "--offline", "--lib", "speech::tests::job_recovery_"], {
  cwd: new URL("../src-tauri/", import.meta.url),
  stdio: "inherit",
});
if (backend.error) throw backend.error;
process.exitCode = backend.status ?? 1;
