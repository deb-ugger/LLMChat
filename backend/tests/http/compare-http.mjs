import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const [baseExe, nextExe, output, manifest = new URL("./routes-baseline.json", import.meta.url)] = process.argv.slice(2);
assert.ok(baseExe && nextExe && output, "Usage: node compare-http.mjs BASELINE_EXE CANDIDATE_EXE UNUSED_OUTPUT_DIRECTORY [MANIFEST]");
const baseline = JSON.parse(fs.readFileSync(manifest, "utf8"));
const cases = [];
const allowed = ["http://localhost:1420", "http://127.0.0.1:1420", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];
const hostile = "https://foreign.invalid";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=", "base64");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const timingKeys = new Set([
    "elapsedMs", "durationMs", "loadMs", "listMs", "parseMs", "scanMs", "saveMs", "totalMs",
    "startedAt", "endedAt", "createdAt", "updatedAt", "timestamp", "time",
]);

function copyFixtures(root) {
    fs.mkdirSync(path.join(root, "rpg", "data"), { recursive: true });
    fs.mkdirSync(path.join(root, "rpg", "js"), { recursive: true });
    fs.mkdirSync(path.join(root, "rpg", "img", "pictures"), { recursive: true });
    writeJson(path.join(root, "rpg", "data", "System.json"), { gameTitle: "H1", hasEncryptedImages: false });
    fs.writeFileSync(path.join(root, "rpg", "js", "rmmz_core.js"), "// RPG Maker MZ\n");
    const file = path.join(root, "rpg", "img", "pictures", "fixture.png");
    fs.writeFileSync(file, png);
    fs.utimesSync(file, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
    fs.mkdirSync(path.join(root, "unity", "H1_Data", "Managed"), { recursive: true });
    const pe = Buffer.alloc(128);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(0x40, 0x3c);
    pe.writeUInt32LE(0x4550, 0x40);
    pe.writeUInt16LE(0x8664, 0x44);
    fs.writeFileSync(path.join(root, "unity", "H1.exe"), pe);
}

async function freePort() {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return port;
}

function makeInstance(exe, dir, port, fixture) {
    const instance = { exe: path.resolve(exe), dir: path.resolve(dir), port };
    fs.mkdirSync(instance.dir, { recursive: true });
    fs.cpSync(fixture, path.join(instance.dir, "fixtures"), { recursive: true, preserveTimestamps: true });
    for (const name of ["ocr", "projects", "resources", "temp", "webview", "exports"]) {
        fs.mkdirSync(path.join(instance.dir, name), { recursive: true });
    }
    fs.writeFileSync(path.join(instance.dir, "config.ini"), "[server]\nport=" + port + "\n");
    writeJson(path.join(instance.dir, "conversations.json"), [{
        id:"h1-known", title:"H1 fixture", createTime:"2025-01-01T00:00:00Z", messages:[{role:"user", content:"fixed fixture"}],
    }]);
    writeJson(path.join(instance.dir, "storage-paths.json"), { active: {
        data: instance.dir, ocr: path.join(instance.dir, "ocr"), projects: path.join(instance.dir, "projects"),
        unity: path.join(instance.dir, "resources"), temp: path.join(instance.dir, "temp"), webview: path.join(instance.dir, "webview"),
    } });
    return instance;
}

function start(instance) {
    const worker = spawn(instance.exe, [instance.dir], { cwd: instance.dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const log = { stdout: "", stderr: "" };
    worker.stdout.on("data", data => { log.stdout += data.toString("utf8"); });
    worker.stderr.on("data", data => { log.stderr += data.toString("utf8"); });
    const exited = new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("close", (exitCode, signal) => resolve({ exitCode, signal, ...log }));
    });
    // The caller owns this exact child, including error-driven cleanup.
    return { worker, log, exited, async stop() { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); await exited; } };
}

