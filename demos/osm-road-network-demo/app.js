import {
    DEFAULT_CENTER,
    INTERSECTIONS_PER_SEGMENT,
    NETWORK_SIZE_KM,
    OVERPASS_REQUEST_TIMEOUT_MS,
    OVERPASS_TOTAL_TIMEOUT_MS,
    SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL,
    WEB_MERCATOR_MAX_LAT,
    buildBoundsAroundCenter,
    buildOverpassQuery,
    isPointInsideBounds,
    normalizeLatLng
} from "./road-network-core.js";
import { createRouteElevationController } from "./elevation-controller.js";
import { createStreetViewController, loadGoogleMapsForStreetView } from "./street-view-controller.js";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
];
const SIM_TICK_MS = 250;
const MAX_SEGMENT_EDGES = 80;
const ROUTE_SAMPLE_SPACING_METERS = 25;
const MAP_WORLD_BOUNDS = [[-WEB_MERCATOR_MAX_LAT, -180], [WEB_MERCATOR_MAX_LAT, 180]];
const ALLOWED_HIGHWAYS = new Set([
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street"
]);

const el = {
    loadNetworkBtn: document.getElementById("loadNetworkBtn"),
    usePresetStartBtn: document.getElementById("usePresetStartBtn"),
    resetBtn: document.getElementById("resetBtn"),
    buildRouteBtn: document.getElementById("buildRouteBtn"),
    statusText: document.getElementById("statusText"),
    startText: document.getElementById("startText"),
    networkText: document.getElementById("networkText"),
    speedInput: document.getElementById("speedInput"),
    startSimBtn: document.getElementById("startSimBtn"),
    pauseSimBtn: document.getElementById("pauseSimBtn"),
    resetSimBtn: document.getElementById("resetSimBtn"),
    turnLeftBtn: document.getElementById("turnLeftBtn"),
    turnStraightBtn: document.getElementById("turnStraightBtn"),
    turnRightBtn: document.getElementById("turnRightBtn"),
    distanceText: document.getElementById("distanceText"),
    routeText: document.getElementById("routeText"),
    headingText: document.getElementById("headingText"),
    intentText: document.getElementById("intentText"),
    streetViewApiKey: document.getElementById("streetViewApiKey"),
    loadStreetViewBtn: document.getElementById("loadStreetViewBtn"),
    streetViewStatusText: document.getElementById("streetViewStatusText"),
    streetViewProbeText: document.getElementById("streetViewProbeText"),
    streetViewPlaceholder: document.querySelector(".street-view-placeholder"),
    svPano1: document.getElementById("svPano1"),
    svPano2: document.getElementById("svPano2"),
    routeJsonOutput: document.getElementById("routeJsonOutput"),
    copyJsonBtn: document.getElementById("copyJsonBtn")
};

const state = {
    map: null,
    tileLayer: null,
    boundsLayer: null,
    roadLayer: null,
    routeLayer: null,
    previewRouteLayer: null,
    centerMarker: null,
    startMarker: null,
    directionMarker: null,
    riderMarker: null,
    selectedCenter: DEFAULT_CENTER,
    preselectedStart: null,
    preselectedDirection: null,
    bounds: null,
    graph: null,
    networkSource: null,
    selectedStart: null,
    route: null,
    loadingNetwork: false,
    streetViewLoaded: false,
    streetViewController: null,
    streetViewService: null,
    elevationController: null,
    streetViewProbePending: false,
    lastStreetViewProbeAt: 0,
    sim: {
        running: false,
        timer: null,
        lastTickMs: 0,
        distanceMeters: 0,
        pendingIntent: null,
        waitingAtDecision: false
    }
};

initMap();
bindEvents();
render();

function initMap() {
    state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
    state.map = L.map("map", {
        center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
        zoom: 12,
        zoomControl: true,
        maxBounds: MAP_WORLD_BOUNDS,
        maxBoundsViscosity: 1
    });
    showTileLayer();
    drawCenterSelection({ fit: true });
    state.map.on("click", (event) => {
        if (!state.graph) {
            selectTileRoutePoint(event.latlng);
        }
    });
}

function bindEvents() {
    el.loadNetworkBtn.addEventListener("click", moveToSanFrancisco);
    el.usePresetStartBtn.addEventListener("click", clearTileSelection);
    el.resetBtn.addEventListener("click", resetAll);
    el.buildRouteBtn.addEventListener("click", buildPreviewRoute);
    el.startSimBtn.addEventListener("click", startSimulation);
    el.pauseSimBtn.addEventListener("click", pauseSimulation);
    el.resetSimBtn.addEventListener("click", resetSimulation);
    el.turnLeftBtn.addEventListener("click", () => queueTurn("left"));
    el.turnStraightBtn.addEventListener("click", () => queueTurn("straight"));
    el.turnRightBtn.addEventListener("click", () => queueTurn("right"));
    el.loadStreetViewBtn.addEventListener("click", loadStreetViewPrototype);
    el.copyJsonBtn.addEventListener("click", copyRouteJson);
    window.addEventListener("beforeunload", () => {
        state.streetViewController?.destroy?.();
    });
}

function showTileLayer() {
    if (state.tileLayer) return;
    state.tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        noWrap: true,
        bounds: MAP_WORLD_BOUNDS,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(state.map);
}

function hideTileLayer() {
    if (!state.tileLayer) return;
    state.tileLayer.remove();
    state.tileLayer = null;
    state.map.attributionControl.addAttribution("Road data &copy; OpenStreetMap contributors");
}

