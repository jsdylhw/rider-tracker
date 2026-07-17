import { isCurrentRouteRequest, scaleRoutePointDistances } from "./route-planner-core.js";

const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROADS_API_ENDPOINT = "https://roads.googleapis.com/v1/nearestRoads";
const SAMPLE_SPACING_METERS = 40;
const MAX_ELEVATION_SAMPLES = 256;
const DEFAULT_CENTER = { lat: 31.2304, lng: 121.4737 };
const SIM_TICK_MS = 250;
const TURN_DESTINATION_METERS = 500;
const TURN_SEARCH_METERS = 50;
const TURN_CONTROL_MESSAGE_METERS = 20;
const TURN_APPLY_METERS = 5;
const TURN_SEARCH_INTERVAL_MS = 900;
const TURN_FORWARD_GRID_METERS = [5, 10, 15, 20, 30, 40, 50];
const TURN_SIDE_GRID_METERS = [5, 10, 15, 20];
const MAX_ROAD_SNAP_DISTANCE_METERS = 12;
const STRAIGHT_VIA_METERS = 240;
const STRAIGHT_DESTINATION_METERS = 800;
const SF_PRESET_GPX_URL = "./fixtures/san-francisco-grid.gpx";

const el = {
    apiKeyInput: document.getElementById("apiKeyInput"),
    loadMapBtn: document.getElementById("loadMapBtn"),
    loadSfPresetBtn: document.getElementById("loadSfPresetBtn"),
    resetBtn: document.getElementById("resetBtn"),
    planRouteBtn: document.getElementById("planRouteBtn"),
    statusText: document.getElementById("statusText"),
    originText: document.getElementById("originText"),
    destinationText: document.getElementById("destinationText"),
    distanceText: document.getElementById("distanceText"),
    ascentText: document.getElementById("ascentText"),
    pointCountText: document.getElementById("pointCountText"),
    averageGradeText: document.getElementById("averageGradeText"),
    routeJsonOutput: document.getElementById("routeJsonOutput"),
    copyJsonBtn: document.getElementById("copyJsonBtn"),
    simSpeedInput: document.getElementById("simSpeedInput"),
    startSimBtn: document.getElementById("startSimBtn"),
    pauseSimBtn: document.getElementById("pauseSimBtn"),
    resetSimBtn: document.getElementById("resetSimBtn"),
    turnLeftBtn: document.getElementById("turnLeftBtn"),
    turnStraightBtn: document.getElementById("turnStraightBtn"),
    turnRightBtn: document.getElementById("turnRightBtn"),
    simDistanceText: document.getElementById("simDistanceText"),
    simRemainingText: document.getElementById("simRemainingText"),
    simHeadingText: document.getElementById("simHeadingText"),
    simIntentText: document.getElementById("simIntentText"),
    chartMeta: document.getElementById("chartMeta"),
    routeChart: document.getElementById("routeChart")
};

const state = {
    apiKey: "",
    map: null,
    origin: null,
    destination: null,
    originMarker: null,
    destinationMarker: null,
    routePolyline: null,
    simMarker: null,
    riderRoute: null,
    planning: false,
    routePlanGeneration: 0,
    sim: {
        running: false,
        timer: null,
        lastTickMs: 0,
        distanceMeters: 0,
        turnPlanning: false,
        pendingIntent: null,
        plannedTurn: null,
        lastTurnSearchMs: 0
    }
};

bindEvents();
renderEmptyChart();
render();

function bindEvents() {
    el.loadMapBtn.addEventListener("click", loadMap);
    el.loadSfPresetBtn.addEventListener("click", loadSanFranciscoPreset);
    el.resetBtn.addEventListener("click", resetSelection);
    el.planRouteBtn.addEventListener("click", planRoute);
    el.copyJsonBtn.addEventListener("click", copyRouteJson);
    el.startSimBtn.addEventListener("click", startSimulation);
    el.pauseSimBtn.addEventListener("click", pauseSimulation);
    el.resetSimBtn.addEventListener("click", resetSimulation);
    el.turnLeftBtn.addEventListener("click", () => queueTurn("left"));
    el.turnStraightBtn.addEventListener("click", () => queueTurn("straight"));
    el.turnRightBtn.addEventListener("click", () => queueTurn("right"));
}

async function loadMap() {
    const apiKey = el.apiKeyInput.value.trim();
    if (!apiKey) {
        setStatus("请输入 Google Maps API Key。", true);
        return;
    }

    state.apiKey = apiKey;
    el.loadMapBtn.disabled = true;
    el.loadMapBtn.textContent = "加载中...";

    try {
        await loadGoogleMaps(apiKey);
        state.map = new google.maps.Map(document.getElementById("map"), {
            center: DEFAULT_CENTER,
            zoom: 12,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true
        });
        state.map.addListener("click", (event) => {
            handleMapClick({
                lat: event.latLng.lat(),
                lng: event.latLng.lng()
            });
        });
        setStatus("地图已加载。点击地图选择起点，再点击选择终点。", false, true);
    } catch (error) {
        setStatus(`地图加载失败：${getMessage(error)}`, true);
    } finally {
        el.loadMapBtn.disabled = false;
        el.loadMapBtn.textContent = "加载地图";
        render();
    }
}