function request(instance, method, url, { origin = allowed[0], fetchSite, body } = {}) {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers = { Connection: "close" };
    if (origin !== null) headers.Origin = origin;
    if (fetchSite !== undefined) headers["Sec-Fetch-Site"] = fetchSite;
    if (data) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = data.length;
    }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: instance.port, method, path: url, headers, agent: false, timeout: 5000 }, res => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(method + " " + url + " timed out")));
        req.end(data);
    });
}
async function ready(instance, process) {
    for (let trial = 0; trial < 60; trial++) {
        if (process.worker.exitCode !== null) throw new Error("Exited on startup: " + (await process.exited).stderr);
        try {
            const health = await request(instance, "GET", "/api/health", { origin: null });
            if (health.status === 200 && process.log.stdout.includes("127.0.0.1:" + instance.port)) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 125));
    }
    throw new Error("Backend did not become healthy: " + process.log.stderr);
}

function normalizer(instance) {
    const replacements = new Map();
    for (const base of [instance.dir, instance.dir.replaceAll("\\", "/")]) {
        replacements.set(base, "<fixture-root>");
        replacements.set(JSON.stringify(base).slice(1, -1), "<fixture-root>");
        replacements.set(encodeURIComponent(base), "<fixture-root>");
    }
    const text = value => {
        for (const [from, to] of replacements) value = value.replaceAll(from, to);
        return value.replaceAll("127.0.0.1:" + instance.port, "127.0.0.1:<port>")
            .replace(/([\\/])tasks-\d+(?=$|[\\/"\s])/g, "$1tasks-<task-id>");
    };
    const json = (value, key) => {
        if (value === instance.port && key === "port") return "<port>";
        if (value !== null && value !== "" && (typeof value === "number" || typeof value === "string") && timingKeys.has(key)) return "<time>";
        if (typeof value === "string") return text(value);
        if (Array.isArray(value)) return value.map(item => json(item));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [text(name), json(item, name)]));
        return value;
    };
    return { text, json };
}
function snapshot(instance, response, method) {
    const normalize = normalizer(instance);
    const headers = response.rawHeaders.reduce((lines, key, i, all) => i % 2 ? lines : [...lines, [key, all[i + 1]]], []);
    const contentTypes = headers.filter(([key]) => key.toLowerCase() === "content-type").map(([, value]) => value);
    const length = headers.find(([key]) => key.toLowerCase() === "content-length");
    if (length && method !== "HEAD") assert.equal(Number(length[1]), response.body.length, "Incorrect wire Content-Length");
    let body;
    if (response.body.length && contentTypes.some(type => type.includes("application/json"))) {
        body = normalize.json(JSON.parse(response.body.toString("utf8")));
    } else if (contentTypes.some(type => type.startsWith("image/") || type.includes("application/octet-stream"))) {
        body = { bytes: response.body.length, sha256: sha(response.body) };
    } else {
        body = normalize.text(response.body.toString("utf8"));
    }
    const bodyLength = typeof body === "string" ? Buffer.byteLength(body)
        : contentTypes.some(type => type.includes("application/json")) ? Buffer.byteLength(JSON.stringify(body)) : response.body.length;
    return { status: response.status, headers: headers.map(([name,value]) => {
        if (name.toLowerCase() === "date") return [name,"<time>"];
        // Validate wire length above, then compare the length after permitted substitutions.
        if (name.toLowerCase() === "content-length" && method !== "HEAD") return [name, String(bodyLength)];
        return [name,normalize.text(value)];
    }), body };
}

function files(instance) {
    const result = new Map();
    const norm = normalizer(instance);
    function visit(dir) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, item.name);
            const name = path.relative(instance.dir, file).replaceAll("\\","/");
            if (item.isDirectory()) {
                result.set(name + "/", "directory");
                visit(file);
                continue;
            }
            if (!item.isFile()) continue;
            const bytes = fs.readFileSync(file);
            let value = bytes;
            if (/\.(?:json|ini|txt|jsonl|log)(?:\.bak)?$/i.test(name)) {
                const text = bytes.toString("utf8");
                try { value = Buffer.from(JSON.stringify(norm.json(JSON.parse(text)))); }
                catch { value = Buffer.from(norm.text(text)); }
            }
            result.set(name, sha(value));
        }
    }
    visit(instance.dir);
    return result;
}
function changes(before, after) {
    return [...new Set([...before.keys(), ...after.keys()])].sort()
        .flatMap(name => before.get(name) === after.get(name) ? [] : [[name, before.has(name) ? after.has(name) ? "changed" : "removed" : "created", after.get(name) ?? null]]);
}

