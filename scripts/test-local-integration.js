import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";
import { canonicalDetailToRiderActivity } from "../tests/fixtures/legacy-rider-projection.js";
import assert from "node:assert/strict";
import { exportSessionAsFit } from "../src/adapters/export/fit-exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
const python = resolvePythonExecutable(projectRoot);
const agentPort = String(18100 + Math.floor(Math.random() * 300));
const riderPort = String(18400 + Math.floor(Math.random() * 300));
const agentUrl = `http://127.0.0.1:${agentPort}`;
const riderUrl = `http://127.0.0.1:${riderPort}`;
const browserPort = String(Number(agentPort) + 1000);
const browserUrl = `http://127.0.0.1:${browserPort}`;
const isolatedAgentPort = String(Number(browserPort) + 1000);
const isolatedAgentEnv = {
    RIDER_AGENT_PROCESS_URL: `http://127.0.0.1:${isolatedAgentPort}`,
    RIDER_AGENT_PROCESS_TOKEN: 'isolated-integration-token'
};
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rider-agent-integration-"));
const databasePath = path.join(tempRoot, "rider-tracker.db");
const testEnv = {
    ...process.env,
    RIDER_CONFIG_PATH: path.join(tempRoot, "absent-config.yaml"),
    TRAINING_AGENT_CONFIG_PATH: path.join(tempRoot, "absent-config.yaml"),
    RIDER_ENV_PATH: path.join(tempRoot, "absent.env"),
    RIDER_DATA_ROOT: path.join(tempRoot, "data"),
    RIDER_CREDENTIALS_DIR: path.join(tempRoot, "credentials"),
    STRAVA_TOKEN_STORE: path.join(tempRoot, "credentials", "strava.json"),
    RIDER_WORKFLOW_DIR: path.join(tempRoot, "workflows"),
    RIDER_WORKFLOW_JOURNAL_DIR: path.join(tempRoot, "workflows", "journals"),
    RIDER_ACTIVITY_WORKFLOW_DIR: path.join(tempRoot, "workflows", "activity-runs"),
    RIDER_LOG_DIR: path.join(tempRoot, "logs"),
    RIDER_CACHE_DIR: path.join(tempRoot, "cache"),
    RIDER_EVALUATION_ARTIFACT_DIR: path.join(tempRoot, "artifacts"),
    RIDER_MIGRATION_DIR: path.join(tempRoot, "migrations")
};
const fitRoot = path.join(tempRoot, "fit");
const children = [];

