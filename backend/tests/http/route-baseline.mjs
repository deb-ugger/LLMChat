import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultBackend = fileURLToPath(new URL("../../", import.meta.url));
const defaultManifest = fileURLToPath(new URL("./routes-baseline.json", import.meta.url));

function readRoutes(backend) {
    const source = readFileSync(resolve(backend, "src/HttpServer.cpp"), "utf8");
    const registrations = /\bsvr\.(Get|Head|Post|Put|Patch|Delete|Options)\s*\(\s*/g;
    const routes = [];
    let expanded = 0;
    for (const registration of source.matchAll(registrations)) {
        const method = registration[1].toUpperCase();
        const expression = source.slice(registration.index + registration[0].length);
        const call = expression.match(/^(?:R"\(([^]*?)\)"|("(?:[^"\\]|\\.)*"))\s*(\+\s*operation\s*)?,\s*(withCors\s*\(|translateHandler\b|\[\s*\]\s*\(|http_router::corsPreflight\b)/);
        if (!call) throw new Error("Unsupported registration near " + expression.slice(0, 100));
        const pattern = call[1] ?? JSON.parse(call[2]);
        const handler = call[4].trim();
        const handlerKind = handler.startsWith("withCors") ? "cors-lambda"
            : handler === "translateHandler" ? "shared-translate"
            : method === "OPTIONS" && pattern === ".*" ? "cors-preflight" : null;
        assert.ok(handlerKind, "Unknown handler " + handler + " for " + pattern);
        const matcher = pattern.includes("/:") ? "path-params" : "regex";
        if (!call[3]) {
            routes.push({ method, pattern, handlerKind, matcher });
            continue;
        }
        const loop = source.slice(0, registration.index).match(
            /for\s*\(\s*const\s+std::string\s+operation\s*:\s*\{([^\n{}]+)\}\s*\)\s*\{?\s*$/);
        assert.ok(loop, "Cannot locate the registration loop for " + pattern);
        const operations = JSON.parse("[" + loop[1] + "]");
        for (const operation of operations) {
            routes.push({ method, pattern: pattern + operation, handlerKind, matcher });
        }
        expanded++;
    }

    // This loop builds one response payload, rather than registering 13 routes.
    assert.match(source, /for\s*\(\s*const auto& e\s*:\s*UnityAutoTranslator::endpoints\(\)\s*\)/);
    const unity = readFileSync(resolve(backend, "src/UnityAutoTranslator.cpp"), "utf8");
    const endpointList = unity.match(/UnityAutoTranslator::endpoints\(\)\s*\{\s*return\s*\{([^]*?)\};/);
    assert.ok(endpointList, "Cannot locate Unity's endpoint catalog");
    const unityEndpoints = [...endpointList[1].matchAll(/\{\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*(true|false)\s*\}/g)]
        .map(([, id, label, needsKey]) => ({ id: JSON.parse(id), label: JSON.parse(label), needsKey: needsKey === "true" }));
    assert.equal(expanded, 3);
    return { routes, unityEndpoints };
}

const [mode = "check", backend = defaultBackend, output = defaultManifest] = process.argv.slice(2);
assert.ok(["write", "check"].includes(mode), "Usage: node route-baseline.mjs [write|check] [backend-dir] [manifest]");
const actual = readRoutes(backend);
let changed = false;
if (mode === "write") {
    const fields = Object.entries(actual).map(([name, rows]) =>
        "  " + JSON.stringify(name) + ": [\n" + rows.map(row => "    " + JSON.stringify(row)).join(",\n") + "\n  ]");
    writeFileSync(output, "{\n" + fields.join(",\n") + "\n}\n");
} else {
    const expected = JSON.parse(readFileSync(output, "utf8"));
    for (const key of ["routes", "unityEndpoints"]) {
        const methods = key === "routes" ? new Set([...expected.routes, ...actual.routes].map(row => row.method)) : [null];
        for (const method of methods) {
            const left = expected[key].filter(row => method === null || row.method === method);
            const right = actual[key].filter(row => method === null || row.method === method);
            for (let i = 0; i < Math.max(left.length, right.length); i++) {
                if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) {
                    changed = true;
                    console.error(method ?? key, "#" + (i + 1), "expected", left[i], "actual", right[i]);
                }
            }
        }
    }
    if (!changed && JSON.stringify(actual.routes) !== JSON.stringify(expected.routes)) {
        changed = true;
        for (let i = 0; i < actual.routes.length; i++) {
            if (JSON.stringify(actual.routes[i]) !== JSON.stringify(expected.routes[i])) {
                console.error("Registration order #" + (i + 1), "expected", expected.routes[i], "actual", actual.routes[i]);
            }
        }
    }
    if (changed) process.exitCode = 1;
}
const business = actual.routes.filter(route => route.method !== "OPTIONS");
const options = actual.routes.filter(route => route.method === "OPTIONS");
assert.equal(new Set(actual.routes.map(route => route.method + " " + route.pattern)).size, actual.routes.length);
assert.equal(business.length, 103);
assert.deepEqual(options, [{ method: "OPTIONS", pattern: ".*", handlerKind: "cors-preflight", matcher: "regex" }]);
assert.equal(actual.unityEndpoints.length, 13);
if (!changed) console.log("103 business registrations + 1 wildcard OPTIONS; 13 Unity catalog entries.");
