import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareHttp, defaultPorts, withShutdown } from "./compare-http.mjs";

const help = [
    "Usage: node backend/tests/http/run.mjs --baseline EXE --candidate EXE [options]",
    "",
    "  --baseline-port PORT   Baseline port (default 17801)",
    "  --candidate-port PORT  Candidate port (default 17802)",
    "  --data-root DIR        Parent directory for this run (default system temp)",
    "  --help                 Show this help",
].join("\n");

const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(2) + " s";
let output;
try {
    const { values } = parseArgs({
        options: {
            baseline: { type: "string" },
            candidate: { type: "string" },
            "baseline-port": { type: "string" },
            "candidate-port": { type: "string" },
            "data-root": { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(help);
    } else {
        const baseExe = values.baseline ?? process.env.LLMCHAT_HTTP_BASELINE_EXE;
        const nextExe = values.candidate ?? process.env.LLMCHAT_HTTP_CANDIDATE_EXE;
        if (!baseExe || !nextExe) throw new Error("Both backend executables are required.\n" + help);
        const basePort = values["baseline-port"] ?? process.env.LLMCHAT_HTTP_BASELINE_PORT ?? defaultPorts.base;
        const nextPort = values["candidate-port"] ?? process.env.LLMCHAT_HTTP_CANDIDATE_PORT ?? defaultPorts.next;
        const dataRoot = path.resolve(values["data-root"] ?? process.env.LLMCHAT_HTTP_DATA_ROOT ?? os.tmpdir());
        fs.mkdirSync(dataRoot, { recursive: true });
        output = fs.mkdtempSync(path.join(dataRoot, "llmchat-http-"));

        const result = await withShutdown(signal => compareHttp({
            baseExe, nextExe, basePort, nextPort, output: path.join(output, "run"), signal,
        }));
        const passed = result.cases.length - result.failed.length;
        const status = result.failed.length ? "FAIL" : "PASS";
        console.log(status + " " + passed + "/" + result.cases.length + " checks (" + elapsed() + ")");
        for (const entry of result.failed) {
            const detail = entry.error?.split("\n", 1)[0];
            console.error("  - " + entry.name + (detail ? " | " + detail : ""));
        }
        console.log("Report: " + result.report);
        process.exitCode = result.failed.length ? 1 : 0;
    }
} catch (error) {
    console.error("FAIL (" + elapsed() + ") " + error.message);
    if (output) {
        const report = path.join(output, "run", "results.json");
        console.error(fs.existsSync(report) ? "Report: " + report : "Run directory: " + output);
    }
    process.exitCode = error.exitCode ?? 1;
}