try {
    initializeDatabase();
    children.push(spawn(python, [
        "-m", "uvicorn", "app.api:app", "--host", "127.0.0.1", "--port", agentPort
    ], {
        cwd: agentRoot,
        stdio: "pipe",
        env: {
            ...testEnv,
            PYTHONPATH: agentRoot,
            PYTHONUNBUFFERED: "1",
            RIDER_PROJECT_ROOT: projectRoot,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1",
            FIT_FILE_DIR: fitRoot,
            PERSONAL_FIT_AGENT_HOST: "127.0.0.1",
            PERSONAL_FIT_AGENT_PORT: agentPort,
            GOOGLE_MAPS_API_KEY: "integration-google-key"
        }
    }));
    await waitForJson(`${agentUrl}/health`, (value) => value.status === "ok");
    const agentRootMetadata = await readJson(`${agentUrl}/`);
    if (agentRootMetadata.service !== "rider-training-backend") {
        throw new Error(`Unexpected Training Backend root payload: ${JSON.stringify(agentRootMetadata)}`);
    }
    await expectStatus(`${agentUrl}/static/app.js`, 404);
    const pythonEdgeHealth = await readJson(`${agentUrl}/healthz`);
    if (!pythonEdgeHealth.ok || pythonEdgeHealth.service !== "rider-tracker") {
        throw new Error(`Unexpected Python edge health payload: ${JSON.stringify(pythonEdgeHealth)}`);
    }
    const pythonMapsConfig = await readJson(`${agentUrl}/api/runtime-config/maps`);
    if (!pythonMapsConfig.configured || pythonMapsConfig.apiKey !== "integration-google-key") {
        throw new Error(`Unexpected Python browser maps config: ${JSON.stringify(pythonMapsConfig)}`);
    }
    const pythonProfile = await requestJson(`${agentUrl}/api/user-profile`, {
        method: "PUT",
        body: { mass: 72, ftp: 260, windSpeed: 2.5 }
    });
    if (!pythonProfile.ok || pythonProfile.profile?.ftp !== 260 || pythonProfile.profile?.mass !== 72) {
        throw new Error(`Unexpected Python browser profile payload: ${JSON.stringify(pythonProfile)}`);
    }

    children.push(spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        path.join(projectRoot, "src", "server", "index.js")
    ], {
        cwd: tempRoot,
        stdio: "pipe",
        env: {
            ...testEnv,
            PORT: riderPort,
            HOST: "127.0.0.1",
            PERSONAL_FIT_AGENT_URL: agentUrl,
            RIDER_TRACKER_DB_PATH: databasePath,
            FIT_FILE_DIR: fitRoot,
            GOOGLE_MAPS_API_KEY: "integration-google-key"
        }
    }));
    await waitForJson(`${riderUrl}/healthz`, (value) => value.ok === true);
    children.push(spawn(python, ["-m", "uvicorn", "app.browser:app", "--host", "127.0.0.1", "--port", browserPort], {
        cwd: agentRoot, stdio: "pipe", env: {
            ...testEnv, ...isolatedAgentEnv, PYTHONPATH: agentRoot, RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath, TRAINING_AGENT_MANAGED_DATABASE: "1",
            FIT_FILE_DIR: fitRoot, PERSONAL_FIT_AGENT_PORT: browserPort
        }
    }));
    children.push(spawn(python, ['-m', 'uvicorn', 'app.agent_process:create_agent_process_app', '--factory',
        '--host', '127.0.0.1', '--port', isolatedAgentPort], {
        cwd: agentRoot, stdio: 'pipe', env: {
            ...testEnv, ...isolatedAgentEnv, RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath, TRAINING_AGENT_MANAGED_DATABASE: '1', FIT_FILE_DIR: fitRoot
        }
    }));
    await waitForJson(`${browserUrl}/healthz`, value => value.ok === true);
    await waitForJson(`${browserUrl}/api/agent/health`, value => value.ok === true);
    const previewSession = await requestJson(`${browserUrl}/api/agent/sessions`, {
        method: "POST", body: { session_id: "preview-session-contract", kind: "chat" }
    });
    assert.equal(previewSession.result.session_id, "preview-session-contract");
    assert.deepEqual(await readJson(`${browserUrl}/api/agent/sessions/preview-session-contract`),
                     await readJson(`${riderUrl}/api/agent/sessions/preview-session-contract`));
    await requestJson(`${browserUrl}/api/agent/sessions/preview-session-contract`, { method: "DELETE" });
    await expectStatus(`${browserUrl}/api/agent/sessions/preview-session-contract`, 404);

    for (const asset of ["/", "/src/style.css", "/src/app/bootstrap.js", "/vendor/@garmin/fitsdk/src/index.js"]) {
        const [nodeAsset, pythonAsset] = await Promise.all([fetch(riderUrl + asset), fetch(browserUrl + asset)]);
        if (nodeAsset.status !== 200 || pythonAsset.status !== 200
            || await nodeAsset.text() !== await pythonAsset.text()) throw new Error(`Static entry mismatch: ${asset}`);
        const cached = await fetch(browserUrl + asset, {headers: {"If-None-Match": pythonAsset.headers.get("etag")}});
        if (cached.status !== 304 || pythonAsset.headers.get("cache-control") !== "no-cache") {
            throw new Error(`Static cache contract failed: ${asset}`);
        }
    }
    for (const asset of ["/src/server/index.js", "/config.yaml", "/data/credentials/token.json", "/static/app.js", "/missing-page"]) {
        await expectStatus(browserUrl + asset, 404);
    }
    console.log("[integration] Optional Python browser entry serves identical Rider/SDK assets with revalidation and private-path denial.");
    for (const endpoint of ["/api/strava/config", "/api/strava/upload-fit"]) {
        const responses = await Promise.all([riderUrl, browserUrl].map(base => fetch(base + endpoint, { method: "POST" })));
        assert.equal(responses[0].status, endpoint.endsWith("config") ? 409 : 410);
        assert.equal(responses[1].status, responses[0].status);
        assert.deepEqual(await responses[0].json(), await responses[1].json());
    }
    for (const base of [riderUrl, browserUrl]) {
        const response = await fetch(base + "/api/strava/auth/callback?state=invalid&code=not-exchanged");
        assert.equal(response.status, 400);
        assert.match(await response.text(), /Strava authorization expired/);
        const login = await fetch(base + "/strava/login");
        assert.equal(login.status, 200);
        assert.match(await login.text(), /连接 Strava/);
    }
    console.log("[integration] Strava browser refusal contracts, login and invalid OAuth callback agree across entries.");


    const riderPage = await readText(`${riderUrl}/`);
    if (!riderPage.includes("Rider Tracker") || !riderPage.includes("Training Agent")) {
        throw new Error("Rider root did not return the unified product page.");
    }
    const createdSession = await requestJson(`${riderUrl}/api/agent/sessions`, {
        method: "POST", body: { session_id: "integration-chat", kind: "chat" }
    });
    const sessionList = await readJson(`${riderUrl}/api/agent/sessions?kind=chat`);
    const sessionDetail = await readJson(`${riderUrl}/api/agent/sessions/integration-chat`);
    if (createdSession.result?.schema_version !== "agent_session.v1"
        || sessionList.result?.sessions?.length !== 1
        || sessionDetail.result?.turns?.length !== 0) throw new Error("Session creation/list/restore contract failed");
    await requestJson(`${riderUrl}/api/agent/sessions/integration-chat`, { method: "DELETE" });
    await expectStatus(`${riderUrl}/api/agent/sessions/integration-chat`, 404);

    const mapsConfig = await readJson(`${riderUrl}/api/runtime-config/maps`);
    if (!mapsConfig.configured || mapsConfig.apiKey !== "integration-google-key") {
        throw new Error(`Unexpected browser maps config: ${JSON.stringify(mapsConfig)}`);
    }
    const riderProfile = await readJson(`${riderUrl}/api/user-profile`);
    if (JSON.stringify(riderProfile) !== JSON.stringify(pythonProfile)) {
        throw new Error(
            `Node/Python browser profile mismatch: ${JSON.stringify({ riderProfile, pythonProfile })}`
        );
    }
    const activities = await readJson(`${riderUrl}/api/activities`);
    if (!activities.ok || !Array.isArray(activities.activities)) {
        throw new Error(`Unexpected Rider activity payload: ${JSON.stringify(activities)}`);
    }
    await assertActivityLibraryRoundTrip();
    const routes = await readJson(`${riderUrl}/api/routes`);
    if (!routes.ok || !Array.isArray(routes.routes)) {
        throw new Error(`Unexpected Rider route payload: ${JSON.stringify(routes)}`);
    }
    await assertRouteLibraryRoundTrip();
    await assertAtomicRouteConfirmation();
    const proxyHealth = await readJson(`${riderUrl}/api/agent/health`);
    if (!proxyHealth.ok || proxyHealth.result?.status !== "ok") {
        throw new Error(`Unexpected Agent proxy health payload: ${JSON.stringify(proxyHealth)}`);
    }
    await assertNarrationJobSubmission();
    await assertBrowserFailureParity();
    await assertEntryRollback();
    console.log("[integration] Unified Rider page, Python edge parity, activity/route stores, atomic FIT/session/route persistence, Agent proxy, and removed legacy UI checks passed.");
} finally {
    await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.kill();
        await closed;
    }));
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function assertBrowserFailureParity() {
    const cases = [
        ['GET', '/api/activities/absent-activity'],
        ['PATCH', '/api/activities/absent-activity', { name: 'Renamed' }],
        ['POST', '/api/activities/rider-session', {}],
        ['GET', '/api/routes/absent-route'],
        ['POST', '/api/routes', {}],
        ['PATCH', '/api/routes/absent-route', { name: 'Renamed' }],
        ['PUT', '/api/routes/absent-route/progress', {}],
        ['GET', '/api/agent/sessions/absent-session'],
        ['GET', '/api/agent/sessions?kind=invalid'],
        ['POST', '/api/agent/sessions', { session_id: 'bad id' }],
        ['POST', '/api/agent/chat', { session_id: 's', request_id: 'r', message: '' }],
        ['POST', '/api/agent/chat', { session_id: 's', request_id: 'r', message: 'test' }],
        ['POST', '/api/agent/route-plans/command', { session_id: 's', request_id: 'r', operation: 'invalid' }],
        ['POST', '/api/route-narrations/prepare', {}],
        ['GET', '/api/route-narrations/jobs/absent-job'],
        ['GET', '/api/route-narrations/photo?name=invalid'],
    ];
    for (const [method, endpoint, body] of cases) {
        const results = await Promise.all([riderUrl, browserUrl].map(async (base) => {
            const response = await fetch(base + endpoint, {
                method, headers: { 'Content-Type': 'application/json', Origin: base },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
            });
            return { status: response.status, payload: await response.json() };
        }));
        assert.equal(results[1].status, results[0].status, `${method} ${endpoint}`);
        assert.ok(results[0].status >= 400, `${method} ${endpoint} must fail`);
        for (const result of results) {
            assert.equal(result.payload.ok, false, endpoint);
            assert.equal(typeof result.payload.error, 'string', endpoint);
        }
    }
    for (const base of [riderUrl, browserUrl]) {
        const response = await fetch(base + '/api/agent/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Origin: base },
            body: JSON.stringify({ session_id: 's', request_id: 'stream-refusal', message: 'test' }),
            signal: AbortSignal.timeout(5000)
        });
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('content-type').includes('application/x-ndjson'));
        const events = (await response.text()).split('\n').filter((line) => line.trim()).map(JSON.parse);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'error');
        assert.equal(events[0].schema_version, 'agent_stream.v1');
    }
    console.log('[integration] Browser error envelopes/status and terminal NDJSON capability refusal agree across entries.');
}

