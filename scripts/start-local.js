import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildRuntimeEnv, loadUnifiedConfig } from "./local-config.js";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const unifiedConfig = loadUnifiedConfig(projectRoot);
const runtimeEnv = buildRuntimeEnv(projectRoot, unifiedConfig, process.env);
const agentOnly = process.argv.includes("--agent-only");
const agentUrl = runtimeEnv.PERSONAL_FIT_AGENT_URL || "http://127.0.0.1:8000";
const parsedAgentUrl = new URL(agentUrl);
const agentHost = runtimeEnv.PERSONAL_FIT_AGENT_HOST || parsedAgentUrl.hostname;
const agentPort = runtimeEnv.PERSONAL_FIT_AGENT_PORT || parsedAgentUrl.port || "8000";
const python = resolvePythonExecutable(projectRoot, runtimeEnv);
const children = new Set();
let stopping = false;

const agent = launch("training-agent", python, [
    "-m", "uvicorn", "app.api:app",
    "--host", agentHost,
    "--port", String(agentPort)
], {
    cwd: agentRoot,
    env: { ...runtimeEnv, PYTHONUNBUFFERED: "1" }
});

try {
    await waitForHealth(`${agentUrl.replace(/\/+$/, "")}/health`, agent);
    console.log(`[rider-tracker] training agent ready at ${agentUrl}`);
    if (!agentOnly) {
        launch("rider-tracker", process.execPath, [
            "--disable-warning=ExperimentalWarning",
            path.join(projectRoot, "src", "server", "index.js")
        ], {
            cwd: projectRoot,
            env: { ...runtimeEnv, PERSONAL_FIT_AGENT_URL: agentUrl }
        });
    }
} catch (error) {
    console.error(`[rider-tracker] startup failed: ${error.message}`);
    stopAll(1);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

function launch(name, command, args, options) {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.serviceName = name;
    children.add(child);
    child.once("error", (error) => {
        console.error(`[rider-tracker] ${name} failed to start: ${error.message}`);
        stopAll(1);
    });
    child.once("exit", (code, signal) => {
        children.delete(child);
        if (!stopping) {
            console.error(`[rider-tracker] ${name} stopped unexpectedly (${signal || code}).`);
            stopAll(code || 1);
        }
    });
    return child;
}

async function waitForHealth(url, child, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("Training Agent exited before becoming ready.");
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
            if (response.ok) return;
        } catch {
            // The service is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Training Agent health check timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

function stopAll(exitCode) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill();
    setTimeout(() => process.exit(exitCode), 100).unref();
}
