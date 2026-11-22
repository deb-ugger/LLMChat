import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = process.argv[2] ?? "905ca6e";
const manifest = "backend/tests/http/routes-baseline.json";
const routeDirectory = "backend/src/http";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const read = (file) => readFileSync(join(root, file), "utf8");

function extract(source, file) {
    const routes = [];
    for (const call of source.matchAll(/\bsvr\.(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*/g)) {
        const expression = source.slice(call.index + call[0].length);
        const parts = /^(?:R"\(([^]*?)\)"|("(?:[^"\\]|\\.)*"))\s*(\+\s*operation\s*)?,\s*(withCors\s*\(|translateHandler\b|http_router::corsPreflight\b)/.exec(expression);
        assert.ok(parts, "Unrecognized route in " + file + ": " + expression.slice(0, 100));
        const method = call[1].toUpperCase();
        const pattern = parts[1] ?? JSON.parse(parts[2]);
        const handlerKind = parts[4].startsWith("withCors") ? "cors-lambda"
            : parts[4] === "translateHandler" ? "shared-translate" : "cors-preflight";
        let paths = [pattern];
        if (parts[3]) {
            const loop = /for\s*\(\s*const\s+std::string\s+operation\s*:\s*\{([^\n{}]+)\}\s*\)\s*\{?\s*$/
                .exec(source.slice(0, call.index));
            assert.ok(loop, "Missing registration loop for " + pattern);
            paths = JSON.parse("[" + loop[1] + "]").map(operation => pattern + operation);
        }
        for (const path of paths) routes.push({ method, pattern: path, handlerKind,
            matcher: path.includes("/:") ? "path-params" : "regex" });
    }
    return routes;
}

const oldFiles = git("ls-tree", "-r", "--name-only", baseline, "--", routeDirectory)
    .trim().split(/\r?\n/).filter(file => file.endsWith(".cpp"));
const newFiles = readdirSync(join(root, routeDirectory)).filter(name => name.endsWith(".cpp"))
    .map(name => routeDirectory + "/" + name);
const assemble = (files, source) => ["backend/src/HttpServer.cpp", ...files]
    .flatMap(file => extract(source(file), file));
const oldSource = (file) => git("show", baseline + ":" + file);
const old = JSON.parse(oldSource(manifest));
const updated = JSON.parse(read(manifest));
const isExport = route => route.pattern.startsWith("/api/game-image-exports/");
const sorted = routes => routes.map(route => JSON.stringify(route)).sort();

assert.deepEqual(sorted(assemble(oldFiles, oldSource)), sorted(old.routes), "main source matches the checked-in baseline");
assert.deepEqual(updated.routes.filter(route => !isExport(route)), old.routes, "old manifest entries and order");
assert.deepEqual(updated.unityEndpoints, old.unityEndpoints, "Unity endpoint catalog");
assert.deepEqual(sorted(assemble(newFiles, read)), sorted(updated.routes), "registered routes including exports");
assert.equal(updated.routes.filter(isExport).length, 7);
assert.equal(new Set(updated.routes.map(route => route.method + " " + route.pattern)).size, updated.routes.length);
console.log("PASS", old.routes.length, "baseline registrations unchanged,", updated.routes.filter(isExport).length, "export routes added");