async function assertEntryRollback() {
    const paths = ["/api/activities", "/api/routes", "/api/user-profile", "/api/agent/sessions"];
    const before = await Promise.all(paths.map((endpoint) => readJson(browserUrl + endpoint)));
    const closed = once(children[2], "close");
    children[2].kill();
    await closed;
    const compatibility = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning", path.join(projectRoot, "src/server/index.js")
    ], {
        cwd: tempRoot, stdio: "pipe", env: {
            ...testEnv, PORT: browserPort, HOST: "127.0.0.1", APP_BASE_URL: browserUrl,
            PERSONAL_FIT_AGENT_URL: agentUrl, RIDER_TRACKER_DB_PATH: databasePath,
            FIT_FILE_DIR: fitRoot
        }
    });
    children.push(compatibility);
    await waitForJson(`${browserUrl}/healthz`, (value) => value.ok === true);
    assert.deepEqual(await Promise.all(paths.map((endpoint) => readJson(browserUrl + endpoint))), before);
    await requestJson(`${browserUrl}/api/user-profile`, { method: "PUT", body: { mass: 74, ftp: 265 } });
    const restoredProfile = await readJson(`${browserUrl}/api/user-profile`);
    const compatibilityClosed = once(compatibility, "close");
    compatibility.kill();
    await compatibilityClosed;
    children.push(spawn(python, ["-m", "uvicorn", "app.browser:app", "--host", "127.0.0.1", "--port", browserPort], {
        cwd: agentRoot, stdio: "pipe", env: {
            ...testEnv, ...isolatedAgentEnv, RIDER_TRACKER_DB_PATH: databasePath, TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1", FIT_FILE_DIR: fitRoot,
            PERSONAL_FIT_AGENT_PORT: browserPort
        }
    }));
    await waitForJson(`${browserUrl}/healthz`, (value) => value.ok === true);
    assert.deepEqual(await readJson(`${browserUrl}/api/user-profile`), restoredProfile);
    console.log("[integration] Same-port Python -> Node -> Python rollback preserved catalogue, sessions and profile writes without data conversion.");
}

