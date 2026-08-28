import { spawn, spawnSync } from "node:child_process";
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
const databasePath = path.join(tempRoot, "rider-tracker.db");
const children = [];

try {
    initializeDatabase();
    children.push(spawn(python, [
        "-m", "uvicorn", "app.api:app", "--host", "127.0.0.1", "--port", agentPort
    ], {
        cwd: agentRoot,
        stdio: "pipe",
        env: {
            ...process.env,
            PYTHONPATH: agentRoot,
            PYTHONUNBUFFERED: "1",
            RIDER_PROJECT_ROOT: projectRoot,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1"
        }
    }));
    await waitForJson(`${agentUrl}/health`, (value) => value.status === "ok");
    const agentRootMetadata = await readJson(`${agentUrl}/`);
    if (agentRootMetadata.service !== "rider-training-backend") {
        throw new Error(`Unexpected Training Backend root payload: ${JSON.stringify(agentRootMetadata)}`);
    }
    await expectStatus(`${agentUrl}/static/app.js`, 404);

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
            RIDER_TRACKER_DB_PATH: databasePath,
            FIT_FILE_DIR: path.join(tempRoot, "fit")
        }
    }));
    await waitForJson(`${riderUrl}/healthz`, (value) => value.ok === true);
    const riderPage = await readText(`${riderUrl}/`);
    if (!riderPage.includes("Rider Tracker") || !riderPage.includes("Training Agent")) {
        throw new Error("Rider root did not return the unified product page.");
    }
    const activities = await readJson(`${riderUrl}/api/activities`);
    if (!activities.ok || !Array.isArray(activities.activities)) {
        throw new Error(`Unexpected Rider activity payload: ${JSON.stringify(activities)}`);
    }
    const routes = await readJson(`${riderUrl}/api/routes`);
    if (!routes.ok || !Array.isArray(routes.routes)) {
        throw new Error(`Unexpected Rider route payload: ${JSON.stringify(routes)}`);
    }
    await assertRouteLibraryRoundTrip();
    const proxyHealth = await readJson(`${riderUrl}/api/agent/health`);
    if (!proxyHealth.ok || proxyHealth.result?.status !== "ok") {
        throw new Error(`Unexpected Agent proxy health payload: ${JSON.stringify(proxyHealth)}`);
    }
    console.log("[integration] Unified Rider page, Python route store, Agent proxy, and removed legacy UI checks passed.");
} finally {
    for (const child of children) child.kill();
    await rm(tempRoot, { recursive: true, force: true });
}

async function assertRouteLibraryRoundTrip() {
    const created = await requestJson(`${riderUrl}/api/routes`, {
        method: "POST",
        body: {
            source: "gpx",
            route: {
                source: "gpx",
                name: "Integration route",
                totalDistanceMeters: 1000,
                totalElevationGainMeters: 20,
                hasElevationData: true,
                points: [
                    { latitude: 31.1, longitude: 121.1, distanceMeters: 0 },
                    { latitude: 31.2, longitude: 121.2, distanceMeters: 1000 }
                ]
            }
        }
    });
    const routeId = created.route?.id;
    if (!created.ok || !routeId) throw new Error(`Route creation failed: ${JSON.stringify(created)}`);

    const renamed = await requestJson(`${riderUrl}/api/routes/${encodeURIComponent(routeId)}`, {
        method: "PATCH", body: { name: "Renamed integration route" }
    });
    if (renamed.route?.name !== "Renamed integration route") {
        throw new Error(`Route rename failed: ${JSON.stringify(renamed)}`);
    }
    const paused = await requestJson(`${riderUrl}/api/routes/${encodeURIComponent(routeId)}/progress`, {
        method: "PUT", body: { resumeDistanceMeters: 400 }
    });
    if (paused.route?.resumeDistanceMeters !== 400) {
        throw new Error(`Route progress failed: ${JSON.stringify(paused)}`);
    }
    const loaded = await readJson(`${riderUrl}/api/routes/${encodeURIComponent(routeId)}`);
    if (loaded.route?.route?.points?.length !== 2) {
        throw new Error(`Route detail failed: ${JSON.stringify(loaded)}`);
    }
    await requestJson(`${riderUrl}/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
}

function initializeDatabase() {
    const result = spawnSync(python, [
        path.join(projectRoot, "scripts", "database-tool.py"), "init", "--database", databasePath
    ], {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            RIDER_PROJECT_ROOT: projectRoot,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath
        }
    });
    if (result.status !== 0) {
        throw new Error(`Failed to initialize integration database: ${result.stderr || result.stdout}`);
    }
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

async function readText(url) {
    const response = await fetch(url, {
        headers: { Origin: new URL(url).origin },
        signal: AbortSignal.timeout(2_000)
    });
    const value = await response.text();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${value}`);
    return value;
}

async function requestJson(url, { method, body }) {
    const response = await fetch(url, {
        method,
        headers: {
            Origin: new URL(url).origin,
            "Content-Type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(3_000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
}

async function expectStatus(url, expectedStatus) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (response.status !== expectedStatus) {
        throw new Error(`${url} returned HTTP ${response.status}; expected ${expectedStatus}.`);
    }
}
