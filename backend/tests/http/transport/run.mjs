import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";

const [exe] = process.argv.slice(2);
assert.ok(exe, "Usage: node run.mjs HTTP_TRANSPORT_TESTS_EXE");

async function fixture(port = 0) {
    const paths = new Map();
    const sockets = new Set();
    let connections = 0;
    const server = http.createServer((req, res) => {
        paths.set(req.url, 1 + (paths.get(req.url) ?? 0));
        switch (req.url) {
        case "/close":
            res.setHeader("Connection", "close");
            break;
        case "/get-fault":
            if (paths.get(req.url) === 1) { req.socket.resetAndDestroy(); return; }
            break;
        case "/post-fault":
            req.resume();
            req.once("end", () => req.socket.destroy());
            return;
        case "/4xx": res.writeHead(408); break;
        case "/5xx": res.writeHead(503); break;
        case "/cookie-redirect":
            res.writeHead(302, { "Set-Cookie": "session=fixture; Path=/", Location: "/cookie-target" });
            break;
        case "/set-cookie": res.setHeader("Set-Cookie", "session=other; Path=/"); break;
        case "/cookie-target": res.end(req.headers.cookie ?? "none"); return;
        case "/bytes": res.end("x".repeat(180000)); return;
        case "/stall":
            res.setHeader("Content-Length", "64");
            res.flushHeaders();
            return;
        case "/timeout": return;
        default: break;
        }
        res.end("body");
    });
    server.on("connection", socket => {
        connections++;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.keepAliveTimeout = 30000;
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return {
        port: server.address().port, paths, connections: () => connections,
        close: async () => {
            const closed = once(server, "close");
            server.close();
            for (const socket of sockets) socket.destroy();
            await closed;
        },
    };
}

function start(port, name) {
    const child = spawn(exe, [String(port), name], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill(), 12000);
    const complete = once(child, "close").then(([code]) => {
        assert.equal(code, 0, name + " " + stdout + stderr);
        return stdout;
    }).finally(() => clearTimeout(timeout));
    return { child, complete };
}

let server = await fixture();
try {
    await start(server.port, "legacy").complete;
    const legacy = server.connections();
    assert.equal(server.paths.get("/body"),20);
    await server.close();
    server = await fixture();
    const pooled = await start(server.port, "reuse").complete;
    assert.match(pooled, /openedSessions=1\b/);
    assert.equal(server.paths.get("/body"),21);
    assert.equal(server.connections(),2);
    console.log("PASS same origin 20 → 1 WinHTTP sessions; legacy TCP sockets = " + legacy + ", pooled TCP sockets = 1; Connection: close opened the second");
    await server.close();
    server = await fixture();
    await start(server.port, "concurrent").complete;
    assert.equal(server.paths.get("/bytes"),16);
    console.log("PASS 16 concurrent 180000-byte downloads");
    await server.close();
    server = await fixture();
    const policy = await start(server.port, "policy").complete;
    assert.equal(server.paths.get("/get-fault"),2);
    for (const route of ["/post-fault","/4xx","/5xx","/timeout"]) assert.equal(server.paths.get(route),1,route);
    assert.equal(server.paths.has("/early-cancel"), false);
    console.log("PASS GET-only connection retry, HTTP statuses, read deadline, cookies and cancellation",policy.trim());
    await server.close();
    server = await fixture();
    const oldPort = server.port;
    const restart = start(oldPort, "restart");
    await Promise.race([once(restart.child.stdout, "data"), restart.complete]);
    assert.equal(server.paths.get("/body"),1);
    await server.close();
    server = await fixture(oldPort);
    restart.child.stdin.end("go\n");
    await restart.complete;
    assert.equal(server.paths.get("/body"),1);
    console.log("PASS an existing client session recovered after restarting the server");
} finally {
    await server.close();
}
