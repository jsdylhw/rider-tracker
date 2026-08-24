import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
const python = resolvePythonExecutable(projectRoot);
const agentPort = String(18100 + Math.floor(Math.random() * 300));
const riderPort = String(18400 + Math.floor(Math.random() * 300));
const agentUrl = `http://127.0.0.1:${agentPort}`;
const riderUrl = `http://127.0.0.1:${riderPort}`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rider-agent-integration-"));
const children = [];

try {
    children.push(spawn(python, [
        "-m", "uvicorn", "app.api:app", "--host", "127.0.0.1", "--port", agentPort
    ], {
        cwd: agentRoot,
        stdio: "pipe",
        env: { ...process.env, PYTHONPATH: agentRoot, PYTHONUNBUFFERED: "1" }
    }));
    await waitForJson(`${agentUrl}/health`, (value) => value.status === "ok");

    children.push(spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        path.join(projectRoot, "src", "server", "index.js")
    ], {
        cwd: tempRoot,
        stdio: "pipe",
        env: {
            ...process.env,
            PORT: riderPort,
            HOST: "127.0.0.1",
            PERSONAL_FIT_AGENT_URL: agentUrl,
            RIDER_TRACKER_DB_PATH: path.join(tempRoot, "rider-tracker.db"),
            FIT_FILE_DIR: path.join(tempRoot, "fit")
        }
    }));
    await waitForJson(`${riderUrl}/healthz`, (value) => value.ok === true);
    const proxyHealth = await readJson(`${riderUrl}/api/agent/health`);
    if (!proxyHealth.ok || proxyHealth.result?.status !== "ok") {
        throw new Error(`Unexpected Agent proxy health payload: ${JSON.stringify(proxyHealth)}`);
    }
    console.log("[integration] Rider -> embedded Training Agent health path passed.");
} finally {
    for (const child of children) child.kill();
    await rm(tempRoot, { recursive: true, force: true });
}

async function waitForJson(url, predicate, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const value = await readJson(url);
            if (predicate(value)) return value;
        } catch {
            // The process is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

async function readJson(url) {
    const response = await fetch(url, {
        headers: { Origin: new URL(url).origin },
        signal: AbortSignal.timeout(2_000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
}