async function assertNarrationJobSubmission() {
    const submitted = await requestJson(`${riderUrl}/api/route-narrations/prepare`, {
        method: "POST",
        body: {
            route_fingerprint: "route_1234abcd",
            route_name: "Integration route",
            total_distance_m: 1000,
            estimated_duration_min: 10,
            locale: "zh-CN",
            samples: [
                { route_distance_m: 0, latitude: 30, longitude: 120 },
                { route_distance_m: 1000, latitude: 30.01, longitude: 120.01 }
            ]
        }
    });
    const job = submitted.result;
    assert.deepEqual(await readJson(`${browserUrl}/api/route-narrations/jobs/${encodeURIComponent(job.job_id)}`),
                     await readJson(`${riderUrl}/api/route-narrations/jobs/${encodeURIComponent(job.job_id)}`));
    if (!submitted.ok || !job?.job_id || job.status !== "queued") {
        throw new Error(`Narration submission was not queued: ${JSON.stringify(submitted)}`);
    }
    const detail = await readJson(`${riderUrl}/api/route-narrations/jobs/${encodeURIComponent(job.job_id)}`);
    if (!detail.ok || detail.result?.job_id !== job.job_id || detail.result?.plan) {
        throw new Error(`Unexpected narration job detail: ${JSON.stringify(detail)}`);
    }
}