const concretePatterns = {
    "/api/ocr/models/(fast|precise|english|manga)": "/api/ocr/models/precise",
    "/api/ocr/models/(precise|english|manga)": "/api/ocr/models/precise",
    "/api/runtime-assets/(.+)": "/api/runtime-assets/h1-missing.png",
    "/api/ocr/model-files/(.+)": "/api/ocr/model-files/h1-missing.onnx",
    "/api/conversations/([^/]+)": "/api/conversations/h1-missing",
    "/api/conversations/([^/]+)/messages": "/api/conversations/h1-missing/messages",
    "/api/llm/vendor-models/([^/]+)": "/api/llm/vendor-models/h1-invalid",
    "/api/llm/vendor-models/([^/]+)/refresh": "/api/llm/vendor-models/h1-invalid/refresh",
    "/api/(game-images|game-text)/model": "/api/game-images/model",
    "/api/(?:unity/)?output-log": "/api/unity/output-log",
};
// Avoid creating a timestamp-based conversation ID, external downloads and
// SQLite's process-specific shared-memory changes in these registration probes.
const deniedRoutes = new Set(["POST /api/conversations", "POST /api/ocr/models/(fast|precise|english|manga)", "DELETE /api/usage"]);
const query = (url, key, value) => url + "?" + new URLSearchParams([[key,value]]);
function specimen(route, instance) {
    let url = concretePatterns[route.pattern] ?? route.pattern;
    const body = route.method === "POST" || route.method === "PUT" ? "{" : undefined;
    const rpg = path.join(instance.dir, "fixtures", "rpg");
    const unity = path.join(instance.dir, "fixtures", "unity");
    const absent = path.join(instance.dir, "fixtures", "absent");
    const data = { url, body };
    if (deniedRoutes.has(route.method+" "+route.pattern)) data.origin = hostile;
    if (["/api/llm/ollama/directories", "/api/llm/ollama/models"].includes(url)) data.url = query(url,"directory",absent);
    if (["/api/json-embedding/patch", "/api/json-embedding/backups", "/api/game-images/mosaic", "/api/game-images/render"].includes(url)) data.url = query(url,"gamePath",absent);
    if (url === "/api/unity/detect-stream") data.body = { path: "", directOnly: false };
    if (url === "/api/unity/detect") data.body = { path: unity };
    if (url === "/api/game-images/scan") data.body = { gamePath: rpg };
    if (url === "/api/game-images/preview") data.url = url + "?" + new URLSearchParams({ gamePath:rpg, id:instance.imageId });
    if (url === "/api/export-file") data.body = { path: path.join(instance.dir,"exports","fixture.txt"), content:"H1 isolated fixture\n" };
    return data;
}

async function attempt(name, action) {
    try { cases.push({ name, passed: true, ...await action() }); }
    catch (error) { cases.push({ name, passed: false, error: error.stack }); console.error(name, error.message); }
}

async function paired(base, next, name, method, buildInput, verify) {
    return attempt(name, async () => {
        const aInput = buildInput(base), bInput = buildInput(next);
        const priorA = files(base), priorB = files(next);
        const [aRaw,bRaw] = await Promise.all([request(base,method,aInput.url,aInput), request(next,method,bInput.url,bInput)]);
        const a = snapshot(base,aRaw,method), b = snapshot(next,bRaw,method);
        const left = changes(priorA,files(base)), right = changes(priorB,files(next));
        assert.deepEqual(a,b,name+" response");
        if (a.status >= 400 && b.status >= 400) {
            assert.equal(normalizer(base).text(aRaw.body.toString("utf8")),normalizer(next).text(bRaw.body.toString("utf8")),name+" raw error");
        }
        assert.deepEqual(left,right,name+" file effects");
        verify?.(aRaw,bRaw,a);
        return { method, url:normalizer(base).text(aInput.url), status:a.status, headers:a.headers, body:a.body, sideEffects:left };
    });
}