function selectTileRoutePoint(point) {
    const normalizedPoint = normalizeLatLng(point);
    if (!state.preselectedStart || state.preselectedDirection) {
        pauseSimulation();
        state.preselectedStart = normalizedPoint;
        state.preselectedDirection = null;
        state.selectedCenter = state.preselectedStart;
        state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
        state.selectedStart = null;
        state.route = null;
        state.graph = null;
        state.networkSource = null;
        if (state.roadLayer) {
            state.roadLayer.remove();
            state.roadLayer = null;
        }
        drawCenterSelection({ fit: false });
        drawStartMarker(state.preselectedStart);
        clearDirectionMarker();
        clearRouteLayer();
        clearPreviewRouteLayer();
        clearRiderMarker();
        el.routeJsonOutput.value = "";
        setStatus("已选择起点。继续点击终点，生成路线会沿 OSM graph 前往该点。", false, true);
        render();
        return;
    }

    state.preselectedDirection = normalizedPoint;
    state.selectedCenter = midpoint(state.preselectedStart, state.preselectedDirection);
    state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
    drawCenterSelection({ fit: false });
    drawDirectionMarker(state.preselectedDirection);
    clearPreviewRouteLayer();
    setStatus(`终点已选择。点击“生成路线”加载 OSM graph，并生成起点到终点的沿路路线。`, false, true);
    render();
}

function drawCenterSelection({ fit = false } = {}) {
    if (state.centerMarker) {
        state.centerMarker.remove();
        state.centerMarker = null;
    }
    if (state.boundsLayer) {
        state.boundsLayer.remove();
    }
    state.boundsLayer = L.rectangle(boundsToLeaflet(state.bounds), {
        color: "#38bdf8",
        weight: 1,
        fillColor: "#0f172a",
        fillOpacity: 0.16,
        interactive: false
    }).addTo(state.map);
    if (fit) {
        state.map.fitBounds(boundsToLeaflet(state.bounds));
    }
}

function boundsToLeaflet(bounds) {
    return [[bounds.south, bounds.west], [bounds.north, bounds.east]];
}

async function loadNetworkForPreviewRoute() {
    if (state.loadingNetwork) return;
    if (!state.preselectedStart || !state.preselectedDirection) {
        setStatus("请先在瓦片地图上点击起点和终点。", true);
        return;
    }
    state.loadingNetwork = true;
    state.selectedCenter = midpoint(state.preselectedStart, state.preselectedDirection);
    state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
    setStatus(`正在加载路线附近 ${NETWORK_SIZE_KM}km 路网...`);
    render();

    try {
        let data = null;
        let networkSource = null;
        const cachedData = await tryLoadCachedRoadNetwork();

        if (cachedData) {
            data = cachedData;
            networkSource = "cache";
            setStatus("已加载旧金山缓存路网，开始生成本地 graph。", false, true);
        } else {
            const query = buildOverpassQuery(state.bounds);
            try {
                data = await fetchOverpassJson(query);
                networkSource = "overpass";
            } catch (error) {
                data = buildSyntheticGridOverpassData(state.bounds);
                networkSource = "synthetic";
                setStatus(`Overpass 暂不可用，已加载内置网格路网用于测试：${getMessage(error)}`, true);
            }
        }
        state.graph = buildRoadGraph(data);
        state.networkSource = networkSource;
        drawRoadNetwork();
        buildPreselectedInitialRoute();
    } catch (error) {
        setStatus(`路网加载失败：${getMessage(error)}`, true);
    } finally {
        state.loadingNetwork = false;
        render();
    }
}

