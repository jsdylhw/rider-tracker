// Network-dependent installation smoke test; deliberately outside deterministic suites.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = path.join(projectRoot, "services", "training-agent");
const scratch = mkdtempSync(path.join(os.tmpdir(), "rider-agent-setup-"));
const venv = path.join(scratch, "venv");
const python = process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");

function run(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd, stdio: "inherit", env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONPATH: agentRoot }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Installation smoke test failed (${result.status}): ${command}`);
}

try {
    run(process.execPath, [path.join(projectRoot, "scripts/setup-agent.js"), "--venv", venv], projectRoot);
    run(python, ["-m", "pip", "check"], agentRoot);
    // Existing upload contracts exercise real multipart parsing and all three endpoints.
    // FIT parsing is isolated in these tests; no user files or external accounts are used.
    run(python, ["-m", "pytest", "-q", "tests/test_fit_upload.py"], agentRoot);
    console.log("[setup-smoke] Clean official installation and multipart upload contracts passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
