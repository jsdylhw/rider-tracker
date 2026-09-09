import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonExecutable } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentPort = String(18700 + Math.floor(Math.random() * 200));
const riderPort = String(18900 + Math.floor(Math.random() * 200));
const agentUrl = `http://127.0.0.1:${agentPort}`;
const riderUrl = `http://127.0.0.1:${riderPort}`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rider-agent-degraded-"));
const databasePath = path.join(tempRoot, "rider-tracker.db");
let launcher = null;
let fakeAgent = null;

try {
    initializeDatabase();
    launcher = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        path.join(projectRoot, "scripts", "start-local.js")
    ], {
        cwd: projectRoot,
        stdio: "pipe",
        env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: riderPort,
            RIDER_OPEN_BROWSER: "false",
            PERSONAL_FIT_AGENT_URL: agentUrl,
            PYTHON_EXECUTABLE: path.join(tempRoot, "missing-python"),
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            FIT_FILE_DIR: path.join(tempRoot, "fit")
        }
    });

    await waitForJson(`${riderUrl}/healthz`, (value) => value.ok === true);
    await assertBaseRiderApis();
    await expectAgentUnavailable();
    await expectRouteLibraryUnavailable();
    await expectActivityLibraryUnavailable();
    await expectActivityArchiveUnavailable();

    fakeAgent = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/health") {
            response.end(JSON.stringify({
                status: "ok",
                schema_version: "training_backend_capabilities.v1",
                backend: "available",
                llm: "not_configured",
                capabilities: {
                    fit_ingestion: true,
                    activity_detail: true,
                    athlete_profile: true,
                    strava: true,
                    activity_analysis: false,
                    training_history: false,
                    ai_route_planning: false,
                    route_narration: false
                }
            }));
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ detail: "not found" }));
    });
    await listen(fakeAgent, Number(agentPort));

    const recovered = await waitForJson(
        `${riderUrl}/api/agent/health`,
        (value) => value.ok === true && value.result?.backend === "available"
    );
    if (recovered.result.llm !== "not_configured") {
        throw new Error(`Unexpected recovered capability state: ${JSON.stringify(recovered)}`);
    }

    await close(fakeAgent);
    fakeAgent = null;
    await expectAgentUnavailable();
    await expectRouteLibraryUnavailable();
    await expectActivityLibraryUnavailable();
    await expectActivityArchiveUnavailable();
    await assertBaseRiderApis();
    console.log("[degraded-integration] Rider core survived backend loss; Python-owned route, activity library, and session archive degraded explicitly.");
} finally {
    if (fakeAgent) await close(fakeAgent);
    launcher?.kill();
    await rm(tempRoot, { recursive: true, force: true });
}

async function assertBaseRiderApis() {
    const page = await readText(`${riderUrl}/`);
    if (!page.includes("Rider Tracker")) throw new Error("Rider page is unavailable without Agent.");
}

async function expectActivityLibraryUnavailable() {
    const response = await fetch(`${riderUrl}/api/activities`, requestOptions());
    const payload = await response.json();
    if (response.status !== 503 || payload.code !== "agent_unavailable"
        || payload.capability !== "activity_library") {
        throw new Error(`Unexpected activity-library degradation: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
}

async function expectActivityArchiveUnavailable() {
    const response = await fetch(`${riderUrl}/api/activities/rider-session`, {
        ...requestOptions(),
        method: "POST",
        headers: { ...requestOptions().headers, "Content-Type": "application/json" },
        body: JSON.stringify({ session: { id: "degraded-session" } })
    });
    const payload = await response.json();
    if (response.status !== 503 || payload.code !== "agent_unavailable"
        || payload.capability !== "activity_archive") {
        throw new Error(`Unexpected activity-archive degradation: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
}

async function expectRouteLibraryUnavailable() {
    const response = await fetch(`${riderUrl}/api/routes`, requestOptions());
    const payload = await response.json();
    if (response.status !== 503 || payload.code !== "agent_unavailable"
        || payload.capability !== "route_library") {
        throw new Error(`Unexpected route-library degradation: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
}

async function expectAgentUnavailable() {
    const startedAt = Date.now();
    const response = await fetch(`${riderUrl}/api/agent/health`, requestOptions());
    const payload = await response.json();
    if (response.status !== 503 || payload.code !== "agent_unavailable" || payload.retryable !== true) {
        throw new Error(`Unexpected unavailable response: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
    if (Date.now() - startedAt > 3_000) {
        throw new Error("Agent health degradation exceeded the three-second UI budget.");
    }
}

async function waitForJson(url, predicate, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, requestOptions());
            const value = await response.json();
            if (predicate(value, response)) return value;
        } catch {
            // The target process is still changing state.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

async function readJson(url) {
    const response = await fetch(url, requestOptions());
    const value = await response.json();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
}

async function readText(url) {
    const response = await fetch(url, requestOptions());
    const value = await response.text();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${value}`);
    return value;
}

function requestOptions() {
    return {
        headers: { Origin: riderUrl },
        signal: AbortSignal.timeout(3_000)
    };
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function initializeDatabase() {
    const python = resolvePythonExecutable(projectRoot, {});
    const result = spawnSync(python, [path.join(projectRoot, "scripts", "database-tool.py"), "migrate"], {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1"
        }
    });
    if (result.status !== 0) {
        throw new Error(`Failed to initialize degraded-test database: ${result.stderr || result.stdout}`);
    }
}