async function assertActivityLibraryRoundTrip() {
    const activityId = "integration-activity";
    seedActivity({
        activity_key: activityId,
        fit_path: "data/files/fit/integration-missing.fit",
        file_name: "integration-missing.fit",
        source: "fit-import",
        sport_type: "cycling",
        name: "Integration activity",
        start_time_local: "2026-08-29T08:00:00",
        duration_s: 1200,
        distance_km: 8,
    });
    const listed = await readJson(`${riderUrl}/api/activities?sportType=cycling&source=fit-import`);
    if (listed.activities?.[0]?.id !== activityId || listed.summary?.activityCount !== 1) {
        throw new Error(`Activity list failed: ${JSON.stringify(listed)}`);
    }
    const detail = await readJson(`${riderUrl}/api/activities/${encodeURIComponent(activityId)}`);
    if (detail.activity?.id !== activityId || detail.activity?.distanceKm !== 8) {
        throw new Error(`Activity detail failed: ${JSON.stringify(detail)}`);
    }
    const renamed = await requestJson(`${riderUrl}/api/activities/${encodeURIComponent(activityId)}`, {
        method: "PATCH", body: { name: "Renamed integration activity" }
    });
    if (renamed.activity?.name !== "Renamed integration activity") {
        throw new Error(`Activity rename failed: ${JSON.stringify(renamed)}`);
    }
    await requestJson(`${riderUrl}/api/activities/${encodeURIComponent(activityId)}`, { method: "DELETE" });
    await expectStatus(`${riderUrl}/api/activities/${encodeURIComponent(activityId)}`, 404);
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

    const archivedSession = {
        id: "integration-session-activity",
        createdAt: "2026-08-29T09:00:00Z",
        finishedAt: "2026-08-29T09:20:00Z",
        route: {
            savedRouteId: routeId,
            continuation: { startDistanceMeters: 250 }
        },
        summary: { metrics: { ride: { elapsedSeconds: 1200, distanceKm: 4 } } },
        records: [
            { elapsedSeconds: 0, distanceKm: 0, power: 150, cadence: 80, heartRate: 130 },
            { elapsedSeconds: 1200, distanceKm: 4, power: 175, cadence: 85, heartRate: 145 }
        ]
    };
    const archived = await requestJson(`${riderUrl}/api/activities/rider-session`, {
        method: "POST",
        body: {
            name: "Integration fallback ride",
            sportType: "Ride",
            session: archivedSession
        }
    });
    if (archived.activity?.savedRouteId !== routeId
        || archived.activity?.routeStartDistanceMeters !== 250
        || archived.activity?.routeEndDistanceMeters !== 4250) {
        throw new Error(`Rider session archive failed: ${JSON.stringify(archived)}`);
    }

    const fitBytes = await exportSessionAsFit(archivedSession, {
        activityName: "Integration fallback ride"
    }, { markVirtualActivity: false });
    const form = new FormData();
    form.append("file", new Blob([fitBytes], { type: "application/octet-stream" }), "integration.fit");
    const fitResponse = await fetch(
        `${riderUrl}/api/activities/${encodeURIComponent(archivedSession.id)}/fit`,
        { method: "POST", body: form }
    );
    const fitActivity = await fitResponse.json();
    if (!fitResponse.ok
        || !fitActivity.activity?.fitFilePath
        || fitActivity.activity?.savedRouteId !== routeId
        || fitActivity.activity?.routeEndDistanceMeters !== 4250) {
        throw new Error(`FIT ingestion and route preservation failed: ${JSON.stringify(fitActivity)}`);
    }

    const canonical = await readJson(`${agentUrl}/api/activities/${encodeURIComponent(archivedSession.id)}/detail`);
    const stored = await readJson(`${agentUrl}/api/activities/${encodeURIComponent(archivedSession.id)}`);
    const projection = await readJson(`${agentUrl}/api/activities/${encodeURIComponent(archivedSession.id)}/detail?view=rider`);
    assert.deepEqual(projection, canonicalDetailToRiderActivity(canonical, stored.activity));
    assert.deepEqual(await readJson(`${browserUrl}/api/activities/${archivedSession.id}`),
                     await readJson(`${riderUrl}/api/activities/${archivedSession.id}`));
    assert.deepEqual(await readJson(`${browserUrl}/api/routes/${routeId}`),
                     await readJson(`${riderUrl}/api/routes/${routeId}`));
    assert.deepEqual(await readJson(`${browserUrl}/api/activities?sportType=cycling`),
                     await readJson(`${riderUrl}/api/activities?sportType=cycling`));

    async function multipart(base, endpoint, fields = {}, bytes = fitBytes) {
        const body = new FormData();
        body.append("file", new Blob([bytes]), "../../integration.fit");
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        const response = await fetch(base + endpoint, { method: "POST", body });
        return { status: response.status, payload: await response.json() };
    }
    const direct = await multipart(browserUrl, "/api/activities/fit-import", { name: "Direct import" });
    const proxied = await multipart(riderUrl, "/api/activities/fit-import", { name: "Direct import" });
    assert.equal(direct.status, 200);
    assert.equal(proxied.status, 200);
    assert.equal(direct.payload.activity.id, proxied.payload.activity.id);
    assert.equal(direct.payload.activity.fitFilePath, proxied.payload.activity.fitFilePath);
    assert.deepEqual(direct.payload.activity.rawSession.records, proxied.payload.activity.rawSession.records);
    const beaconSession = JSON.stringify({ ...archivedSession, id: "integration-beacon", activityId: "integration-beacon" });
    const beacon = await multipart(browserUrl, "/api/activities/fit-beacon", { session: beaconSession });
    assert.equal(beacon.status, 200);
    assert.equal(beacon.payload.activity.savedRouteId, routeId);
    const beaconAgain = await multipart(riderUrl, "/api/activities/fit-beacon", { session: beaconSession });
    assert.equal(beaconAgain.status, 200);
    assert.equal(beaconAgain.payload.activity.fitFilePath, beacon.payload.activity.fitFilePath);
    for (const base of [browserUrl, riderUrl]) {
        const invalid = await multipart(base, `/api/activities/${archivedSession.id}/fit`, {}, new Uint8Array([1, 2, 3]));
        assert.equal(invalid.status, 400);
        const preserved = await readJson(`${agentUrl}/api/activities/${archivedSession.id}`);
        assert.equal(preserved.activity.fitFilePath, fitActivity.activity.fitFilePath);
        const malformed = await multipart(base, "/api/activities/fit-beacon", { session: "[]" });
        assert.equal(malformed.status, 400);
    }
    console.log("[integration] Python/Node multipart import, attachment, beacon, duplicate identity, legacy view parity and invalid FIT preservation passed.");

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

async function assertAtomicRouteConfirmation() {
    const sessionId = "integration-route-confirm";
    const planId = "integration-plan";
    const candidateId = "integration-candidate";
    seedRoutePlan({
        plan_id: planId,
        workspace_id: `web-chat:${sessionId}`,
        schedule_type: "single_day",
        active_candidate_id: candidateId,
        planning: { status: "awaiting_selection" },
        candidates: [{
            candidate_id: candidateId,
            name: "Atomic integration route",
            distance_m: 1000,
            provider: "integration",
            travel_mode: "BICYCLE",
            geometry: {
                type: "LineString",
                coordinates: [[121, 31], [121.01, 31]]
            }
        }]
    });
    const savedRoute = {
        source: "agent",
        name: "Atomic integration route",
        agentPlanId: planId,
        agentCandidateId: candidateId,
        metadata: { planningStatus: "awaiting_selection", revision: 1 },
        route: {
            source: "agent-planned",
            name: "Atomic integration route",
            agentPlanId: planId,
            agentCandidateId: candidateId,
            totalDistanceMeters: 1000,
            totalElevationGainMeters: 0,
            hasElevationData: false,
            mapGeometry: [{ lat: 31, lng: 121 }, { lat: 31, lng: 121.01 }],
            points: [
                { latitude: 31, longitude: 121, distanceMeters: 0 },
                { latitude: 31, longitude: 121.01, distanceMeters: 1000 }
            ]
        }
    };
    const confirmed = await requestJson(`${riderUrl}/api/agent/route-plans/command`, {
        method: "POST",
        body: {
            session_id: sessionId,
            request_id: "integration-confirm-request",
            operation: "confirm",
            plan_id: planId,
            candidate_id: candidateId,
            expected_revision: 1,
            saved_route: savedRoute
        }
    });
    const savedRouteId = confirmed.result?.saved_route?.id;
    if (
        !confirmed.ok
        || confirmed.result?.route_plan?.planning_status !== "confirmed"
        || confirmed.result?.route_plan?.revision !== 2
        || !savedRouteId
    ) {
        throw new Error(`Atomic route confirmation failed: ${JSON.stringify(confirmed)}`);
    }

    const persistedPlan = await requestJson(`${riderUrl}/api/agent/route-plans/command`, {
        method: "POST",
        body: {
            session_id: sessionId,
            request_id: "integration-get-confirmed-plan",
            operation: "get",
            plan_id: planId
        }
    });
    if (
        persistedPlan.result?.route_plan?.planning_status !== "confirmed"
        || persistedPlan.result?.route_plan?.revision !== 2
    ) {
        throw new Error(`Confirmed route plan was not persisted: ${JSON.stringify(persistedPlan)}`);
    }
    const persistedRoute = await readJson(`${riderUrl}/api/routes/${encodeURIComponent(savedRouteId)}`);
    if (
        persistedRoute.route?.agentCandidateId !== candidateId
        || persistedRoute.route?.metadata?.planningStatus !== "confirmed"
        || persistedRoute.route?.metadata?.revision !== 2
        || persistedRoute.route?.route?.agentMetadata?.revision !== 2
    ) {
        throw new Error(`Confirmed SavedRoute was not persisted atomically: ${JSON.stringify(persistedRoute)}`);
    }
}

function seedRoutePlan(plan) {
    const script = [
        "import json, sys",
        "from storage.repositories.route import RoutePlanStore",
        "RoutePlanStore(sys.argv[1]).save(json.loads(sys.argv[2]))"
    ].join("; ");
    const result = spawnSync(python, ["-c", script, databasePath, JSON.stringify(plan)], {
        cwd: agentRoot,
        encoding: "utf8",
        env: {
            ...testEnv,
            PYTHONPATH: agentRoot,
            RIDER_PROJECT_ROOT: projectRoot,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1"
        }
    });
    if (result.status !== 0) {
        throw new Error(`Failed to seed route plan: ${result.stderr || result.stdout}`);
    }
}

function seedActivity(activity) {
    const script = [
        "import json, sys",
        "from storage.repositories.activity import ActivityStore",
        "ActivityStore(sys.argv[1]).upsert_activity(json.loads(sys.argv[2]))"
    ].join("; ");
    const result = spawnSync(python, ["-c", script, databasePath, JSON.stringify(activity)], {
        cwd: agentRoot,
        encoding: "utf8",
        env: {
            ...testEnv,
            PYTHONPATH: agentRoot,
            RIDER_PROJECT_ROOT: projectRoot,
            RIDER_TRACKER_DB_PATH: databasePath,
            TRAINING_AGENT_DB_PATH: databasePath,
            TRAINING_AGENT_MANAGED_DATABASE: "1",
            FIT_FILE_DIR: fitRoot
        }
    });
    if (result.status !== 0) {
        throw new Error(`Failed to seed activity: ${result.stderr || result.stdout}`);
    }
}

function initializeDatabase() {
    const result = spawnSync(python, [
        path.join(projectRoot, "scripts", "database-tool.py"), "init", "--database", databasePath
    ], {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
            ...testEnv,
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