async function loadSanFranciscoPreset() {
    if (!state.map) {
        setStatus("请先加载地图。", true);
        return;
    }

    const presetGeneration = invalidateRoutePlan();

    try {
        setStatus("正在加载旧金山 GPX 预设...");
        const response = await fetch(SF_PRESET_GPX_URL);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const gpxText = await response.text();
        const path = parseGpxPath(gpxText);
        if (path.length < 2) {
            throw new Error("GPX 点数不足。");
        }
        if (!isCurrentRoutePlan(presetGeneration)) return;

        pauseSimulation();
        clearRoutePreview();
        state.origin = path[0];
        state.destination = path.at(-1);
        setMarker("origin", state.origin);
        setMarker("destination", state.destination);
        drawRoute(path);

        state.riderRoute = buildRiderRoute({
            routeResult: { distanceMeters: null, duration: null },
            points: buildFlatElevationPoints(path),
            elevationAvailable: false
        });
        resetSimulation();
        renderRouteResult();
        setStatus("已加载旧金山网格 GPX（平坡），适合测试 50m 内转向。", false, true);
    } catch (error) {
        if (isCurrentRoutePlan(presetGeneration)) {
            setStatus(`旧金山 GPX 加载失败：${getMessage(error)}`, true);
        }
    } finally {
        if (isCurrentRoutePlan(presetGeneration)) {
            render();
        }
    }
}

function handleMapClick(point) {
    if (!state.map) return;

    invalidateRoutePlan();

    if (!state.origin || (state.origin && state.destination)) {
        clearRoutePreview();
        state.origin = point;
        state.destination = null;
        state.riderRoute = null;
        setMarker("origin", point);
        if (state.destinationMarker) {
            state.destinationMarker.setMap(null);
            state.destinationMarker = null;
        }
        setStatus("已选择起点。继续点击地图选择终点。");
    } else {
        state.destination = point;
        setMarker("destination", point);
        fitSelectedBounds();
        setStatus("已选择终点。点击“生成路线”。");
    }

    render();
}

async function planRoute() {
    if (!state.origin || !state.destination || !state.apiKey || state.planning) {
        return;
    }

    const routePlanGeneration = ++state.routePlanGeneration;
    state.planning = true;
    setStatus("正在请求 Google Routes API...");
    render();

    try {
        const routeResult = await fetchRoutePolyline({
            apiKey: state.apiKey,
            origin: state.origin,
            destination: state.destination,
            fieldMask: "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs"
        });
        if (!isCurrentRoutePlan(routePlanGeneration)) return;

        const decodedPath = decodePolyline(routeResult.encodedPolyline);
        if (decodedPath.length < 2) {
            throw new Error("Routes API 返回的路线点不足。");
        }

        drawRoute(decodedPath);
        setStatus("路线已生成，正在构建平坡 route...");

        const sampledPath = samplePathByDistance(decodedPath, SAMPLE_SPACING_METERS, MAX_ELEVATION_SAMPLES);
        state.riderRoute = buildRiderRoute({
            routeResult,
            points: buildFlatElevationPoints(sampledPath),
            elevationAvailable: false
        });
        resetSimulation();
        renderRouteResult();
        setStatus("路线生成完成（demo 暂不请求海拔，按平坡处理）。", false, true);
    } catch (error) {
        if (isCurrentRoutePlan(routePlanGeneration)) {
            setStatus(`生成路线失败：${getMessage(error)}`, true);
        }
    } finally {
        if (isCurrentRoutePlan(routePlanGeneration)) {
            state.planning = false;
            render();
        }
    }
}

