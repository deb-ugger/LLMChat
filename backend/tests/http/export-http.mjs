import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";

const [executable, scratch] = process.argv.slice(2);
assert.ok(executable && scratch, "Usage: node export-http.mjs BACKEND_EXE NEW_FIXTURE_DIRECTORY");
const root = path.resolve(scratch);
fs.mkdirSync(root);
const state = path.join(root, "backend-state");
fs.mkdirSync(state);
const sum = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = file => sum(fs.readFileSync(file));
const prefix = "/api/game-image-exports";
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

async function portForTest() {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
    assert.notEqual(port, 17800);
    return port;
}

const port = await portForTest();
fs.writeFileSync(path.join(state, "config.ini"), "[server]\nport=" + port + "\n");
const child = spawn(path.resolve(executable), [state], { cwd: state, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", bytes => log += bytes);
child.stderr.on("data", bytes => log += bytes);
const exited = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
});
const origin = "http://127.0.0.1:1420";
async function request(method, route, input, binary = false) {
    const body = binary ? input : input === undefined ? undefined : JSON.stringify(input);
    const res = await fetch("http://127.0.0.1:" + port + route, {
        method, body, headers: { Origin: origin, ...(body ? { "Content-Type": binary ? "image/png" : "application/json" } : {}) },
        signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    const raw = await res.text();
    return { status: res.status, value: raw ? JSON.parse(raw) : null };
}

const post = (route, input) => request("POST", prefix + route, input);
const get = (route) => request("GET", prefix + route);
function expectError(res, status, code) {
    assert.equal(res.status, status, JSON.stringify(res.value));
    assert.equal(res.value.ok, false);
    assert.equal(res.value.error.code, code);
    assert.ok(res.value.error.message);
}
async function completed(submit, operation, expectedError = null) {
    assert.equal(submit.status, 202, JSON.stringify(submit.value));
    assert.deepEqual(Object.keys(submit.value).sort(), ["operationId", "state"]);
    assert.equal(submit.value.state, "queued");
    for (let i = 0; i < 200; i++) {
        const status = await get("/operations/" + submit.value.operationId);
        assert.equal(status.status, 200);
        const response = status.value;
        assert.deepEqual(Object.keys(response).sort(), ["error", "lastSeq", "operationId", "progress", "result", "state"]);
        assert.equal(response.operationId, submit.value.operationId);
        assert.ok(Number.isInteger(response.lastSeq));
        if (response.state === "failed" && expectedError) {
            assert.equal(response.result, null);
            assert.equal(response.error.code, expectedError);
            return response.error;
        }
        if (response.state === "succeeded") {
            assert.equal(expectedError, null);
            assert.equal(response.error, null);
            if (operation === "generate") assert.equal(response.progress.phase, "publish");
            return response.result;
        }
        assert.ok(["queued", "running"].includes(response.state), JSON.stringify(response));
        await sleep(20);
    }
    throw new Error("timed out waiting for " + operation);
}

function png(color) {
    const chunk = (name, bytes) => {
        const coded = Buffer.concat([Buffer.from(name), bytes]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(coded));
        return Buffer.concat([length, coded, crc]);
    };
    const size = Buffer.alloc(13);
    size.writeUInt32BE(2);
    size.writeUInt32BE(1, 4);
    size[8] = 8;
    size[9] = 6;
    const pixels = Buffer.from([0, color, 12, 52, 255, 28, 31, 99, 255]);
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", size),
        chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

function tree(directory) {
    const values = {};
    for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
        const item = path.join(entry.parentPath, entry.name);
        const name = path.relative(directory, item).replaceAll("\\", "/");
        values[name] = entry.isDirectory() ? "directory" : sha(item);
    }
    return values;
}

async function fixture(name, layer = "mosaic") {
    const gamePath = path.join(root, name + "-game");
    const outputDir = path.join(root, name + "-output");
    fs.mkdirSync(path.join(gamePath, "Data", "Picture"), { recursive: true });
    fs.mkdirSync(path.join(gamePath, "Data", "BasicData"), { recursive: true });
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(gamePath, "Data/BasicData/Game.dat"), "WOLF export route fixture");
    const relativePath = "Data/Picture/test.png";
    const original = png(12);
    const candidate = png(242);
    const target = path.join(gamePath, relativePath);
    fs.writeFileSync(target, original);
    const scan = await request("POST", "/api/game-images/scan", { gamePath });
    assert.equal(scan.status, 200, JSON.stringify(scan.value));
    const row = scan.value.images.find(image => image.file === relativePath);
    assert.ok(row, "fixture picture found by the existing scanner");
    const pngSha256 = sum(candidate);
    let candidateVersion = pngSha256;
    if (layer === "mosaic") {
        const saved = await request("POST", "/api/game-images/mosaic?" + new URLSearchParams({
            gamePath, id: row.id, sourceHash: row.sourceHash,
        }), candidate, true);
        assert.equal(saved.status, 200, JSON.stringify(saved.value));
    } else {
        const saved = await request("POST", "/api/game-images/render?" + new URLSearchParams({ gamePath, id: row.id }), candidate, true);
        assert.equal(saved.status, 200, JSON.stringify(saved.value));
        candidateVersion = saved.value.hash;
    }

    const lookup = { gamePath, imageId: row.id, layer };
    assert.equal((await post("/confirmation-status", lookup)).value.state, "needsConfirmation");
    const proposal = {
        ...lookup, sourceHash: row.sourceHash, pngSha256, candidateVersion, groupId: null, maskMode: "boxes",
        boxes: [{ id: layer === "mosaic" ? "m1" : "t1", role: layer === "mosaic" ? "repair" : "translate",
            rect: [0, 0, 1, 1], debugPath: "C:/unrelated/private.png" }],
        ...(layer === "translation" ? { renderedKind: "generated", targetLanguage: "zh-CN" } : { modelId: "2511" }),
    };
    const snapshotPath = path.join(gamePath, "LLMChat-JSON/images/export-inputs", row.id, layer + ".json");
    const confirmed = await post("/confirm", proposal);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
    assert.equal(confirmed.value.state, "confirmed");
    if (layer === "translation") {
        // Match the workbench: the candidate is written and confirmed before the edited project row is finalized.
        const save = await request("POST", "/api/game-images/save", {
            gamePath, image: { ...row, selected: true, completed: true, renderedKind: "generated", renderedTarget: "zh-CN" },
        });
        assert.equal(save.status, 200, JSON.stringify(save.value));
    }

    const snapshotBytes = fs.readFileSync(snapshotPath);
    const snapshot = JSON.parse(snapshotBytes);
    assert.equal(snapshot.recordVersion, 1);
    assert.equal(snapshot.sourceSha256, sum(original));
    assert.equal(snapshot.pngSha256, sum(candidate));
    assert.equal(snapshot.candidateVersion, candidateVersion);
    assert.match(snapshot.confirmationId, /^[0-9a-f-]{36}$/);
    assert.match(snapshot.confirmationGameRootFingerprint, /^[a-f0-9]{64}$/);
    assert.match(snapshot.gameRootFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(snapshot.boxes[0]).sort(), ["id", "rect", "role"]);
    for (let i = 0; i < 2; i++) {
        const repeat = await post("/confirm", proposal);
        assert.deepEqual(repeat, confirmed);
        assert.deepEqual(fs.readFileSync(snapshotPath), snapshotBytes);
    }
    const status = await post("/confirmation-status", lookup);
    assert.deepEqual(status, confirmed);
    const { confirmationId } = confirmed.value;
    const selected = layer === "mosaic" ? { mosaic: { confirmationId, pngSha256 } } :
        { translation: { confirmationId, renderedHash: candidateVersion } };
    const input = { gamePath, outputDir, images: [{ imageId: row.id, sourceHash: row.sourceHash, ...selected }] };
    return { gamePath, outputDir, snapshotPath, snapshot, snapshotBytes, lookup, relativePath, target, original, input,
        originalTree: tree(gamePath) };
}

async function waitReady() {
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error("test backend exited during startup");
        try { if ((await request("GET", "/api/health")).status === 200) return; }
        catch {}
        await sleep(40);
    }
    throw new Error("test backend did not start");
}