async function occupiedPort(exe, root, fixture) {
    const command = "$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); " +
        "$listener.ExclusiveAddressUse=$true; $listener.Start(); [Console]::WriteLine($listener.LocalEndpoint.Port); " +
        "try { [Console]::ReadLine() | Out-Null } finally { $listener.Stop() }";
    const holder = spawn("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide:true, stdio:["pipe","pipe","pipe"] });
    const listenerExited = once(holder,"close");
    let tested;
    try {
        const port = await new Promise((resolve,reject) => {
            let line = "";
            const timer = setTimeout(() => reject(new Error("TcpListener did not start")),5000);
            holder.once("error", reject);
            holder.stdout.on("data", data => {
                line += data.toString();
                if (line.includes("\n")) { clearTimeout(timer); resolve(Number(line.trim())); }
            });
        });
        assert.ok(port > 0);
        tested = makeInstance(exe,root,port,fixture);
        const process = start(tested);
        const timeout = setTimeout(() => process.worker.kill(),5000);
        try {
            const failed = await process.exited;
            assert.equal(failed.exitCode,1);
            assert.ok(failed.stderr.includes("Failed to bind 127.0.0.1:" + port));
        } finally { clearTimeout(timeout); await process.stop(); }
    } finally { holder.stdin.end("\n"); await listenerExited; }
    const restarted = start(tested);
    try { await ready(tested,restarted); }
    finally { await restarted.stop(); }
    return { exitCode:1, stderr:"Failed to bind 127.0.0.1:<port>", recovered:true };
}

const root = path.resolve(output);
fs.mkdirSync(root);
const fixture = path.join(root,"template");
copyFixtures(fixture);
const base = makeInstance(baseExe,path.join(root,"base"),await freePort(),fixture);
const next = makeInstance(nextExe,path.join(root,"next"),await freePort(),fixture);
assert.notEqual(base.port,next.port);
const baseProcess = start(base), nextProcess = start(next);
try {
    await Promise.all([ready(base,baseProcess), ready(next,nextProcess)]);
    const missing = "/api/__h1_unregistered";
    for (const route of baseline.routes.filter(item => item.method !== "OPTIONS")) {
        await paired(base,next,route.method+" "+route.pattern,route.method, instance => {
            const input = specimen(route,instance);
            const actual = new URL(input.url, "http://127.0.0.1").pathname;
            const matched = baseline.routes.find(item => item.method === route.method && new RegExp("^(?:"+item.pattern+")$").test(actual));
            assert.equal(matched?.pattern,route.pattern,"The specimen hits a different matcher");
            return input;
        }, (response,_,value) => {
            if (deniedRoutes.has(route.method+" "+route.pattern)) {
                assert.equal(response.status,403);
                assert.deepEqual(value.body,{error:"不允许的请求来源",ok:false});
            } else {
                assert.ok(value.headers.some(([key, item]) => key.toLowerCase() === "access-control-allow-origin" && item === allowed[0]),
                    "No CORS marker for this registered route");
            }
            if (route.pattern === "/api/game-images/scan") {
                assert.equal(response.status,200);
                assert.equal(value.body.images.length,1);
                next.imageId = base.imageId = value.body.images[0].id;
            }
            if (route.pattern === "/api/game-images/preview") {
                assert.equal(response.status,200);
                assert.equal(sha(response.body),sha(png));
            }
            if (route.pattern === "/api/unity/endpoints") assert.deepEqual(value.body.endpoints,baseline.unityEndpoints);
            if (route.pattern === "/api/unity/llm-translate") {
                assert.equal(response.status,400);
                assert.equal(response.body.toString(),"text required");
                assert.ok(value.headers.some(([key,item]) => key.toLowerCase()==="content-type" && item==="text/plain; charset=utf-8"));
            }
            if (route.pattern === "/api/unity/detect-stream") {
                assert.deepEqual(response.body,_.body);
                assert.match(response.body.toString(),/^\{"type":"start"/);
            }
        });
    }

    for (const [method, url, status] of [["GET","/api/health",200],["GET","/api/settings",200],["HEAD","/api/health",200],["DELETE","/api/health",404],
        ["GET",missing,404],["POST",missing,404],["PUT",missing,404],["DELETE",missing,404]]) {
        await paired(base,next,"dispatch "+method+" "+url,method,()=>({url}), (response,_,value) => {
            assert.equal(response.status,status);
            if (method === "HEAD") assert.equal(response.body.length,0);
            if (status === 404) assert.ok(!value.headers.some(([key]) => key.toLowerCase() === "access-control-allow-origin"));
            if (url === "/api/settings") {
                assert.deepEqual(value.headers.filter(([key]) => key.toLowerCase() === "content-type").map(([,value])=>value),
                    ["application/json","application/json; charset=utf-8"]);
            }
        });
    }
    for (const method of ["POST","DELETE"]) {
        await paired(base,next,"unregistered hostile "+method,method,()=>({url:missing,origin:hostile}), (response,_,value) => {
            assert.equal(response.status,404);
            assert.ok(!value.headers.some(([key]) => key.toLowerCase() === "access-control-allow-origin"));
        });
    }
    const origins = [...allowed.map(origin=>({origin,accepted:true})),{origin:hostile,accepted:false},{origin:"null",accepted:false},
        ...[undefined,"same-origin","same-site","cross-site","none"].map(fetchSite=>({origin:null,fetchSite,accepted:fetchSite===undefined||fetchSite==="same-origin"||fetchSite==="same-site"}))];
    for (const info of origins) {
        for (const method of ["OPTIONS","GET"]) {
            const url = method === "OPTIONS" ? missing : "/api/health";
            await paired(base,next,"cors "+method+" "+(info.origin ?? "no Origin / "+(info.fetchSite ?? "absent")),method,()=>({url,...info}),
                (response,_,value) => {
                    assert.equal(response.status,info.accepted ? method==="OPTIONS"?204:200 : 403);
                    const values = key => value.headers.filter(([name])=>name.toLowerCase()===key).map(([,item])=>item);
                    assert.deepEqual(values("access-control-allow-origin"),info.accepted&&info.origin!==null?[info.origin]:[]);
                    assert.deepEqual(values("vary"),info.accepted&&info.origin!==null?["Origin"]:[]);
                    assert.deepEqual(values("access-control-allow-methods"),info.accepted?["GET, POST, PUT, DELETE, OPTIONS"]:[]);
                    if (info.accepted && method === "OPTIONS") assert.equal(response.body.length,0);
                    if (!info.accepted) assert.deepEqual(value.body,{error:"不允许的请求来源",ok:false});
                });
        }
    }

    await paired(base,next,"successful NDJSON scan","POST",instance=>({
        url:"/api/unity/detect-stream",body:{path:path.join(instance.dir,"fixtures","unity")},
    }),(_,__,value)=>{
        assert.equal(value.status,200);
        assert.deepEqual(value.body.trimEnd().split("\n").map(line => JSON.parse(line).type),["start","game","done"]);
    });
    await attempt("occupied port and restart",()=>occupiedPort(nextExe,path.join(root,"collision"),fixture));
} finally {
    await Promise.all([baseProcess.stop(),nextProcess.stop()]);
    writeJson(path.join(root,"results.json"),{baseline:{exe:base.exe,port:base.port,dir:base.dir},
        candidate:{exe:next.exe,port:next.port,dir:next.dir},cases});
}

const failed = cases.filter(entry=>!entry.passed);
console.log(cases.length+" checks, "+failed.length+" mismatches. "+path.join(root,"results.json"));
process.exitCode = failed.length ? 1 : 0;