async function fetchRoutePolyline({ apiKey, origin, destination, intermediates = [], fieldMask }) {
    const body = {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        polylineQuality: "HIGH_QUALITY"
    };
    if (intermediates.length > 0) {
        body.intermediates = intermediates.map((point) => ({
            location: { latLng: { latitude: point.lat, longitude: point.lng } }
        }));
    }

    const response = await fetch(ROUTES_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": fieldMask ?? "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline"
        },
        body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Routes API HTTP ${response.status}: ${formatApiError(data)}`);
    }

    if (!Array.isArray(data?.routes) || data.routes.length === 0) {
        throw new Error(`Routes API 没有找到可用路线：${formatApiError(data)}`);
    }

    const route = data.routes?.[0];
    const encodedPolyline = route?.polyline?.encodedPolyline;
    if (!encodedPolyline) {
        throw new Error(`Routes API 未返回 polyline。响应摘要：${summarizeApiResponse(data)}`);
    }

    return {
        encodedPolyline,
        distanceMeters: route.distanceMeters ?? null,
        duration: route.duration ?? null
    };
}

function startSimulation() {
    if (!state.riderRoute || state.sim.running) return;
    state.sim.running = true;
    state.sim.lastTickMs = performance.now();
    state.sim.timer = window.setInterval(simulationTick, SIM_TICK_MS);
    setStatus("动态骑行模拟已开始。");
    render();
}

function pauseSimulation() {
    if (state.sim.timer) {
        window.clearInterval(state.sim.timer);
        state.sim.timer = null;
    }
    state.sim.running = false;
    setStatus("动态骑行模拟已暂停。");
    render();
}

function resetSimulation() {
    pauseSimulation();
    state.sim.distanceMeters = 0;
    resetTurnState();
    updateSimulationMarker();
    renderSimulation();
    render();
}

function resetTurnState() {
    state.sim.turnPlanning = false;
    state.sim.pendingIntent = null;
    state.sim.plannedTurn = null;
    state.sim.lastTurnSearchMs = 0;
}

function simulationTick() {
    if (!state.riderRoute || !state.sim.running) return;
    const now = performance.now();
    const deltaSeconds = Math.max(0, (now - state.sim.lastTickMs) / 1000);
    state.sim.lastTickMs = now;
    const speedKph = clamp(Number(el.simSpeedInput.value), 5, 60);
    state.sim.distanceMeters = Math.min(
        state.riderRoute.totalDistanceMeters,
        state.sim.distanceMeters + (speedKph / 3.6) * deltaSeconds
    );
    updateSimulationMarker();
    renderSimulation();
    updatePendingTurn();
    if (state.sim.distanceMeters >= state.riderRoute.totalDistanceMeters) {
        if (!state.sim.turnPlanning && !state.sim.pendingIntent) {
            setStatus("已到达路线末端，正在延伸前方路线...");
            queueTurn("straight");
        }
    }
}

function queueTurn(intent) {
    if (!state.riderRoute || !state.apiKey || state.sim.turnPlanning) return;
    state.sim.pendingIntent = intent;
    state.sim.plannedTurn = null;
    state.sim.lastTurnSearchMs = 0;
    el.simIntentText.textContent = `${getIntentLabel(intent)}已输入 · 搜索前方 ${TURN_SEARCH_METERS}m 内路口`;
    setStatus(`${getIntentLabel(intent)}命令已输入，将在前方 ${TURN_SEARCH_METERS}m 内寻找可转向道路。`);
    render();
    void updatePendingTurn(true);
}

function updatePendingTurn(force = false) {
    if (!state.riderRoute || !state.apiKey || !state.sim.pendingIntent) return;

    if (state.sim.plannedTurn) {
        const remainingToTurn = state.sim.plannedTurn.anchorDistance - state.sim.distanceMeters;
        if (remainingToTurn <= TURN_CONTROL_MESSAGE_METERS && remainingToTurn > TURN_APPLY_METERS) {
            el.simIntentText.textContent = `前方 ${Math.max(0, Math.round(remainingToTurn))}m ${getIntentLabel(state.sim.pendingIntent)}`;
        }
        if (remainingToTurn <= TURN_APPLY_METERS) {
            void applyPlannedTurn();
        }
        return;
    }

    const now = performance.now();
    if (!force && now - state.sim.lastTurnSearchMs < TURN_SEARCH_INTERVAL_MS) return;
    if (state.sim.turnPlanning) return;
    state.sim.lastTurnSearchMs = now;
    void searchPendingTurn();
}

async function searchPendingTurn() {
    if (!state.sim.pendingIntent || state.sim.turnPlanning) return;
    const intent = state.sim.pendingIntent;
    state.sim.turnPlanning = true;
    el.simIntentText.textContent = `${getIntentLabel(intent)} · 扫描前方 ${TURN_SEARCH_METERS}m 路口...`;
    render();

    try {
        const result = await findTurnRoute({ intent });
        if (!result) {
            el.simIntentText.textContent = `${getIntentLabel(intent)}待执行 · 暂未发现路口`;
            return;
        }
        if (result.anchorDistance <= state.sim.distanceMeters && intent !== "straight") {
            return;
        }
        state.sim.plannedTurn = result;
        const remainingToTurn = result.anchorDistance - state.sim.distanceMeters;
        const extensionMeters = result.extensionMeters ?? TURN_DESTINATION_METERS;
        setStatus(`${getIntentLabel(intent)}路线已预生成：约 ${Math.max(0, Math.round(remainingToTurn))}m 后转向，并接入约 ${extensionMeters}m 后续路线。`, false, true);
        el.simIntentText.textContent = remainingToTurn <= TURN_CONTROL_MESSAGE_METERS
            ? `前方 ${Math.max(0, Math.round(remainingToTurn))}m ${getIntentLabel(intent)}`
            : `${getIntentLabel(intent)}已规划 · ${Math.round(remainingToTurn)}m 后提示`;
    } catch (error) {
        setStatus(`${getIntentLabel(intent)}搜索失败：${getMessage(error)}`, true);
        el.simIntentText.textContent = `${getIntentLabel(intent)}失败`;
    } finally {
        state.sim.turnPlanning = false;
        render();
    }
}

async function applyPlannedTurn() {
    const plannedTurn = state.sim.plannedTurn;
    const intent = state.sim.pendingIntent;
    if (!plannedTurn || !intent || state.sim.turnPlanning) return;

    state.sim.turnPlanning = true;
    try {
        await applyTurnRoute(plannedTurn);
        state.sim.pendingIntent = null;
        state.sim.plannedTurn = null;
        state.sim.lastTurnSearchMs = 0;
        setStatus(`${getIntentLabel(intent)}已执行，已接入新的后续路线。`, false, true);
        el.simIntentText.textContent = `${getIntentLabel(intent)}已接入`;
    } catch (error) {
        setStatus(`${getIntentLabel(intent)}接入失败：${getMessage(error)}`, true);
        el.simIntentText.textContent = `${getIntentLabel(intent)}接入失败`;
    } finally {
        state.sim.turnPlanning = false;
        render();
    }
}

async function findTurnRoute({ intent }) {
    if (intent === "straight") {
        return findStraightRoute();
    }
    return findSideTurnRoute({ intent });
}

async function findStraightRoute() {
    const anchorDistance = Math.min(
        state.riderRoute.totalDistanceMeters,
        state.sim.distanceMeters + TURN_APPLY_METERS
    );
    const anchor = getRoutePointAtDistance(state.riderRoute, anchorDistance);
    const heading = getRouteHeadingAtDistance(state.riderRoute, anchorDistance);
    const via = projectPoint(anchor, heading, STRAIGHT_VIA_METERS);
    const destination = projectPoint(anchor, heading, STRAIGHT_DESTINATION_METERS);
    const routeResult = await fetchRoutePolyline({
        apiKey: state.apiKey,
        origin: anchor,
        destination,
        intermediates: [via]
    }).catch(() => null);
    if (!routeResult) return null;

    const decodedPath = decodePolyline(routeResult.encodedPolyline);
    if (!isRouteHeadingCompatible({ intent: "straight", oldHeading: heading, newPath: decodedPath })) {
        return null;
    }

    return {
        anchorDistance,
        offsetMeters: TURN_APPLY_METERS,
        extensionMeters: STRAIGHT_DESTINATION_METERS,
        routeResult,
        decodedPath
    };
}

async function findSideTurnRoute({ intent }) {
    const candidates = await findSideRoadCandidates(intent);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
        const destination = projectPoint(
            candidate.snappedSide.location,
            candidate.turnHeading,
            TURN_DESTINATION_METERS
        );

        const routeResult = await fetchRoutePolyline({
            apiKey: state.apiKey,
            origin: candidate.anchor,
            destination,
            intermediates: [candidate.snappedSide.location]
        }).catch(() => null);
        if (!routeResult) continue;

        const decodedPath = decodePolyline(routeResult.encodedPolyline);
        if (!isRouteHeadingCompatible({ intent, oldHeading: candidate.routeHeading, newPath: decodedPath })) {
            continue;
        }

        return {
            anchorDistance: candidate.anchorDistance,
            offsetMeters: candidate.offsetMeters,
            extensionMeters: TURN_DESTINATION_METERS,
            routeResult,
            decodedPath
        };
    }

    return null;
}

async function findSideRoadCandidates(intent) {
    const headingOffset = intent === "left" ? -90 : 90;
    const probes = [];
    for (const forwardMeters of TURN_FORWARD_GRID_METERS) {
        const anchorDistance = Math.min(
            state.riderRoute.totalDistanceMeters,
            state.sim.distanceMeters + forwardMeters
        );
        const anchor = getRoutePointAtDistance(state.riderRoute, anchorDistance);
        const routeHeading = getRouteHeadingAtDistance(state.riderRoute, anchorDistance);
        probes.push({
            type: "anchor",
            forwardMeters,
            sideMeters: 0,
            anchorDistance,
            anchor,
            routeHeading,
            point: anchor
        });

        for (const sideMeters of TURN_SIDE_GRID_METERS) {
            const point = projectPoint(anchor, routeHeading + headingOffset, sideMeters);
            probes.push({
                type: "side",
                forwardMeters,
                sideMeters,
                anchorDistance,
                anchor,
                routeHeading,
                point
            });
        }
    }

    const indexedProbes = probes.map((probe, index) => ({ ...probe, index }));
    const snapped = await snapPointsToRoads(indexedProbes.map((probe) => probe.point));
    if (!snapped) return [];

    const candidates = [];
    for (const anchorProbe of indexedProbes.filter((probe) => probe.type === "anchor")) {
        const snappedAnchor = snapped[anchorProbe.index];
        if (!snappedAnchor) continue;

        const sideProbes = indexedProbes
            .filter((probe) => probe.type === "side" && probe.forwardMeters === anchorProbe.forwardMeters);

        for (const sideProbe of sideProbes) {
            const snappedSide = snapped[sideProbe.index];
            if (!snappedSide || snappedSide.placeId === snappedAnchor.placeId) continue;
            const snapDistance = haversineDistanceMeters(sideProbe.point, snappedSide.location);
            if (snapDistance > MAX_ROAD_SNAP_DISTANCE_METERS) continue;

            const turnHeading = bearingDegrees(snappedAnchor.location, snappedSide.location);
            const diff = signedAngleDegrees(anchorProbe.routeHeading, turnHeading);
            if (intent === "right" && (diff < 25 || diff > 160)) continue;
            if (intent === "left" && (diff > -25 || diff < -160)) continue;

            candidates.push({
                anchorDistance: anchorProbe.anchorDistance,
                offsetMeters: anchorProbe.forwardMeters,
                anchor: anchorProbe.anchor,
                routeHeading: anchorProbe.routeHeading,
                snappedAnchor,
                snappedSide,
                turnHeading
            });
        }
    }

    return candidates;
}

async function snapPointsToRoads(points) {
    const coords = points
        .map((p) => `${p.lat},${p.lng}`)
        .join("|");

    try {
        const response = await fetch(
            `${ROADS_API_ENDPOINT}?points=${encodeURIComponent(coords)}&key=${encodeURIComponent(state.apiKey)}`
        );
        if (!response.ok) return null;
        const data = await response.json();
        if (!Array.isArray(data.snappedPoints) || data.snappedPoints.length === 0) {
            return null;
        }
        const snappedByIndex = [];
        for (let fallbackIndex = 0; fallbackIndex < data.snappedPoints.length; fallbackIndex += 1) {
            const snappedPoint = data.snappedPoints[fallbackIndex];
            const index = Number.isInteger(snappedPoint.originalIndex)
                ? snappedPoint.originalIndex
                : fallbackIndex;
            if (!Number.isInteger(index) || snappedByIndex[index]) continue;
            snappedByIndex[index] = {
                location: { lat: snappedPoint.location.latitude, lng: snappedPoint.location.longitude },
                placeId: snappedPoint.placeId
            };
        }
        return snappedByIndex;
    } catch {
        return null;
    }
}

async function applyTurnRoute({ anchorDistance, routeResult, decodedPath }) {
    const prefix = sliceRoutePointsUntilDistance(state.riderRoute, anchorDistance);
    const sampledPath = samplePathByDistance(decodedPath, SAMPLE_SPACING_METERS, MAX_ELEVATION_SAMPLES);
    const segmentRoute = buildRiderRoute({
        routeResult,
        points: buildFlatElevationPoints(sampledPath),
        elevationAvailable: false
    });
    const merged = mergeRoutes(prefix, segmentRoute);
    state.riderRoute = merged;
    drawRoute(merged.points.map((point) => ({ lat: point.latitude, lng: point.longitude })));
    renderRouteResult();
    updateSimulationMarker();
}

function buildFlatElevationPoints(points) {
    return points.map((point) => ({
        lat: point.lat,
        lng: point.lng,
        elevationMeters: 0
    }));
}

function buildRiderRoute({ routeResult, points, elevationAvailable = true }) {
    let totalDistanceMeters = 0;
    let totalAscentMeters = 0;
    const routePoints = [];

    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const previous = points[index - 1];
        let segmentDistance = 0;
        let gradePercent = 0;

        if (previous) {
            segmentDistance = haversineDistanceMeters(previous, point);
            totalDistanceMeters += segmentDistance;
            const elevationDelta = point.elevationMeters - previous.elevationMeters;
            if (elevationDelta > 0) {
                totalAscentMeters += elevationDelta;
            }
            gradePercent = segmentDistance > 1
                ? clamp((elevationDelta / segmentDistance) * 100, -25, 25)
                : 0;
        }

        routePoints.push({
            latitude: round(point.lat, 7),
            longitude: round(point.lng, 7),
            elevationMeters: round(point.elevationMeters, 1),
            distanceMeters: round(totalDistanceMeters, 1),
            gradePercent: round(gradePercent, 2)
        });
    }

    const finalDistanceMeters = routeResult.distanceMeters ?? totalDistanceMeters;
    const normalizedRoutePoints = scaleRoutePointDistances(routePoints, finalDistanceMeters);
    smoothGrades(normalizedRoutePoints);

    const distanceKm = finalDistanceMeters / 1000;
    const averageGradePercent = finalDistanceMeters > 0
        ? ((normalizedRoutePoints.at(-1)?.elevationMeters ?? 0) - (normalizedRoutePoints[0]?.elevationMeters ?? 0)) / finalDistanceMeters * 100
        : 0;

    return {
        name: "地图规划路线",
        source: elevationAvailable ? "google-route-demo" : "google-route-demo-flat",
        generatedAt: new Date().toISOString(),
        elevationAvailable,
        totalDistanceMeters: round(finalDistanceMeters, 1),
        totalDistanceKm: round(distanceKm, 3),
        totalAscentMeters: round(totalAscentMeters, 1),
        averageGradePercent: round(averageGradePercent, 2),
        durationText: routeResult.duration ?? null,
        points: normalizedRoutePoints,
        segments: [
            {
                name: "地图规划路线",
                distanceKm: round(distanceKm, 3),
                gradePercent: round(averageGradePercent, 2)
            }
        ]
    };
}

function smoothGrades(routePoints) {
    const original = routePoints.map((point) => point.gradePercent ?? 0);
    for (let index = 0; index < routePoints.length; index += 1) {
        const start = Math.max(0, index - 2);
        const end = Math.min(routePoints.length - 1, index + 2);
        let sum = 0;
        let count = 0;
        for (let cursor = start; cursor <= end; cursor += 1) {
            sum += original[cursor];
            count += 1;
        }
        routePoints[index].gradePercent = round(sum / count, 2);
    }
}

function samplePathByDistance(points, spacingMeters, maxSamples) {
    if (points.length <= 2) return points;

    const distances = [0];
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
        total += haversineDistanceMeters(points[index - 1], points[index]);
        distances.push(total);
    }

    const targetCount = Math.min(maxSamples, Math.max(2, Math.ceil(total / spacingMeters) + 1));
    const actualSpacing = total / (targetCount - 1);
    const sampled = [];

    for (let sampleIndex = 0; sampleIndex < targetCount; sampleIndex += 1) {
        const targetDistance = sampleIndex === targetCount - 1 ? total : sampleIndex * actualSpacing;
        sampled.push(interpolateAtDistance(points, distances, targetDistance));
    }

    return sampled;
}

function interpolateAtDistance(points, distances, targetDistance) {
    if (targetDistance <= 0) return points[0];
    const lastIndex = points.length - 1;
    if (targetDistance >= distances[lastIndex]) return points[lastIndex];

    let upper = 1;
    while (upper < distances.length && distances[upper] < targetDistance) {
        upper += 1;
    }
    const lower = Math.max(0, upper - 1);
    const span = distances[upper] - distances[lower];
    const ratio = span > 0 ? (targetDistance - distances[lower]) / span : 0;

    return {
        lat: points[lower].lat + (points[upper].lat - points[lower].lat) * ratio,
        lng: points[lower].lng + (points[upper].lng - points[lower].lng) * ratio
    };
}

function decodePolyline(encoded) {
    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates = [];

    while (index < encoded.length) {
        const latResult = decodePolylineValue(encoded, index);
        index = latResult.nextIndex;
        lat += latResult.delta;

        const lngResult = decodePolylineValue(encoded, index);
        index = lngResult.nextIndex;
        lng += lngResult.delta;

        coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }

    return coordinates;
}

function decodePolylineValue(encoded, startIndex) {
    let result = 0;
    let shift = 0;
    let index = startIndex;
    let byte = null;

    do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
    return { delta, nextIndex: index };
}

function drawRoute(points) {
    if (!state.map) return;
    if (state.routePolyline) {
        state.routePolyline.setMap(null);
    }

    state.routePolyline = new google.maps.Polyline({
        path: points,
        map: state.map,
        strokeColor: "#0ea5e9",
        strokeOpacity: 0.92,
        strokeWeight: 5
    });

    const bounds = new google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point));
    state.map.fitBounds(bounds, 48);
}

function setMarker(kind, point) {
    const markerKey = kind === "origin" ? "originMarker" : "destinationMarker";
    if (state[markerKey]) {
        state[markerKey].setMap(null);
    }

    state[markerKey] = new google.maps.Marker({
        map: state.map,
        position: point,
        label: kind === "origin" ? "起" : "终",
        title: kind === "origin" ? "起点" : "终点"
    });
}

function fitSelectedBounds() {
    if (!state.map || !state.origin || !state.destination) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(state.origin);
    bounds.extend(state.destination);
    state.map.fitBounds(bounds, 80);
}

function resetSelection() {
    invalidateRoutePlan();
    pauseSimulation();
    state.origin = null;
    state.destination = null;
    state.riderRoute = null;
    state.sim.distanceMeters = 0;
    resetTurnState();
    clearRoutePreview();
    setStatus("已清空。点击地图选择新的起点。");
    renderEmptyChart();
    renderSimulation();
    render();
}

function invalidateRoutePlan() {
    state.routePlanGeneration += 1;
    state.planning = false;
    return state.routePlanGeneration;
}

function isCurrentRoutePlan(routePlanGeneration) {
    return isCurrentRouteRequest(routePlanGeneration, state.routePlanGeneration);
}

function clearRoutePreview() {
    if (state.originMarker) {
        state.originMarker.setMap(null);
        state.originMarker = null;
    }
    if (state.destinationMarker) {
        state.destinationMarker.setMap(null);
        state.destinationMarker = null;
    }
    if (state.routePolyline) {
        state.routePolyline.setMap(null);
        state.routePolyline = null;
    }
    if (state.simMarker) {
        state.simMarker.setMap(null);
        state.simMarker = null;
    }
    el.routeJsonOutput.value = "";
}

function renderRouteResult() {
    const route = state.riderRoute;
    if (!route) return;

    el.distanceText.textContent = `${route.totalDistanceKm.toFixed(2)} km`;
    el.ascentText.textContent = `${route.totalAscentMeters.toFixed(0)} m`;
    el.pointCountText.textContent = String(route.points.length);
    el.averageGradeText.textContent = "平坡 demo";
    el.routeJsonOutput.value = JSON.stringify(route, null, 2);
    el.chartMeta.textContent = `${route.totalDistanceKm.toFixed(2)} km · ${route.points.length} 个路线点`;
    renderRouteChart(route);
}

function render() {
    el.loadSfPresetBtn.disabled = !state.map;
    el.resetBtn.disabled = !state.map || (!state.origin && !state.destination && !state.riderRoute);
    el.planRouteBtn.disabled = !state.map || !state.origin || !state.destination || state.planning;
    el.copyJsonBtn.disabled = !state.riderRoute;
    el.startSimBtn.disabled = !state.riderRoute || state.sim.running || state.sim.turnPlanning;
    el.pauseSimBtn.disabled = !state.sim.running;
    el.resetSimBtn.disabled = !state.riderRoute || state.sim.turnPlanning;
    const turnDisabled = !state.riderRoute || state.sim.turnPlanning;
    el.turnLeftBtn.disabled = turnDisabled;
    el.turnStraightBtn.disabled = turnDisabled;
    el.turnRightBtn.disabled = turnDisabled;
    el.originText.textContent = state.origin ? formatPoint(state.origin) : "未选择";
    el.destinationText.textContent = state.destination ? formatPoint(state.destination) : "未选择";
    if (!state.riderRoute) {
        el.distanceText.textContent = "--";
        el.ascentText.textContent = "--";
        el.pointCountText.textContent = "--";
        el.averageGradeText.textContent = "--";
    }
    el.planRouteBtn.textContent = state.planning ? "生成中..." : "生成路线";
    renderSimulation();
}

function renderSimulation() {
    if (!state.riderRoute) {
        el.simDistanceText.textContent = "--";
        el.simRemainingText.textContent = "--";
        el.simHeadingText.textContent = "--";
        el.simIntentText.textContent = "等待路线";
        return;
    }
    const total = state.riderRoute.totalDistanceMeters;
    const distance = Math.min(total, state.sim.distanceMeters);
    const remaining = Math.max(0, total - distance);
    const heading = getRouteHeadingAtDistance(state.riderRoute, distance);
    el.simDistanceText.textContent = `${(distance / 1000).toFixed(2)} / ${(total / 1000).toFixed(2)} km`;
    el.simRemainingText.textContent = `${Math.round(remaining)} m`;
    el.simHeadingText.textContent = `${Math.round(heading)}°`;
    if (!state.sim.turnPlanning && el.simIntentText.textContent === "等待路线") {
        el.simIntentText.textContent = "可输入方向";
    }
}

function updateSimulationMarker() {
    if (!state.map || !state.riderRoute) return;
    const point = getRoutePointAtDistance(state.riderRoute, state.sim.distanceMeters);
    const position = { lat: point.lat, lng: point.lng };
    if (!state.simMarker) {
        state.simMarker = new google.maps.Marker({
            map: state.map,
            position,
            label: "骑",
            title: "模拟当前位置"
        });
    } else {
        state.simMarker.setPosition(position);
    }
}

function getRoutePointAtDistance(route, distanceMeters) {
    const points = route.points ?? [];
    if (points.length === 0) return DEFAULT_CENTER;
    if (distanceMeters <= 0) return routePointToLatLng(points[0]);
    const last = points.at(-1);
    if (distanceMeters >= last.distanceMeters) return routePointToLatLng(last);

    const upperIndex = points.findIndex((point) => point.distanceMeters >= distanceMeters);
    const upper = points[Math.max(1, upperIndex)];
    const lower = points[Math.max(0, upperIndex - 1)];
    const span = Math.max(1, upper.distanceMeters - lower.distanceMeters);
    const ratio = (distanceMeters - lower.distanceMeters) / span;
    return {
        lat: lower.latitude + (upper.latitude - lower.latitude) * ratio,
        lng: lower.longitude + (upper.longitude - lower.longitude) * ratio
    };
}

function getRouteHeadingAtDistance(route, distanceMeters) {
    const from = getRoutePointAtDistance(route, distanceMeters);
    const to = getRoutePointAtDistance(route, Math.min(route.totalDistanceMeters, distanceMeters + 40));
    return bearingDegrees(from, to);
}

function sliceRoutePointsUntilDistance(route, anchorDistance) {
    const points = route.points ?? [];
    const sliced = points.filter((point) => point.distanceMeters < anchorDistance);
    const anchor = getRoutePointAtDistance(route, anchorDistance);
    const anchorSource = findNearestRoutePoint(route, anchorDistance);
    sliced.push({
        latitude: round(anchor.lat, 7),
        longitude: round(anchor.lng, 7),
        elevationMeters: anchorSource?.elevationMeters ?? 0,
        distanceMeters: round(anchorDistance, 1),
        gradePercent: anchorSource?.gradePercent ?? 0
    });
    return {
        ...route,
        points: sliced,
        totalDistanceMeters: round(anchorDistance, 1),
        totalDistanceKm: round(anchorDistance / 1000, 3)
    };
}

function mergeRoutes(prefixRoute, segmentRoute) {
    const prefixPoints = prefixRoute.points ?? [];
    const baseDistance = prefixPoints.at(-1)?.distanceMeters ?? 0;
    const mergedPoints = [...prefixPoints];
    for (const point of segmentRoute.points.slice(1)) {
        mergedPoints.push({
            ...point,
            distanceMeters: round(baseDistance + point.distanceMeters, 1)
        });
    }
    const totalDistanceMeters = mergedPoints.at(-1)?.distanceMeters ?? 0;
    const totalAscentMeters = computeTotalAscent(mergedPoints);
    const averageGradePercent = totalDistanceMeters > 0
        ? ((mergedPoints.at(-1)?.elevationMeters ?? 0) - (mergedPoints[0]?.elevationMeters ?? 0)) / totalDistanceMeters * 100
        : 0;
    return {
        ...prefixRoute,
        name: "动态规划路线",
        source: "google-route-dynamic-demo",
        totalDistanceMeters: round(totalDistanceMeters, 1),
        totalDistanceKm: round(totalDistanceMeters / 1000, 3),
        totalAscentMeters: round(totalAscentMeters, 1),
        averageGradePercent: round(averageGradePercent, 2),
        points: mergedPoints,
        segments: [
            {
                name: "动态规划路线",
                distanceKm: round(totalDistanceMeters / 1000, 3),
                gradePercent: round(averageGradePercent, 2)
            }
        ]
    };
}

function isRouteHeadingCompatible({ intent, oldHeading, newPath }) {
    if (newPath.length < 2) return false;
    const newHeading = bearingDegrees(newPath[0], newPath[Math.min(newPath.length - 1, 5)]);
    const diff = signedAngleDegrees(oldHeading, newHeading);
    if (intent === "right") return diff >= 25 && diff <= 160;
    if (intent === "left") return diff <= -25 && diff >= -160;
    return Math.abs(diff) <= 45;
}

function findNearestRoutePoint(route, distanceMeters) {
    return (route.points ?? []).reduce((nearest, point) => (
        Math.abs(point.distanceMeters - distanceMeters) < Math.abs((nearest?.distanceMeters ?? 0) - distanceMeters)
            ? point
            : nearest
    ), null);
}

function computeTotalAscent(points) {
    let ascent = 0;
    for (let index = 1; index < points.length; index += 1) {
        const delta = points[index].elevationMeters - points[index - 1].elevationMeters;
        if (delta > 0) ascent += delta;
    }
    return ascent;
}

function routePointToLatLng(point) {
    return { lat: point.latitude, lng: point.longitude };
}

function getIntentLabel(intent) {
    if (intent === "left") return "左拐";
    if (intent === "right") return "右拐";
    return "直行";
}

function projectPoint(point, headingDegrees, distanceMeters) {
    const radius = 6371000;
    const angularDistance = distanceMeters / radius;
    const heading = toRadians(headingDegrees);
    const lat1 = toRadians(point.lat);
    const lng1 = toRadians(point.lng);
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance)
        + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(heading)
    );
    const lng2 = lng1 + Math.atan2(
        Math.sin(heading) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
    return {
        lat: lat2 * 180 / Math.PI,
        lng: normalizeLng(lng2 * 180 / Math.PI)
    };
}

function bearingDegrees(from, to) {
    const lat1 = toRadians(from.lat);
    const lat2 = toRadians(to.lat);
    const deltaLng = toRadians(to.lng - from.lng);
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function normalizeHeading(heading) {
    return ((heading % 360) + 360) % 360;
}

function signedAngleDegrees(fromHeading, toHeading) {
    return ((toHeading - fromHeading + 540) % 360) - 180;
}

function normalizeLng(lng) {
    return ((lng + 540) % 360) - 180;
}

function renderEmptyChart() {
    el.chartMeta.textContent = "等待生成路线";
    el.routeChart.innerHTML = `<text x="450" y="125" text-anchor="middle" class="empty-chart-text">选择起点和终点后生成路线</text>`;
}

function renderRouteChart(route) {
    const points = route.points ?? [];
    if (points.length < 2) {
        renderEmptyChart();
        return;
    }

    const width = 900;
    const height = 240;
    const padding = { left: 44, right: 18, top: 18, bottom: 34 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const maxDistance = Math.max(1, points.at(-1).distanceMeters);
    const elevations = points.map((point) => point.elevationMeters);
    const minElevation = Math.min(...elevations);
    const maxElevation = Math.max(...elevations);
    const elevationSpan = Math.max(1, maxElevation - minElevation);

    const toX = (point) => padding.left + (point.distanceMeters / maxDistance) * innerWidth;
    const toY = (point) => padding.top + (1 - ((point.elevationMeters - minElevation) / elevationSpan)) * innerHeight;

    const linePath = points
        .map((point, index) => `${index === 0 ? "M" : "L"} ${toX(point).toFixed(1)} ${toY(point).toFixed(1)}`)
        .join(" ");
    const areaPath = `${linePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`;
    const bars = points
        .filter((_, index) => index % Math.max(1, Math.floor(points.length / 80)) === 0)
        .map((point) => {
            const grade = point.gradePercent ?? 0;
            const x = toX(point);
            const y = padding.top + innerHeight / 2;
            const barHeight = Math.min(innerHeight / 2, Math.abs(grade) / 15 * (innerHeight / 2));
            const color = grade >= 0 ? "#f97316" : "#38bdf8";
            const top = grade >= 0 ? y - barHeight : y;
            return `<rect x="${(x - 2).toFixed(1)}" y="${top.toFixed(1)}" width="4" height="${Math.max(1, barHeight).toFixed(1)}" fill="${color}" opacity="0.45"/>`;
        })
        .join("");

    el.routeChart.innerHTML = `
        <rect x="0" y="0" width="${width}" height="${height}" fill="#0b1218"/>
        <line x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${padding.left + innerWidth}" y2="${padding.top + innerHeight}" stroke="#324756"/>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + innerHeight}" stroke="#324756"/>
        ${bars}
        <path d="${areaPath}" fill="rgba(52, 211, 153, 0.16)"/>
        <path d="${linePath}" fill="none" stroke="#34d399" stroke-width="3"/>
        <text x="${padding.left}" y="${height - 10}" fill="#9fb0bd" font-size="12">0 km</text>
        <text x="${padding.left + innerWidth}" y="${height - 10}" text-anchor="end" fill="#9fb0bd" font-size="12">${route.totalDistanceKm.toFixed(2)} km</text>
        <text x="12" y="${padding.top + 12}" fill="#9fb0bd" font-size="12">${maxElevation.toFixed(0)} m</text>
        <text x="12" y="${padding.top + innerHeight}" fill="#9fb0bd" font-size="12">${minElevation.toFixed(0)} m</text>
    `;
}

async function copyRouteJson() {
    if (!state.riderRoute) return;
    await navigator.clipboard.writeText(JSON.stringify(state.riderRoute, null, 2));
    setStatus("Route JSON 已复制。", false, true);
}

function loadGoogleMaps(apiKey) {
    if (window.google?.maps?.Map) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const callbackName = `initMapRoutePlannerDemo_${Date.now()}`;
        window[callbackName] = () => {
            delete window[callbackName];
            resolve();
        };

        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${callbackName}`;
        script.async = true;
        script.defer = true;
        script.onerror = () => {
            delete window[callbackName];
            reject(new Error("Google Maps JS 脚本加载失败。"));
        };
        document.head.appendChild(script);
    });
}