function transactionInput(fixture, result) {
    const manifestPath = path.join(result.packagePath, "manifest.json");
    assert.equal(result.manifestSha256, sha(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(manifest.files.length, 1);
    assert.equal(result.files, 1);
    assert.equal(manifest.confirmationGameRootFingerprint, fixture.snapshot.confirmationGameRootFingerprint);
    assert.equal(manifest.gameRootFingerprint, fixture.snapshot.gameRootFingerprint);
    const payload = path.join(result.packagePath, "payload", fixture.relativePath);
    assert.equal(sha(payload), manifest.files[0].sha256);
    return { body: { gamePath: fixture.gamePath, packagePath: result.packagePath }, payload, manifestPath, manifest,
        patchedTree: { ...fixture.originalTree, [fixture.relativePath]: sha(payload) } };
}

try {
    await waitReady();
    console.log("Temporary backend port:", port);
    const first = await fixture("one");
    const second = await fixture("two", "translation");
    console.log("PASS T081 A three byte-identical confirmations for translation and mosaic");
    expectError(await post("/generate", { ...first.input, images: [] }), 400, "INVALID_REQUEST");
    const { recordVersion, sourceSha256, ...legacy } = first.snapshot;
    writeJson(first.snapshotPath, legacy);
    const old = await post("/confirmation-status", first.lookup);
    assert.equal(old.status, 200);
    assert.equal(old.value.state, "needsConfirmation");
    assert.match(old.value.message, /重新确认/);
    expectError(await post("/generate", first.input), 400, "CONFIRMATION_REQUIRED");
    console.log("PASS T081 B legacy confirmation requires reconfirmation and cannot generate");
    fs.unlinkSync(first.snapshotPath);
    expectError(await post("/generate", first.input), 400, "CONFIRMATION_REQUIRED");
    writeJson(first.snapshotPath, { ...first.snapshot, candidateVersion: "changed" });
    expectError(await post("/generate", first.input), 400, "INPUT_STALE");
    fs.writeFileSync(first.snapshotPath, first.snapshotBytes);
    assert.deepEqual(tree(first.gamePath), first.originalTree);
    assert.equal(fs.readdirSync(first.outputDir).length, 0);

    const generatedFirst = await completed(await post("/generate", first.input), "generate");
    const generatedSecond = await completed(await post("/generate", second.input), "generate");
    const a = transactionInput(first, generatedFirst);
    const b = transactionInput(second, generatedSecond);
    assert.deepEqual(tree(first.gamePath), first.originalTree);
    assert.deepEqual(tree(second.gamePath), second.originalTree);
    expectError(await get("/operations/" + randomUUID()), 404, "OPERATION_NOT_FOUND");
    expectError(await get("/operations/invalid-id"), 404, "OPERATION_NOT_FOUND");
    expectError(await post("/operations/" + randomUUID() + "/cancel", {}), 404, "OPERATION_NOT_FOUND");
    const fresh = await post("/receipts/query", a.body);
    expectError(fresh, 404, "RECEIPT_NOT_FOUND");
    assert.equal(fresh.value.applied, false);
    assert.equal(fresh.value.canRestore, false);
    expectError(await post("/restore", a.body), 404, "RECEIPT_NOT_FOUND");
    console.log("PASS B generate and task/package status: two packages, invalid/missing confirmations, unknown jobs");

    for (const value of [a.body.packagePath + "/../" + path.basename(a.body.packagePath),
        first.gamePath, a.body.packagePath + ":stream"]) {
        expectError(await post("/apply", { ...a.body, packagePath: value }), 400, "INVALID_PATH");
        assert.deepEqual(tree(first.gamePath), first.originalTree);
    }
    console.log("PASS D traversal, untrusted absolute directory and ADS rejected, game tree unchanged");

    const manifestBytes = fs.readFileSync(a.manifestPath);
    writeJson(a.manifestPath, { ...a.manifest, schemaVersion: 99 });
    expectError(await post("/apply", a.body), 400, "UNSUPPORTED_SCHEMA");
    fs.writeFileSync(a.manifestPath, manifestBytes);
    fs.writeFileSync(first.target, "modified");
    const edited = tree(first.gamePath);
    expectError(await post("/apply", a.body), 409, "TARGET_CHANGED");
    assert.deepEqual(tree(first.gamePath), edited);
    fs.writeFileSync(first.target, first.original);
    assert.deepEqual(tree(first.gamePath), first.originalTree);

    const payload = fs.readFileSync(a.payload);
    const corrupted = Buffer.from(payload);
    corrupted[corrupted.length - 1] ^= 1;
    fs.writeFileSync(a.payload, corrupted);
    await completed(await post("/apply", a.body), "apply", "PAYLOAD_HASH_MISMATCH");
    assert.deepEqual(tree(first.gamePath), first.originalTree);
    fs.writeFileSync(a.payload, payload);

    const racing = await Promise.all([post("/apply", a.body), post("/apply", a.body)]);
    assert.deepEqual(racing.map(item => item.status).sort(), [202, 409]);
    assert.ok(["OPERATION_CONFLICT", "ALREADY_APPLIED"].includes(racing.find(item => item.status === 409).value.error.code));
    const receiptA = await completed(racing.find(item => item.status === 202), "apply");
    assert.equal(receiptA.state, "applied");
    assert.deepEqual(tree(first.gamePath), a.patchedTree);
    expectError(await post("/apply", a.body), 409, "ALREADY_APPLIED");
    const receiptB = await completed(await post("/apply", b.body), "apply");
    assert.equal(receiptB.state, "applied");
    assert.deepEqual(tree(second.gamePath), b.patchedTree);
    const applied = await post("/receipts/query", a.body);
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.value, { receipt: receiptA, applied: true, canRestore: true, needsRecovery: false });
    expectError(await post("/remove", { packagePath: a.body.packagePath }), 409, "PACKAGE_IN_USE");
    console.log("PASS B/C apply: two successes, manifest 400, changed target 409, duplicate 409, concurrent 202/409, queued hash failure");

    const backup = path.join(a.body.packagePath, receiptA.files[0].backupPath);
    const backupBytes = fs.readFileSync(backup);
    fs.unlinkSync(backup);
    expectError(await post("/restore", a.body), 409, "BACKUP_MISSING");
    assert.deepEqual(tree(first.gamePath), a.patchedTree);
    const noBackup = await post("/receipts/query", a.body);
    assert.equal(noBackup.status, 200);
    assert.equal(noBackup.value.applied, true);
    assert.equal(noBackup.value.canRestore, false);
    fs.writeFileSync(backup, backupBytes);
    const restored = await completed(await post("/restore", a.body), "restore");
    assert.equal(restored.state, "restored");
    assert.equal(restored.transactionId, receiptA.transactionId);
    assert.deepEqual(tree(first.gamePath), first.originalTree);
    assert.deepEqual(await completed(await post("/restore", a.body), "restore"), restored);
    const restoredStatus = await post("/receipts/query", a.body);
    assert.equal(restoredStatus.status, 200);
    assert.deepEqual(restoredStatus.value, { receipt: restored, applied: false, canRestore: false, needsRecovery: false });

    // Simulate termination before the receipt was published; the real plan and backup stay intact.
    fs.unlinkSync(path.join(b.body.packagePath, "receipts/receipt.json"));
    const pending = await post("/receipts/query", b.body);
    expectError(pending, 404, "RECEIPT_NOT_FOUND");
    assert.equal(pending.value.needsRecovery, true);
    assert.equal(pending.value.canRestore, true);
    const recovered = await completed(await post("/restore", b.body), "recover");
    assert.equal(recovered.state, "restored");
    assert.equal(recovered.transactionId, receiptB.transactionId);
    assert.deepEqual(tree(second.gamePath), second.originalTree);
    console.log("PASS B restore: normal/idempotent restore, missing backup, verified incomplete-apply recovery");

    for (const body of [a.body, b.body]) {
        const res = await post("/remove", { packagePath: body.packagePath });
        assert.deepEqual(res, { status: 204, value: null });
        assert.equal(fs.existsSync(body.packagePath), false);
        expectError(await post("/remove", { packagePath: body.packagePath }), 404, "PACKAGE_NOT_FOUND");
    }
    expectError(await post("/receipts/query", a.body), 404, "PACKAGE_NOT_FOUND");
    assert.deepEqual(tree(first.gamePath), first.originalTree);
    assert.deepEqual(tree(second.gamePath), second.originalTree);
    console.log("PASS B remove: two deletions, two not-found responses, applied package guarded");
    const editedSource = await fixture("edited-source");
    const altered = Buffer.from(editedSource.original);
    altered[altered.length - 1] ^= 1;
    fs.writeFileSync(editedSource.target, altered);
    const afterEdit = tree(editedSource.gamePath);
    const stale = await post("/confirmation-status", editedSource.lookup);
    assert.equal(stale.value.state, "needsConfirmation");
    const failure = await completed(await post("/generate", editedSource.input), "generate", "INPUT_STALE");
    assert.match(failure.message, /原图已改变|源文件内容与确认时不同/);
    assert.deepEqual(tree(editedSource.gamePath), afterEdit);
    assert.equal(fs.readdirSync(editedSource.outputDir).length, 0);
    console.log("PASS T081 C confirm/generate/apply/restore restored all hashes; edited source rejected");
    console.log("PASS T077/T081 HTTP fixtures");
} catch (error) {
    console.error(log);
    throw error;
} finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
}
