import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildRuntimeEnv, loadUnifiedConfig } from "./local-config.js";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";
import { openBrowser, shouldOpenBrowser } from "./browser-launcher.js";
import { ensureManagedDatabase } from "./database-preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const unifiedConfig = loadUnifiedConfig(projectRoot);
const runtimeEnv = buildRuntimeEnv(projectRoot, unifiedConfig, process.env);
const agentOnly = process.argv.includes("--agent-only");
const workerOnly = process.argv.includes("--worker-only");
const agentUrl = runtimeEnv.PERSONAL_FIT_AGENT_URL || "http://127.0.0.1:8000";
const parsedAgentUrl = new URL(agentUrl);
const agentHost = runtimeEnv.PERSONAL_FIT_AGENT_HOST || parsedAgentUrl.hostname;
const agentPort = runtimeEnv.PERSONAL_FIT_AGENT_PORT || parsedAgentUrl.port || "8000";
const python = resolvePythonExecutable(projectRoot, runtimeEnv);
const riderUrl = runtimeEnv.APP_BASE_URL || `http://localhost:${runtimeEnv.PORT || "8787"}`;
const children = new Set();
let stopping = false;

try {
    ensureManagedDatabase({ python, projectRoot, env: runtimeEnv });
} catch (error) {
    if (error?.code === "ENOENT") {
        console.warn(
            `[rider-tracker] Python runtime unavailable; database-backed features will remain disabled: ${error.message}`
        );
    } else {
        console.error(`[rider-tracker] database startup check failed: ${error.message}`);
        process.exit(1);
    }
}

if (!agentOnly && !workerOnly) {
    const rider = launch("rider-tracker", process.execPath, [
        "--disable-warning=ExperimentalWarning",
        path.join(projectRoot, "src", "server", "index.js")
    ], {
        cwd: projectRoot,
        env: { ...runtimeEnv, PERSONAL_FIT_AGENT_URL: agentUrl }
    }, { critical: true });
    void waitForHealth(`${riderUrl.replace(/\/+$/, "")}/healthz`, rider, "Rider")
        .then(() => {
            if (!shouldOpenBrowser(runtimeEnv.RIDER_OPEN_BROWSER)) return;
            const result = openBrowser(riderUrl, { env: runtimeEnv });
            if (!result.opened && result.reason === "no_desktop_session") {
                console.log(`[rider-tracker] no desktop session detected; open ${riderUrl} manually.`);
            }
        })
        .catch((error) => console.error(`[rider-tracker] Rider startup failed: ${error.message}`));
}

if (!workerOnly) {
    const agent = launch("training-agent", python, [
        "-m", "uvicorn", "app.api:app",
        "--host", agentHost,
        "--port", String(agentPort),
        "--log-level", "warning",
        "--no-access-log"
    ], {
        cwd: agentRoot,
        env: { ...runtimeEnv, PYTHONUNBUFFERED: "1" }
    }, { critical: agentOnly });

    if (agentOnly) {
        try {
            await waitForHealth(`${agentUrl.replace(/\/+$/, "")}/health`, agent, "Training Agent");
            console.log(`[rider-tracker] training agent ready at ${agentUrl}`);
        } catch (error) {
            console.error(`[rider-tracker] startup failed: ${error.message}`);
            stopAll(1);
        }
    } else {
        void waitForHealth(`${agentUrl.replace(/\/+$/, "")}/health`, agent, "Training Agent")
            .catch((error) => console.warn(
                `[rider-tracker] training agent unavailable; Rider remains usable without AI: ${error.message}`
            ));
    }
}

launch("training-worker", python, ["-m", "worker.main"], {
    cwd: agentRoot,
    env: { ...runtimeEnv, PYTHONUNBUFFERED: "1", TRAINING_AGENT_MANAGED_DATABASE: "1" }
}, { critical: workerOnly });

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
// A supervising Node process can own the complete local service lifecycle via IPC.
process.on("disconnect", () => stopAll(0));

function launch(name, command, args, options, { critical = false } = {}) {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.serviceName = name;
    children.add(child);
    child.once("error", (error) => {
        console.error(`[rider-tracker] ${name} failed to start: ${error.message}`);
        if (critical) stopAll(1);
    });
    child.once("exit", (code, signal) => {
        children.delete(child);
        if (!stopping) {
            console.error(`[rider-tracker] ${name} stopped unexpectedly (${signal || code}).`);
            if (critical) stopAll(code || 1);
        }
    });
    return child;
}

async function waitForHealth(url, child, serviceName, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${serviceName} exited before becoming ready.`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
            if (response.ok) return;
        } catch {
            // The service is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${serviceName} health check timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

function stopAll(exitCode) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill();
    setTimeout(() => process.exit(exitCode), 100).unref();
}