function haversineDistanceMeters(a, b) {
    const radius = 6371000;
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLat = toRadians(b.lat - a.lat);
    const deltaLng = toRadians(b.lng - a.lng);
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function formatPoint(point) {
    return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
}

function parseGpxPath(gpxText) {
    const doc = new DOMParser().parseFromString(gpxText, "application/xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
        throw new Error("GPX XML 解析失败。");
    }

    const nodes = [
        ...doc.getElementsByTagName("trkpt"),
        ...doc.getElementsByTagName("rtept"),
        ...doc.getElementsByTagName("wpt")
    ];

    return nodes
        .map((node) => ({
            lat: Number(node.getAttribute("lat")),
            lng: Number(node.getAttribute("lon"))
        }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function getMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function formatApiError(data) {
    if (!data) return "响应不是 JSON。";
    if (data.error?.message) return data.error.message;
    if (Array.isArray(data.routes) && data.routes.length === 0) return "routes 为空，通常表示起终点之间没有可计算路线。";
    return summarizeApiResponse(data);
}

function summarizeApiResponse(data) {
    try {
        return JSON.stringify(data, null, 2).slice(0, 900);
    } catch {
        return String(data);
    }
}

function setStatus(message, isError = false, isGood = false) {
    el.statusText.textContent = message;
    el.statusText.classList.toggle("error", isError);
    el.statusText.classList.toggle("good", isGood);
}