async function tryLoadCachedRoadNetwork() {
    try {
        const response = await fetch(SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL, {
            cache: "force-cache"
        });
        if (!response.ok) return null;
        const data = await response.json();
        const cacheBounds = data.cacheMetadata?.bounds;
        if (!cacheBounds) return null;
        const startInside = isPointInsideBounds(state.preselectedStart, cacheBounds);
        const directionInside = isPointInsideBounds(state.preselectedDirection, cacheBounds);
        if (!startInside || !directionInside) {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

async function fetchOverpassJson(query) {
    const errors = [];
    const startedAt = performance.now();
    for (const endpoint of OVERPASS_ENDPOINTS) {
        for (const method of ["POST", "GET"]) {
            try {
                const remainingMs = OVERPASS_TOTAL_TIMEOUT_MS - (performance.now() - startedAt);
                if (remainingMs <= 0) {
                    throw new Error(`Overpass total timeout after ${OVERPASS_TOTAL_TIMEOUT_MS}ms`);
                }
                const response = method === "POST"
                    ? await fetchWithTimeout(endpoint, {
                        method,
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                            "Accept": "application/json"
                        },
                        body: new URLSearchParams({ data: query })
                    }, Math.min(OVERPASS_REQUEST_TIMEOUT_MS, remainingMs))
                    : await fetchWithTimeout(`${endpoint}?data=${encodeURIComponent(query)}`, {
                        headers: { "Accept": "application/json" }
                    }, Math.min(OVERPASS_REQUEST_TIMEOUT_MS, remainingMs));
                const text = await response.text();
                if (!response.ok) {
                    errors.push(`${endpoint} ${method} HTTP ${response.status}: ${text.slice(0, 120)}`);
                    continue;
                }
                try {
                    return JSON.parse(text);
                } catch {
                    errors.push(`${endpoint} ${method} returned non-JSON: ${text.slice(0, 120)}`);
                }
            } catch (error) {
                errors.push(`${endpoint} ${method}: ${getMessage(error)}`);
            }
        }
    }
    throw new Error(errors.join(" | "));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = OVERPASS_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function buildSyntheticGridOverpassData(bounds) {
    const latitudes = buildLinearValues(bounds.south, bounds.north, 13);
    const longitudes = buildLinearValues(bounds.west, bounds.east, 13);
    const elements = [];
    const nodeIds = new Map();
    let nextNodeId = 1;
    let nextWayId = 1000;

    for (const lat of latitudes) {
        for (const lng of longitudes) {
            const id = nextNodeId++;
            nodeIds.set(`${lat},${lng}`, id);
            elements.push({ type: "node", id, lat, lon: lng });
        }
    }

    for (let latIndex = 0; latIndex < latitudes.length; latIndex += 1) {
        const lat = latitudes[latIndex];
        elements.push({
            type: "way",
            id: nextWayId++,
            nodes: longitudes.map((lng) => nodeIds.get(`${lat},${lng}`)),
            tags: { highway: "residential", name: `Grid East ${latIndex + 1}` }
        });
    }

    for (let lngIndex = 0; lngIndex < longitudes.length; lngIndex += 1) {
        const lng = longitudes[lngIndex];
        elements.push({
            type: "way",
            id: nextWayId++,
            nodes: latitudes.map((lat) => nodeIds.get(`${lat},${lng}`)),
            tags: { highway: "residential", name: `Grid North ${lngIndex + 1}` }
        });
    }

    return { synthetic: true, elements };
}

function buildLinearValues(start, end, count) {
    const values = [];
    const step = (end - start) / Math.max(1, count - 1);
    for (let index = 0; index < count; index += 1) {
        values.push(round(start + step * index, 7));
    }
    return values;
}

function buildRoadGraph(data) {
    const nodes = new Map();
    const ways = [];
    for (const element of data.elements ?? []) {
        if (element.type === "node") {
            nodes.set(String(element.id), {
                id: String(element.id),
                lat: element.lat,
                lng: element.lon,
                edges: []
            });
        }
    }

    for (const element of data.elements ?? []) {
        if (element.type !== "way") continue;
        const highway = element.tags?.highway;
        if (!ALLOWED_HIGHWAYS.has(highway)) continue;
        const nodeIds = (element.nodes ?? [])
            .map((id) => String(id))
            .filter((id) => nodes.has(id));
        if (nodeIds.length < 2) continue;
        ways.push({
            id: String(element.id),
            name: element.tags?.name ?? highway,
            highway,
            nodeIds
        });
    }

    const edges = [];
    for (const way of ways) {
        for (let index = 1; index < way.nodeIds.length; index += 1) {
            const from = nodes.get(way.nodeIds[index - 1]);
            const to = nodes.get(way.nodeIds[index]);
            const distanceMeters = haversineDistanceMeters(from, to);
            if (distanceMeters < 0.5) continue;
            addDirectedEdge({ nodes, edges, way, from, to, distanceMeters });
            addDirectedEdge({ nodes, edges, way, from: to, to: from, distanceMeters });
        }
    }

    return { nodes, ways, edges, synthetic: data.synthetic === true };
}

function addDirectedEdge({ nodes, edges, way, from, to, distanceMeters }) {
    const edge = {
        id: `${way.id}:${from.id}->${to.id}`,
        wayId: way.id,
        name: way.name,
        highway: way.highway,
        from: from.id,
        to: to.id,
        distanceMeters,
        heading: bearingDegrees(from, to)
    };
    edges.push(edge);
    nodes.get(from.id).edges.push(edge);
}

function drawRoadNetwork() {
    if (state.roadLayer) {
        state.roadLayer.remove();
    }
    const lines = [];
    for (const way of state.graph.ways) {
        const points = way.nodeIds
            .map((id) => state.graph.nodes.get(id))
            .filter(Boolean)
            .map((node) => [node.lat, node.lng]);
        if (points.length >= 2) lines.push(points);
    }
    state.roadLayer = L.layerGroup(lines.map((line) => L.polyline(line, {
        color: "#6b7f8f",
        weight: 1.2,
        opacity: 0.62
    }))).addTo(state.map);
}

function moveToSanFrancisco() {
    if (!state.map) return;
    if (!state.graph && !state.route) {
        showTileLayer();
        state.preselectedStart = null;
        state.preselectedDirection = null;
        state.selectedStart = null;
        clearDirectionMarker();
        clearRouteLayer();
        clearPreviewRouteLayer();
        clearRiderMarker();
        if (state.startMarker) {
            state.startMarker.remove();
            state.startMarker = null;
        }
        el.routeJsonOutput.value = "";
    }
    state.selectedCenter = DEFAULT_CENTER;
    state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
    state.map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 13);
    drawCenterSelection({ fit: false });
    if (!state.route) {
        setStatus("已移动到旧金山。点击地图设置起点，再次点击设置终点。", false, true);
    }
    render();
}

function clearTileSelection() {
    if (state.sim.running) return;
    state.preselectedStart = null;
    state.preselectedDirection = null;
    state.selectedStart = null;
    state.route = null;
    clearDirectionMarker();
    clearRouteLayer();
    clearPreviewRouteLayer();
    clearRiderMarker();
    if (state.startMarker) {
        state.startMarker.remove();
        state.startMarker = null;
    }
    el.routeJsonOutput.value = "";
    setStatus("已清除选点。点击地图设置起点，再次点击设置终点。");
    render();
}

async function buildPreviewRoute() {
    if (!state.preselectedStart || !state.preselectedDirection) {
        setStatus("请先点击地图选择起点和终点。", true);
        return;
    }
    if (state.loadingNetwork) return;
    pauseSimulation();
    state.route = null;
    state.selectedStart = null;
    clearRouteLayer();
    clearRiderMarker();
    clearPreviewRouteLayer();
    setStatus("正在加载 OSM graph，并生成起点到终点的沿路路线...");
    render();
    if (state.graph) {
        buildPreselectedInitialRoute();
        return;
    }
    await loadNetworkForPreviewRoute();
}

function buildInitialRouteTowardPoint(point) {
    if (!state.graph || !state.selectedStart) return;
    const snappedDestination = findNearestEdgePoint(point, state.graph.edges);
    if (!snappedDestination) {
        setStatus("终点附近没有可用道路。", true);
        return;
    }
    drawDirectionMarker(snappedDestination.point);
    const heading = bearingDegrees(state.selectedStart.point, snappedDestination.point);
    const route = buildRouteToSnappedDestination({
        snappedStart: state.selectedStart,
        snappedDestination,
        desiredHeading: heading
    });
    if (!route || route.points.length < 2) {
        setStatus("无法沿 OSM graph 生成起点到终点的路线，请换一个终点。", true);
        return;
    }
    hideTileLayer();
    clearPreviewRouteLayer();
    state.route = route;
    state.sim.distanceMeters = 0;
    resetTurnState();
    drawRoute();
    updateRiderMarker();
    requestRouteElevation("initial");
    syncStreetView();
    const sourceLabel = getNetworkSourceLabel();
    setStatus(`路线已生成，已使用${sourceLabel}，瓦片已关闭。开始后会从起点骑到终点，随后自动进入路口决策。`, false, true);
    render();
}

function buildPreselectedInitialRoute() {
    const snappedStart = findNearestEdgePoint(state.preselectedStart, state.graph.edges);
    const snappedDirection = findNearestEdgePoint(state.preselectedDirection, state.graph.edges);
    if (!snappedStart || !snappedDirection) {
        setStatus("已加载路网，但起步路段附近没有可用道路。请重新选择起点。", true);
        return;
    }
    state.selectedStart = snappedStart;
    drawStartMarker(snappedStart.point);
    buildInitialRouteTowardPoint(snappedDirection.point);
}

function buildRouteToSnappedDestination({ snappedStart, snappedDestination, desiredHeading }) {
    const forward = chooseEdgeDirection(snappedStart.edge, desiredHeading);
    const destinationEdge = chooseEdgeDirection(snappedDestination.edge, desiredHeading);
    const startPoint = {
        lat: snappedStart.point.lat,
        lng: snappedStart.point.lng,
        nodeId: null,
        distanceMeters: 0,
        edgeId: forward.id
    };
    if (isSameDirectedEdge(forward, destinationEdge)) {
        const startRatio = getSnappedRatioOnEdge(snappedStart, forward);
        const destinationRatio = getSnappedRatioOnEdge(snappedDestination, destinationEdge);
        if (destinationRatio >= startRatio) {
            const destinationPoint = {
                lat: snappedDestination.point.lat,
                lng: snappedDestination.point.lng,
                nodeId: null,
                continueNodeId: destinationEdge.to,
                distanceMeters: round(haversineDistanceMeters(startPoint, snappedDestination.point), 1),
                edgeId: destinationEdge.id
            };
            return buildRoute([startPoint, destinationPoint], "osm-road-network-demo");
        }
    }

    const nextNode = state.graph.nodes.get(forward.to);
    const distanceToNext = haversineDistanceMeters(startPoint, nextNode);
    const path = findShortestPathToAnyNode(forward.to, [destinationEdge.from]);
    if (!path) return null;

    const points = [startPoint];
    const firstNode = state.graph.nodes.get(forward.to);
    points.push(makeRoutePoint(firstNode, distanceToNext, forward.id));
    appendPathNodes(points, path.nodeIds.slice(1), path.edgeIds);

    const destinationPoint = {
        lat: snappedDestination.point.lat,
        lng: snappedDestination.point.lng,
        nodeId: null,
        continueNodeId: destinationEdge.to,
        distanceMeters: round((points.at(-1)?.distanceMeters ?? 0) + haversineDistanceMeters(points.at(-1), snappedDestination.point), 1),
        edgeId: destinationEdge.id
    };
    points.push(destinationPoint);
    return buildRoute(points, "osm-road-network-demo");
}

function isSameDirectedEdge(a, b) {
    return a?.from === b?.from && a?.to === b?.to;
}

function getSnappedRatioOnEdge(snapped, edge) {
    if (snapped.edge.from === edge.from && snapped.edge.to === edge.to) {
        return snapped.ratio;
    }
    if (snapped.edge.from === edge.to && snapped.edge.to === edge.from) {
        return 1 - snapped.ratio;
    }
    return snapped.ratio;
}

function appendPathNodes(points, nodeIds, edgeIds) {
    for (let index = 0; index < nodeIds.length; index += 1) {
        const node = state.graph.nodes.get(nodeIds[index]);
        const previous = points.at(-1);
        const edgeId = edgeIds[index] ?? previous?.edgeId ?? null;
        points.push(makeRoutePoint(node, previous.distanceMeters + haversineDistanceMeters(previous, node), edgeId));
    }
}

function findShortestPathToAnyNode(startNodeId, targetNodeIds) {
    const targets = new Set(targetNodeIds.filter(Boolean));
    if (targets.size === 0) return null;
    const distances = new Map([[startNodeId, 0]]);
    const previous = new Map();
    const queue = [{ nodeId: startNodeId, distance: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
        queue.sort((a, b) => a.distance - b.distance);
        const current = queue.shift();
        if (visited.has(current.nodeId)) continue;
        visited.add(current.nodeId);
        if (targets.has(current.nodeId)) {
            return reconstructPath(previous, current.nodeId);
        }

        const node = state.graph.nodes.get(current.nodeId);
        for (const edge of node?.edges ?? []) {
            const nextDistance = current.distance + edge.distanceMeters;
            if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue;
            distances.set(edge.to, nextDistance);
            previous.set(edge.to, {
                nodeId: current.nodeId,
                edgeId: edge.id
            });
            queue.push({ nodeId: edge.to, distance: nextDistance });
        }
    }

    return null;
}

function reconstructPath(previous, endNodeId) {
    const nodeIds = [endNodeId];
    const edgeIds = [];
    let cursor = endNodeId;
    while (previous.has(cursor)) {
        const item = previous.get(cursor);
        nodeIds.unshift(item.nodeId);
        edgeIds.unshift(item.edgeId);
        cursor = item.nodeId;
    }
    return { nodeIds, edgeIds };
}

function extendRouteByIntersections({ points, fromNodeId, incomingHeading, firstIntent, intersectionCount }) {
    let currentNodeId = fromNodeId;
    let heading = incomingHeading;
    let intent = firstIntent;
    let intersectionsPassed = isDecisionNode(currentNodeId) ? 1 : 0;
    let edgeCount = 0;

    while (intersectionsPassed < intersectionCount && edgeCount < MAX_SEGMENT_EDGES) {
        const edge = chooseNextEdge(currentNodeId, heading, intent);
        if (!edge) break;
        const node = state.graph.nodes.get(edge.to);
        const nextDistance = (points.at(-1)?.distanceMeters ?? 0) + edge.distanceMeters;
        points.push(makeRoutePoint(node, nextDistance, edge.id));
        currentNodeId = edge.to;
        heading = edge.heading;
        intent = "straight";
        edgeCount += 1;
        if (isDecisionNode(currentNodeId)) {
            intersectionsPassed += 1;
        }
    }
}

function buildRoute(points, source) {
    const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;
    const sampled = sampleRoutePoints(points, ROUTE_SAMPLE_SPACING_METERS);
    return {
        name: "OSM 路网动态路线",
        source,
        generatedAt: new Date().toISOString(),
        totalDistanceMeters: round(totalDistanceMeters, 1),
        totalDistanceKm: round(totalDistanceMeters / 1000, 3),
        points: sampled,
        rawNodes: points
    };
}

function sampleRoutePoints(points, spacingMeters) {
    if (points.length <= 2) return points.map((point, index) => makeSampledRoutePoint(point, index));
    const total = points.at(-1).distanceMeters;
    const output = [];
    for (let distance = 0; distance < total; distance += spacingMeters) {
        output.push(routePointAtDistance({ rawNodes: points }, distance));
    }
    output.push(routePointAtDistance({ rawNodes: points }, total));
    return output.map((point, index) => makeSampledRoutePoint(point, index));
}

function makeSampledRoutePoint(point, index) {
    return {
        latitude: round(point.lat, 7),
        longitude: round(point.lng, 7),
        distanceMeters: round(point.distanceMeters, 1),
        gradePercent: 0,
        elevationMeters: 0,
        elevationLoaded: false,
        nodeId: point.nodeId ?? null,
        edgeId: point.edgeId ?? null,
        sampleIndex: index
    };
}

function makeRoutePoint(node, distanceMeters, edgeId) {
    return {
        lat: node.lat,
        lng: node.lng,
        nodeId: node.id,
        distanceMeters: round(distanceMeters, 1),
        edgeId
    };
}

async function startSimulation() {
    if (state.sim.running) return;
    if (!state.route) {
        setStatus("请先点击“生成路线”，生成沿 OSM graph 到下一个路口的路线。", true);
        return;
    }
    state.sim.running = true;
    state.sim.lastTickMs = performance.now();
    state.sim.timer = window.setInterval(simulationTick, SIM_TICK_MS);
    setStatus("OSM 路网模拟已开始。");
    syncStreetView();
    render();
}

function pauseSimulation() {
    if (state.sim.timer) {
        window.clearInterval(state.sim.timer);
        state.sim.timer = null;
    }
    state.sim.running = false;
    render();
}

function resetSimulation() {
    pauseSimulation();
    state.sim.distanceMeters = 0;
    resetTurnState();
    updateRiderMarker();
    setStatus("模拟位置已归零。");
    render();
}

function simulationTick() {
    if (!state.route || !state.sim.running) return;
    if (state.sim.waitingAtDecision) return;
    const now = performance.now();
    const deltaSeconds = Math.max(0, (now - state.sim.lastTickMs) / 1000);
    state.sim.lastTickMs = now;
    const speedKph = clamp(Number(el.speedInput.value), 5, 60);
    state.sim.distanceMeters = Math.min(
        state.route.totalDistanceMeters,
        state.sim.distanceMeters + (speedKph / 3.6) * deltaSeconds
    );
    updateRiderMarker();
    syncStreetView();
    renderSimulation();
    if (state.sim.distanceMeters >= state.route.totalDistanceMeters) {
        handleDecisionPoint();
    }
}

function queueTurn(intent) {
    if (!state.route || !state.graph) return;
    state.sim.pendingIntent = intent;
    el.intentText.textContent = `${getIntentLabel(intent)}待执行`;
    setStatus(`${getIntentLabel(intent)}命令已输入，将在下一个决策路口执行。`);
    if (state.sim.waitingAtDecision) {
        continueFromDecision(intent);
        return;
    }
    render();
}

async function loadStreetViewPrototype() {
    const apiKey = el.streetViewApiKey.value.trim();
    if (!apiKey) {
        setStreetViewStatus("请输入 Google Maps API Key。", true);
        return;
    }

    el.loadStreetViewBtn.disabled = true;
    el.loadStreetViewBtn.textContent = "加载中...";
    setStreetViewStatus("正在加载 Google Street View...");

    try {
        await loadGoogleMapsForStreetView(apiKey);
        state.streetViewController?.destroy?.();
        state.streetViewController = createStreetViewController({
            container1: el.svPano1,
            container2: el.svPano2
        });
        state.elevationController = createRouteElevationController({
            onUpdate: syncRouteElevationUpdate
        });
        state.streetViewService = new window.google.maps.StreetViewService();
        state.streetViewLoaded = true;
        if (el.streetViewPlaceholder) {
            el.streetViewPlaceholder.hidden = true;
        }
        setStreetViewStatus(state.route
            ? "街景已加载，会跟随模拟位置更新。"
            : "街景已加载，生成路线/开始模拟后更新。", false, true);
        requestRouteElevation("initial");
        syncStreetView();
    } catch (error) {
        state.streetViewLoaded = false;
        state.streetViewService = null;
        setStreetViewStatus(`街景加载失败：${getMessage(error)}`, true);
    } finally {
        el.loadStreetViewBtn.disabled = false;
        el.loadStreetViewBtn.textContent = state.streetViewLoaded ? "重新加载街景" : "加载街景";
        render();
    }
}

function syncStreetView() {
    if (!state.streetViewLoaded || !state.streetViewController) {
        return;
    }
    if (!state.route) {
        setStreetViewStatus("街景已加载，等待路线。");
        return;
    }
    const distanceMeters = Math.min(state.sim.distanceMeters, state.route.totalDistanceMeters);
    const point = routePointAtDistance(state.route, distanceMeters);
    const heading = getRouteHeadingAtDistance(distanceMeters);
    const routeSample = routeSampleAtDistance(state.route, distanceMeters);
    const grade = Number.isFinite(routeSample?.gradePercent) ? routeSample.gradePercent : 0;
    setStreetViewStatus(
        `同步 GPS ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)} · heading ${Math.round(heading)}deg · grade ${grade.toFixed(1)}% · 视角随 tick 更新`,
        false,
        true
    );
    state.streetViewController.update(state.route, {
        distanceKm: distanceMeters / 1000,
        speedKph: clamp(Number(el.speedInput.value), 5, 60),
        positionLat: point.lat,
        positionLong: point.lng
    });
    runStreetViewProbe(point, { force: distanceMeters === 0 });
}

function requestRouteElevation(mode) {
    if (!state.route || !state.elevationController) return;
    state.elevationController.enrichRoute(state.route, { mode })
        .then((summary) => {
            if (!state.route) return;
            render();
            syncStreetView();
            if (summary.requests > 0 || summary.skippedByQuota) {
                const quotaText = summary.skippedByQuota ? "，已达到 demo quota cap" : "";
                setStatus(`坡度已更新：${summary.requests} 次请求 / ${summary.requestedPoints} 个点，缓存命中 ${summary.cacheHits}${quotaText}。`, summary.skippedByQuota, !summary.skippedByQuota);
            }
        })
        .catch((error) => {
            setStatus(`坡度请求失败：${getMessage(error)}`, true);
        });
}

function syncRouteElevationUpdate() {
    render();
    syncStreetView();
}

function runStreetViewProbe(point, { force = false } = {}) {
    if (!state.streetViewService || state.streetViewProbePending) return;
    const now = performance.now();
    if (!force && now - state.lastStreetViewProbeAt < 3000) return;
    state.lastStreetViewProbeAt = now;
    state.streetViewProbePending = true;
    el.streetViewProbeText.textContent = `探测中：${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

    const startedAt = performance.now();
    state.streetViewService.getPanorama(
        {
            location: new window.google.maps.LatLng(point.lat, point.lng),
            radius: 50
        },
        (data, status) => {
            state.streetViewProbePending = false;
            const latencyMs = Math.round(performance.now() - startedAt);
            if (status === window.google.maps.StreetViewStatus.OK) {
                el.streetViewProbeText.textContent = `OK ${latencyMs}ms · pano ${data?.location?.pano ?? "--"}`;
                return;
            }
            el.streetViewProbeText.textContent = `${status} ${latencyMs}ms · 当前位置 50m 内无可用街景`;
        }
    );
}

function handleDecisionPoint() {
    if (!state.route || state.sim.waitingAtDecision) return;
    state.sim.waitingAtDecision = true;
    state.sim.distanceMeters = state.route.totalDistanceMeters;
    updateRiderMarker();

    const intent = state.sim.pendingIntent;
    if (intent) {
        continueFromDecision(intent);
        return;
    }

    el.intentText.textContent = "默认直行";
    setStatus(`已到达第 ${INTERSECTIONS_PER_SEGMENT} 个路口，未输入方向，默认直行。`);
    continueFromDecision("straight", { isDefault: true });
}

function continueFromDecision(intent, { isDefault = false } = {}) {
    if (!state.route || !state.graph) return;

    const routeNodes = state.route.rawNodes ?? [];
    const endPoint = routeNodes.at(-1);
    const continuationNodeId = endPoint?.nodeId ?? endPoint?.continueNodeId;
    if (!continuationNodeId) {
        setStatus("当前路线终点不是 OSM 路口，无法继续延伸。", true);
        state.sim.waitingAtDecision = false;
        resetTurnState();
        return;
    }
    const basePoints = buildContinuationBasePoints(routeNodes, continuationNodeId);
    const continuationPoint = basePoints.at(-1);

    const incomingHeading = endPoint?.nodeId
        ? getRouteHeadingAtDistance(Math.max(0, state.route.totalDistanceMeters - 20))
        : bearingDegrees(endPoint, continuationPoint);
    const edge = chooseNextEdge(continuationNodeId, incomingHeading, intent);
    if (!edge) {
        setStatus(`${getIntentLabel(intent)}不可用，前方没有合适道路。`, true);
        state.sim.waitingAtDecision = false;
        resetTurnState();
        render();
        return;
    }

    const points = [...basePoints];
    const nextNode = state.graph.nodes.get(edge.to);
    points.push(makeRoutePoint(nextNode, continuationPoint.distanceMeters + edge.distanceMeters, edge.id));
    extendRouteByIntersections({
        points,
        fromNodeId: edge.to,
        incomingHeading: edge.heading,
        firstIntent: "straight",
        intersectionCount: INTERSECTIONS_PER_SEGMENT
    });
    state.route = buildRoute(points, "osm-road-network-intersection-demo");
    state.sim.waitingAtDecision = false;
    state.sim.pendingIntent = null;
    state.sim.lastTickMs = performance.now();
    drawRoute();
    updateRiderMarker();
    requestRouteElevation("incremental");
    syncStreetView();
    const actionLabel = isDefault ? `默认${getIntentLabel(intent)}` : getIntentLabel(intent);
    el.intentText.textContent = `${actionLabel}已执行`;
    setStatus(`${actionLabel}已执行，继续前进 ${INTERSECTIONS_PER_SEGMENT} 个路口。`, false, true);
    render();
}

function buildContinuationBasePoints(routeNodes, continuationNodeId) {
    const points = [...routeNodes];
    const endPoint = points.at(-1);
    if (endPoint?.nodeId === continuationNodeId) {
        return points;
    }
    const continuationNode = state.graph.nodes.get(continuationNodeId);
    if (!continuationNode || !endPoint) {
        return points;
    }
    points.push(makeRoutePoint(
        continuationNode,
        endPoint.distanceMeters + haversineDistanceMeters(endPoint, continuationNode),
        endPoint.edgeId
    ));
    return points;
}

function isDecisionNode(nodeId) {
    const node = state.graph?.nodes.get(nodeId);
    return Boolean(node && node.edges.length >= 3);
}

function chooseNextEdge(nodeId, incomingHeading, intent) {
    const node = state.graph.nodes.get(nodeId);
    if (!node) return null;
    const candidates = node.edges
        .map((edge) => ({
            edge,
            diff: signedAngleDegrees(incomingHeading, edge.heading)
        }))
        .filter(({ diff }) => Math.abs(Math.abs(diff) - 180) > 35);
    if (candidates.length === 0) return null;
    if (intent === "right") {
        return candidates
            .filter(({ diff }) => diff >= 25 && diff <= 160)
            .sort((a, b) => Math.abs(a.diff - 90) - Math.abs(b.diff - 90))[0]?.edge ?? null;
    }
    if (intent === "left") {
        return candidates
            .filter(({ diff }) => diff <= -25 && diff >= -160)
            .sort((a, b) => Math.abs(a.diff + 90) - Math.abs(b.diff + 90))[0]?.edge ?? null;
    }
    return candidates
        .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0]?.edge ?? null;
}

function chooseEdgeDirection(edge, desiredHeading) {
    const reverse = state.graph.edges.find((item) => item.from === edge.to && item.to === edge.from);
    if (!reverse) return edge;
    const forwardDiff = Math.abs(signedAngleDegrees(desiredHeading, edge.heading));
    const reverseDiff = Math.abs(signedAngleDegrees(desiredHeading, reverse.heading));
    return forwardDiff <= reverseDiff ? edge : reverse;
}

function drawStartMarker(point) {
    if (state.startMarker) state.startMarker.remove();
    state.startMarker = L.circleMarker([point.lat, point.lng], {
        radius: 7,
        color: "#2563eb",
        weight: 3,
        fillColor: "#93c5fd",
        fillOpacity: 0.95
    }).addTo(state.map).bindTooltip("起点");
}

function drawDirectionMarker(point) {
    clearDirectionMarker();
    state.directionMarker = L.circleMarker([point.lat, point.lng], {
        radius: 6,
        color: "#22c55e",
        weight: 2,
        fillColor: "#86efac",
        fillOpacity: 0.9
    }).addTo(state.map).bindTooltip("终点");
}

function clearDirectionMarker() {
    if (state.directionMarker) {
        state.directionMarker.remove();
        state.directionMarker = null;
    }
}

function drawRoute() {
    clearRouteLayer();
    if (!state.route) return;
    const latLngs = state.route.rawNodes.map((point) => [point.lat, point.lng]);
    state.routeLayer = L.polyline(latLngs, {
        color: "#38bdf8",
        weight: 5,
        opacity: 0.9
    }).addTo(state.map);
}

function clearRouteLayer() {
    if (state.routeLayer) {
        state.routeLayer.remove();
        state.routeLayer = null;
    }
}

function clearPreviewRouteLayer() {
    if (state.previewRouteLayer) {
        state.previewRouteLayer.remove();
        state.previewRouteLayer = null;
    }
}

function updateRiderMarker() {
    if (!state.route) return;
    const point = routePointAtDistance(state.route, state.sim.distanceMeters);
    if (!state.riderMarker) {
        state.riderMarker = L.circleMarker([point.lat, point.lng], {
            radius: 8,
            color: "#facc15",
            weight: 3,
            fillColor: "#fef08a",
            fillOpacity: 0.95
        }).addTo(state.map);
    } else {
        state.riderMarker.setLatLng([point.lat, point.lng]);
    }
}

function clearRiderMarker() {
    if (state.riderMarker) {
        state.riderMarker.remove();
        state.riderMarker = null;
    }
}

function routePointAtDistance(route, distanceMeters) {
    const points = route.rawNodes ?? [];
    if (points.length === 0) return { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, distanceMeters: 0 };
    if (distanceMeters <= 0) return { ...points[0], distanceMeters: 0 };
    const last = points.at(-1);
    if (distanceMeters >= last.distanceMeters) return { ...last };
    const upperIndex = points.findIndex((point) => point.distanceMeters >= distanceMeters);
    const upper = points[Math.max(1, upperIndex)];
    const lower = points[Math.max(0, upperIndex - 1)];
    const span = Math.max(1, upper.distanceMeters - lower.distanceMeters);
    const ratio = (distanceMeters - lower.distanceMeters) / span;
    return {
        lat: lower.lat + (upper.lat - lower.lat) * ratio,
        lng: lower.lng + (upper.lng - lower.lng) * ratio,
        distanceMeters,
        nodeId: ratio > 0.98 ? upper.nodeId : null,
        edgeId: upper.edgeId
    };
}

function routeSampleAtDistance(route, distanceMeters) {
    const points = route.points ?? [];
    if (points.length === 0) return null;
    let best = points[0];
    let bestDistance = Math.abs(points[0].distanceMeters - distanceMeters);
    for (const point of points) {
        const distance = Math.abs(point.distanceMeters - distanceMeters);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }
    return best;
}

function getRouteHeadingAtDistance(distanceMeters) {
    const from = routePointAtDistance(state.route, Math.max(0, distanceMeters));
    const to = routePointAtDistance(state.route, Math.min(state.route.totalDistanceMeters, distanceMeters + 20));
    return bearingDegrees(from, to);
}

function findNearestEdgePoint(point, edges) {
    let best = null;
    for (const edge of edges) {
        const from = state.graph.nodes.get(edge.from);
        const to = state.graph.nodes.get(edge.to);
        const projected = projectPointToSegment(point, from, to);
        if (!best || projected.distanceMeters < best.distanceMeters) {
            best = { ...projected, edge };
        }
    }
    return best;
}

function projectPointToSegment(point, from, to) {
    const origin = toLocalMeters(point, point);
    const a = toLocalMeters(from, point);
    const b = toLocalMeters(to, point);
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const ao = { x: origin.x - a.x, y: origin.y - a.y };
    const lengthSquared = ab.x * ab.x + ab.y * ab.y;
    const ratio = lengthSquared > 0
        ? clamp((ao.x * ab.x + ao.y * ab.y) / lengthSquared, 0, 1)
        : 0;
    const projectedMeters = {
        x: a.x + ab.x * ratio,
        y: a.y + ab.y * ratio
    };
    const projected = fromLocalMeters(projectedMeters, point);
    return {
        point: projected,
        distanceMeters: Math.hypot(projectedMeters.x, projectedMeters.y),
        ratio
    };
}

function toLocalMeters(point, origin) {
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(toRadians(origin.lat));
    return {
        x: (point.lng - origin.lng) * metersPerDegreeLng,
        y: (point.lat - origin.lat) * metersPerDegreeLat
    };
}

function fromLocalMeters(point, origin) {
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(toRadians(origin.lat));
    return {
        lat: origin.lat + point.y / metersPerDegreeLat,
        lng: origin.lng + point.x / metersPerDegreeLng
    };
}

function resetAll() {
    pauseSimulation();
    showTileLayer();
    state.preselectedStart = null;
    state.preselectedDirection = null;
    state.selectedStart = null;
    state.graph = null;
    state.networkSource = null;
    state.route = null;
    state.sim.distanceMeters = 0;
    state.selectedCenter = DEFAULT_CENTER;
    state.bounds = buildBoundsAroundCenter(state.selectedCenter, NETWORK_SIZE_KM);
    resetTurnState();
    if (state.startMarker) {
        state.startMarker.remove();
        state.startMarker = null;
    }
    clearDirectionMarker();
    drawCenterSelection({ fit: true });
    if (state.roadLayer) {
        state.roadLayer.remove();
        state.roadLayer = null;
    }
    clearRouteLayer();
    clearPreviewRouteLayer();
    clearRiderMarker();
    el.routeJsonOutput.value = "";
    setStatus("已重置。点击地图设置起点，再次点击设置终点。");
    render();
}

function resetTurnState() {
    state.sim.pendingIntent = null;
    state.sim.waitingAtDecision = false;
}

function render() {
    const hasNetwork = Boolean(state.graph);
    const hasStart = Boolean(state.selectedStart);
    const hasRoute = Boolean(state.route);
    const hasTileSelection = Boolean(state.preselectedStart || state.preselectedDirection);
    const hasCompleteTileSelection = Boolean(state.preselectedStart && state.preselectedDirection);
    el.loadNetworkBtn.disabled = state.loadingNetwork;
    el.loadNetworkBtn.textContent = state.loadingNetwork ? "加载中..." : "旧金山";
    el.usePresetStartBtn.disabled = state.sim.running || (!hasTileSelection && !hasRoute);
    el.resetBtn.disabled = state.loadingNetwork || (!hasNetwork && !hasStart && !hasRoute && !hasTileSelection);
    el.buildRouteBtn.disabled = state.sim.running || state.loadingNetwork || !hasCompleteTileSelection;
    el.startSimBtn.disabled = state.sim.running || state.loadingNetwork || !hasRoute;
    el.pauseSimBtn.disabled = !state.sim.running;
    el.resetSimBtn.disabled = !hasRoute;
    el.turnLeftBtn.disabled = !hasRoute;
    el.turnStraightBtn.disabled = !hasRoute;
    el.turnRightBtn.disabled = !hasRoute;
    el.copyJsonBtn.disabled = !hasRoute;
    el.startText.textContent = hasStart
        ? formatPoint(state.selectedStart.point)
        : (state.preselectedStart ? formatPoint(state.preselectedStart) : "未选择");
    el.networkText.textContent = hasNetwork
        ? `${getNetworkSourceLabel()} · ${state.graph.nodes.size} nodes · ${state.graph.edges.length / 2} road segments`
        : "未加载";
    if (hasRoute) {
        el.routeText.textContent = `${(state.route.totalDistanceMeters / 1000).toFixed(2)} km`;
        el.routeJsonOutput.value = JSON.stringify(state.route, null, 2);
    } else {
        el.routeText.textContent = "--";
        el.distanceText.textContent = "--";
        el.headingText.textContent = "--";
        el.intentText.textContent = "等待路线";
    }
    renderSimulation();
}

function renderSimulation() {
    if (!state.route) return;
    const distance = Math.min(state.sim.distanceMeters, state.route.totalDistanceMeters);
    el.distanceText.textContent = `${(distance / 1000).toFixed(2)} / ${(state.route.totalDistanceMeters / 1000).toFixed(2)} km`;
    el.headingText.textContent = `${Math.round(getRouteHeadingAtDistance(distance))}deg`;
    if (state.sim.waitingAtDecision) {
        el.intentText.textContent = state.sim.pendingIntent
            ? `${getIntentLabel(state.sim.pendingIntent)}执行中`
            : "默认直行";
        return;
    }
    if (state.sim.pendingIntent) {
        el.intentText.textContent = `${getIntentLabel(state.sim.pendingIntent)}待执行`;
        return;
    }
    el.intentText.textContent = "可输入方向";
}

async function copyRouteJson() {
    if (!state.route) return;
    await navigator.clipboard.writeText(JSON.stringify(state.route, null, 2));
    setStatus("Route JSON 已复制。", false, true);
}

function setStatus(message, isError = false, isGood = false) {
    el.statusText.textContent = message;
    el.statusText.classList.toggle("error", isError);
    el.statusText.classList.toggle("good", isGood);
}

function setStreetViewStatus(message, isError = false, isGood = false) {
    el.streetViewStatusText.textContent = message;
    el.streetViewStatusText.classList.toggle("error", isError);
    el.streetViewStatusText.classList.toggle("good", isGood);
}

function getNetworkSourceLabel() {
    if (state.networkSource === "cache") return "旧金山缓存路网";
    if (state.networkSource === "overpass") return "实时 OSM 路网";
    if (state.networkSource === "synthetic" || state.graph?.synthetic) return "内置网格 fallback";
    return "OSM 路网";
}

function getIntentLabel(intent) {
    if (intent === "left") return "左拐";
    if (intent === "right") return "右拐";
    return "直行";
}

function formatPoint(point) {
    return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
}

function midpoint(a, b) {
    return {
        lat: (a.lat + b.lat) / 2,
        lng: (a.lng + b.lng) / 2
    };
}

function haversineDistanceMeters(a, b) {
    const radius = 6371000;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(a, b) {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLng = toRadians(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function signedAngleDegrees(fromHeading, toHeading) {
    return ((toHeading - fromHeading + 540) % 360) - 180;
}

function normalizeHeading(heading) {
    return ((heading % 360) + 360) % 360;
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function getMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
