import { buildRoute, buildRouteFromTrackPoints } from "../../domain/route/route-builder.js";
import {
    buildRoadGraph,
    buildBoundsAroundCenter,
    buildBoundsAroundRoute,
    buildSyntheticGridRoadNetwork,
    extendOsmRoute,
    planOsmRoute
} from "../../domain/route/osm-road-network.js";
import { buildSummarySegmentsFromTrackPoints } from "../../domain/route/track-route.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

const EXPLORATION_END_TOLERANCE_METERS = 1;
const EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS = 20;
const INITIAL_NETWORK_SIZE_ATTEMPTS_KM = [4, 3, 2];
const INITIAL_NETWORK_ROUTE_PADDING_KM = 0.4;
const INITIAL_NETWORK_TIMEOUT_MS_BY_SIZE_KM = new Map([
    [4, 8000],
    [3, 10000],
    [2, 16000]
]);
const EXPANSION_NETWORK_SIZE_KM = 2;
const NETWORK_BOUNDARY_MARGIN_METERS = 220;
const NETWORK_PREFETCH_MIN_MARGIN_METERS = 250;
const NETWORK_PREFETCH_MAX_MARGIN_METERS = 500;
const NETWORK_PREFETCH_LATENCY_BUFFER_MS = 3000;
const DEFAULT_NETWORK_OBSERVED_LATENCY_MS = 8000;

export function createExplorationRouteService({
    store,
    operations,
    fetchRoadNetwork,
    enrichRoute
}) {
    let activeExploration = null;
    let roadNetworkCache = null;

    function clearActiveExploration() {
        activeExploration = null;
    }

    function invalidatePendingMapRoute() {
        if (!operations.ensureRouteEditingAllowed()) return null;
        clearActiveExploration();
        const requestId = operations.invalidateRequests();
        operations.commitRoute(buildRoute([]), "已清空探索路线，请重新选择起点和起步目标。");
        return requestId;
    }

    async function planMapRoute({ start, destination }) {
        let requestId = null;
        try {
            if (!operations.ensureRouteEditingAllowed()) return;
            validateMapRoutePoint(start, "起点");
            validateMapRoutePoint(destination, "起步目标");
            clearActiveExploration();
            const initialBoundsCandidates = buildInitialNetworkBoundsCandidates(start, destination);
            const fallbackBounds = initialBoundsCandidates.at(-1)?.bounds
                ?? buildBoundsAroundRoute(start, destination);
            const reusableNetwork = getReusableRoadNetwork(start, destination);
            const request = operations.beginRouteRequest(reusableNetwork
                ? "正在复用已加载的 OSM 路网生成街景探索起步路线..."
                : "正在请求 OSM 路网并生成街景探索起步路线...");
            requestId = request.requestId;
            let graph = reusableNetwork?.graph ?? null;
            let planned = null;
            let reusedNetwork = false;
            let networkSource = "overpass";
            let networkFailure = null;
            let networkData = reusableNetwork?.networkData ?? null;
            let networkBounds = reusableNetwork?.bounds ?? fallbackBounds;
            let networkObservedLatencyMs = reusableNetwork?.networkObservedLatencyMs
                ?? DEFAULT_NETWORK_OBSERVED_LATENCY_MS;

            if (graph) {
                try {
                    planned = planExplorationRoute(graph, start, destination);
                    reusedNetwork = true;
                } catch (error) {
                    graph = null;
                    console.warn("已缓存 OSM 路网不适用于新选点，改为请求最新路网。", error);
                }
            }

            if (!planned) {
                try {
                    const loaded = await fetchAndPlanInitialRoadNetwork({
                        start,
                        destination,
                        candidates: initialBoundsCandidates
                    });
                    graph = loaded.graph;
                    planned = loaded.planned;
                    networkData = loaded.networkData;
                    networkBounds = loaded.bounds;
                    networkObservedLatencyMs = loaded.durationMs;
                } catch (error) {
                    networkSource = "synthetic";
                    networkFailure = summarizeOverpassFailure(error);
                    networkBounds = fallbackBounds;
                    networkData = buildSyntheticGridRoadNetwork(networkBounds);
                    console.warn("实时 OSM 路网不可用，改用本地备用网格。", error);
                }
                if (!operations.isCurrent(requestId)) return;
                if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
                if (!planned) {
                    try {
                        graph = buildRoadGraph(networkData);
                        planned = planExplorationRoute(graph, start, destination);
                    } catch (error) {
                        if (networkSource === "synthetic") throw error;

                        networkSource = "synthetic";
                        networkFailure = summarizeOverpassFailure(error);
                        networkBounds = fallbackBounds;
                        networkData = buildSyntheticGridRoadNetwork(networkBounds);
                        console.warn("实时 OSM 路网无法生成可骑行路线，改用本地备用网格。", error);
                        graph = buildRoadGraph(networkData);
                        planned = planExplorationRoute(graph, start, destination);
                    }
                }
            }

            const exploration = {
                graph,
                rawNodes: planned.rawNodes,
                requestElevation: false,
                elevationCoverageMeters: 0,
                networkSource,
                networkFailure,
                networkData,
                bounds: networkBounds,
                networkObservedLatencyMs,
                extensionCount: 0,
                pendingIntent: null,
                prefetch: null,
                extensionPromise: null
            };
            const route = buildExplorationRoute({
                planned,
                points: planned.points,
                hasElevationData: false,
                networkSource,
                networkFailure,
                extensionCount: exploration.extensionCount,
                pendingIntent: exploration.pendingIntent,
                start,
                destination
            });

            if (!operations.isCurrent(requestId)) return;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;

            operations.commitRoute(route, buildMapRouteStatus(route, {
                networkSource,
                networkFailure,
                reusedNetwork
            }));
            activeExploration = exploration;
            cacheRoadNetwork(exploration);
            prefetchRoadNetworkForUpcomingDecision(exploration, route, { speedMps: 0 });
        } catch (error) {
            if (requestId !== null && !operations.isCurrent(requestId)) return;
            console.error("街景探索起步路线生成失败", error);
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
            operations.clearRouteLoading(`街景探索起步路线生成失败：${extractErrorMessage(error)}`);
        }
    }

    function ensureExplorationRouteAhead({ distanceMeters, speedMps = 0 } = {}) {
        const route = store.getState().route;
        if (!activeExploration || route?.source !== "osm-exploration" || !Number.isFinite(distanceMeters)) return;
        const exploration = activeExploration;
        prefetchRoadNetworkForUpcomingDecision(exploration, route, { speedMps });
        if (distanceMeters < route.totalDistanceMeters - EXPLORATION_END_TOLERANCE_METERS
            || exploration.extensionPromise) return;

        exploration.extensionPromise = extendExplorationRouteAtEnd(exploration, route, { speedMps })
            .catch((error) => {
                if (activeExploration !== exploration || store.getState().route !== route) return;
                console.warn("OSM 探索路线无法继续延伸", error);
                exploration.pendingIntent = null;
                updateExplorationRouteState({
                    pendingIntent: null,
                    statusText: `探索路线无法继续延伸：${extractErrorMessage(error)}`
                });
            })
            .finally(() => {
                if (activeExploration === exploration) {
                    exploration.extensionPromise = null;
                }
            });
    }

    async function extendExplorationRouteAtEnd(exploration, route, { speedMps }) {
        const intent = exploration.pendingIntent ?? "straight";
        let extension = tryExtendExplorationRoute(exploration, intent);
        if (!extension && isExplorationEndNearNetworkBoundary(exploration)) {
            const expanded = await expandRoadNetworkAtExplorationEnd(exploration);
            if (activeExploration !== exploration || store.getState().route !== route) return;
            if (expanded) {
                extension = tryExtendExplorationRoute(exploration, intent);
            }
        }

        if (!extension) {
            exploration.pendingIntent = null;
            updateExplorationRouteState({
                pendingIntent: null,
                statusText: intent === "straight"
                    ? "探索路线无法继续延伸：前方没有可继续探索的道路。"
                    : `${getExplorationIntentLabel(intent)}不可用，已恢复默认直行。`
            });
            return;
        }

        exploration.rawNodes = extension.rawNodes;
        exploration.extensionCount += 1;
        exploration.pendingIntent = null;
        const points = preserveExplorationElevation({
            currentRoute: route,
            nextPoints: extension.points,
            elevationCoverageMeters: exploration.elevationCoverageMeters
        });
        const extendedRoute = buildExplorationRoute({
            planned: extension,
            points,
            hasElevationData: false,
            networkSource: exploration.networkSource,
            networkFailure: exploration.networkFailure,
            extensionCount: exploration.extensionCount,
            pendingIntent: null
        });
        applyExplorationRoute(
            extendedRoute,
            extension.returnedAtDeadEnd
                ? "前方为死路，已自动回头并延伸至下一个路口。"
                : `${getExplorationIntentLabel(intent)}已执行，探索路线已延伸至下一个路口。`
        );

        prefetchRoadNetworkForUpcomingDecision(exploration, extendedRoute, { speedMps });
        if (exploration.requestElevation) {
            void enrichExplorationExtension(exploration);
        }
    }

    function tryExtendExplorationRoute(exploration, intent) {
        try {
            return extendOsmRoute({
                graph: exploration.graph,
                rawNodes: exploration.rawNodes,
                intent,
                intersectionCount: 1,
                sampleSpacingMeters: EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS
            });
        } catch {
            return null;
        }
    }

    function queueExplorationTurn(intent) {
        if (!['left', 'straight', 'right'].includes(intent)) return;
        if (!activeExploration || store.getState().route?.source !== "osm-exploration") return;

        activeExploration.pendingIntent = intent;
        updateExplorationRouteState({
            pendingIntent: intent,
            statusText: `${getExplorationIntentLabel(intent)}已输入，将在当前探索段终点执行。`
        });
    }

    function markElevationRequested(route) {
        if (activeExploration && route?.source === "osm-exploration") {
            activeExploration.requestElevation = true;
            activeExploration.elevationCoverageMeters = route.totalDistanceMeters;
        }
    }

    async function enrichExplorationExtension(exploration) {
        const route = store.getState().route;
        try {
            const result = await enrichRoute(route);
            if (activeExploration !== exploration || store.getState().route !== route) return;
            exploration.requestElevation = true;
            exploration.elevationCoverageMeters = result.route.totalDistanceMeters;
            applyExplorationRoute(
                result.route,
                `探索路线坡度已增量更新：Google 请求 ${result.summary.requests} 次，缓存命中 ${result.summary.cacheHits}。`
            );
        } catch (error) {
            if (activeExploration !== exploration || store.getState().route !== route) return;
            store.setState((state) => ({
                ...state,
                statusText: `Google 海拔请求失败：${extractErrorMessage(error)}；当前路线仍可继续骑行。`
            }));
        }
    }

    async function fetchAndPlanInitialRoadNetwork({ start, destination, candidates }) {
        const errors = [];
        for (const candidate of candidates) {
            const startedAt = performance.now();
            try {
                const networkData = await fetchRoadNetwork(candidate.bounds, {
                    totalTimeoutMs: candidate.timeoutMs
                });
                const graph = buildRoadGraph(networkData);
                const planned = planExplorationRoute(graph, start, destination);
                return {
                    graph,
                    planned,
                    networkData,
                    bounds: candidate.bounds,
                    durationMs: performance.now() - startedAt
                };
            } catch (error) {
                errors.push(`${candidate.bounds.sizeKm}km: ${extractErrorMessage(error)}`);
            }
        }
        throw new Error(`初始 OSM 路网请求均失败：${errors.join(" | ")}`);
    }

    function prefetchRoadNetworkForUpcomingDecision(exploration, route, { speedMps }) {
        if (exploration.networkSource === "synthetic" || !exploration.networkData || !exploration.bounds) return;
        const endPoint = getExplorationContinuationPoint(exploration);
        const marginMeters = getNetworkPrefetchMarginMeters({
            speedMps,
            observedLatencyMs: exploration.networkObservedLatencyMs
        });
        if (!endPoint || !isNearBoundsBoundary(endPoint, exploration.bounds, marginMeters)) return;

        void requestRoadNetworkExpansion(exploration, endPoint);
    }

    async function expandRoadNetworkAtExplorationEnd(exploration) {
        if (exploration.networkSource === "synthetic" || !exploration.networkData) return false;
        const endPoint = getExplorationContinuationPoint(exploration);
        if (!endPoint) return false;
        return requestRoadNetworkExpansion(exploration, endPoint);
    }

    function requestRoadNetworkExpansion(exploration, point) {
        const bounds = buildBoundsAroundCenter(point, EXPANSION_NETWORK_SIZE_KM);
        const key = getBoundsKey(bounds);
        if (exploration.prefetch?.key === key && exploration.prefetch.status !== "failed") {
            return exploration.prefetch.promise;
        }

        const startedAt = performance.now();
        const promise = fetchRoadNetwork(bounds)
            .then((nextData) => {
                if (activeExploration !== exploration || !exploration.networkData) return false;
                exploration.networkData = mergeOverpassRoadNetworkData(exploration.networkData, nextData);
                exploration.graph = buildRoadGraph(exploration.networkData);
                exploration.bounds = mergeBounds(exploration.bounds, bounds);
                exploration.networkObservedLatencyMs = blendNetworkRequestDuration(
                    exploration.networkObservedLatencyMs,
                    performance.now() - startedAt
                );
                exploration.prefetch = { key, status: "ready", promise: Promise.resolve(true) };
                cacheRoadNetwork(exploration);
                return true;
            })
            .catch((error) => {
                if (activeExploration === exploration) {
                    exploration.prefetch = { key, status: "failed", promise: Promise.resolve(false) };
                    console.warn("前方 OSM 路网预读失败", error);
                }
                return false;
            });

        exploration.prefetch = { key, status: "loading", promise };
        return promise;
    }

    function cacheRoadNetwork(exploration) {
        if (exploration?.networkSource !== "overpass" || exploration.graph?.synthetic === true || !exploration.bounds) return;
        roadNetworkCache = {
            graph: exploration.graph,
            networkData: exploration.networkData,
            bounds: exploration.bounds,
            networkObservedLatencyMs: exploration.networkObservedLatencyMs
        };
    }

    function getReusableRoadNetwork(start, destination) {
        if (!roadNetworkCache) return null;
        return isPointInsideBounds(start, roadNetworkCache.bounds)
            && isPointInsideBounds(destination, roadNetworkCache.bounds)
            ? roadNetworkCache
            : null;
    }

    function applyExplorationRoute(route, statusText) {
        store.setState((state) => {
            if (state.route?.source !== "osm-exploration") return state;
            const session = state.liveRide.session;
            const shouldUpdateLiveSession = state.liveRide.isActive && session?.route?.source === "osm-exploration";
            return {
                ...state,
                route,
                liveRide: shouldUpdateLiveSession ? {
                    ...state.liveRide,
                    session: { ...session, route }
                } : state.liveRide,
                statusText
            };
        });
    }

    function updateExplorationRouteState({ pendingIntent, statusText }) {
        store.setState((state) => {
            if (state.route?.source !== "osm-exploration") return state;
            const route = {
                ...state.route,
                exploration: { ...state.route.exploration, pendingIntent }
            };
            const session = state.liveRide.session;
            const shouldUpdateLiveSession = state.liveRide.isActive && session?.route?.source === "osm-exploration";
            return {
                ...state,
                route,
                liveRide: shouldUpdateLiveSession ? {
                    ...state.liveRide,
                    session: { ...session, route }
                } : state.liveRide,
                statusText
            };
        });
    }

    return {
        clearActiveExploration,
        invalidatePendingMapRoute,
        planMapRoute,
        ensureExplorationRouteAhead,
        queueExplorationTurn,
        markElevationRequested
    };
}

function planExplorationRoute(graph, start, destination) {
    const planned = planOsmRoute({
        graph,
        start,
        destination,
        sampleSpacingMeters: EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS
    });
    return extendInitialExplorationRoute(graph, planned);
}

function extendInitialExplorationRoute(graph, planned) {
    try {
        const extension = extendOsmRoute({
            graph,
            rawNodes: planned.rawNodes,
            intent: "straight",
            intersectionCount: 1,
            stopAtFirstReachedIntersection: true,
            sampleSpacingMeters: EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS
        });
        return extension.intersectionsPassed >= 1 ? extension : planned;
    } catch {
        return planned;
    }
}

function buildExplorationRoute({ planned, points, hasElevationData, networkSource, networkFailure, extensionCount, pendingIntent, start = null, destination = null }) {
    const segments = buildSummarySegmentsFromTrackPoints(points, {
        hasElevationData,
        namePrefix: "OSM 探索"
    });
    const route = buildRouteFromTrackPoints({
        source: "osm-exploration",
        name: "OSM 街景探索路线",
        points,
        segments,
        hasElevationData
    });
    route.networkSource = networkSource;
    route.networkFailure = networkFailure;
    route.mapGeometry = planned.rawNodes.map((point) => ({ latitude: point.lat, longitude: point.lng }));
    route.exploration = {
        active: true,
        extensionCount,
        navigationMode: "auto-straight",
        pendingIntent,
        start,
        initialTarget: destination
    };
    return route;
}

function preserveExplorationElevation({ currentRoute, nextPoints, elevationCoverageMeters }) {
    if (!Array.isArray(currentRoute?.points) || elevationCoverageMeters <= 0) {
        return nextPoints;
    }

    const previousPointsByDistance = new Map(
        currentRoute.points.map((point) => [point.distanceMeters, point])
    );
    return nextPoints.map((point) => {
        if (point.distanceMeters > elevationCoverageMeters) {
            return point;
        }
        const previousPoint = previousPointsByDistance.get(point.distanceMeters);
        return previousPoint
            ? {
                ...point,
                elevationMeters: previousPoint.elevationMeters,
                gradePercent: previousPoint.gradePercent
            }
            : point;
    });
}

function isPointInsideBounds(point, bounds) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng) || !bounds) return false;
    if (point.lat < bounds.south || point.lat > bounds.north) return false;
    return bounds.west <= bounds.east
        ? point.lng >= bounds.west && point.lng <= bounds.east
        : point.lng >= bounds.west || point.lng <= bounds.east;
}

function validateMapRoutePoint(point, label) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        throw new Error(`请先在地图上选择${label}`);
    }
}

function getExplorationIntentLabel(intent) {
    if (intent === "left") return "左拐";
    if (intent === "right") return "右拐";
    return "直行";
}

function buildMapRouteStatus(route, { networkSource, networkFailure, reusedNetwork }) {
    const distanceText = formatNumber(route.totalDistanceMeters / 1000, 2);
    const routePrefix = networkSource === "synthetic"
        ? `已生成备用网格探索路线：${distanceText} km。实时 OSM 路网不可用，当前线路不代表真实道路。失败摘要：${networkFailure}`
        : reusedNetwork
            ? `已复用已加载的 OSM 路网，生成街景探索起步路线：${distanceText} km。`
            : `已生成 OSM 街景探索起步路线：${distanceText} km。`;
    return `${routePrefix}当前没有海拔，可在骑行界面点“请求路线海拔”。`;
}

function summarizeOverpassFailure(error) {
    const message = extractErrorMessage(error).replaceAll(/\s+/g, " ").trim();
    return message.length > 260 ? `${message.slice(0, 257)}...` : message;
}

function buildInitialNetworkBoundsCandidates(start, destination) {
    const candidates = [];
    const seenBounds = new Set();
    for (const minSizeKm of INITIAL_NETWORK_SIZE_ATTEMPTS_KM) {
        const bounds = buildBoundsAroundRoute(start, destination, {
            minSizeKm,
            routePaddingKm: INITIAL_NETWORK_ROUTE_PADDING_KM
        });
        const key = getBoundsKey(bounds);
        if (seenBounds.has(key)) continue;
        seenBounds.add(key);
        candidates.push({
            bounds,
            timeoutMs: INITIAL_NETWORK_TIMEOUT_MS_BY_SIZE_KM.get(minSizeKm) ?? 16000
        });
    }
    return candidates;
}

function getExplorationContinuationPoint(exploration) {
    const endPoint = exploration.rawNodes?.at(-1);
    const endNodeId = endPoint?.nodeId ?? endPoint?.continueNodeId;
    const endNode = exploration.graph?.nodes?.get(endNodeId);
    return endNode ? { lat: endNode.lat, lng: endNode.lng } : null;
}

function isExplorationEndNearNetworkBoundary(exploration) {
    const endPoint = getExplorationContinuationPoint(exploration);
    return isNearBoundsBoundary(endPoint, exploration.bounds, NETWORK_BOUNDARY_MARGIN_METERS);
}

function isNearBoundsBoundary(point, bounds, marginMeters) {
    if (!point || !bounds) return false;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = Math.max(1, metersPerDegreeLat * Math.cos(toRadians(point.lat)));
    const distances = [
        (point.lat - bounds.south) * metersPerDegreeLat,
        (bounds.north - point.lat) * metersPerDegreeLat,
        (point.lng - bounds.west) * metersPerDegreeLng,
        (bounds.east - point.lng) * metersPerDegreeLng
    ];
    return Math.min(...distances) <= marginMeters;
}

function getNetworkPrefetchMarginMeters({ speedMps, observedLatencyMs }) {
    const predictedWaitSeconds = (Math.max(0, observedLatencyMs ?? DEFAULT_NETWORK_OBSERVED_LATENCY_MS)
        + NETWORK_PREFETCH_LATENCY_BUFFER_MS) / 1000;
    return clamp(
        Math.max(0, speedMps ?? 0) * predictedWaitSeconds,
        NETWORK_PREFETCH_MIN_MARGIN_METERS,
        NETWORK_PREFETCH_MAX_MARGIN_METERS
    );
}

function mergeOverpassRoadNetworkData(currentData, nextData) {
    const elementsById = new Map();
    for (const element of currentData?.elements ?? []) {
        elementsById.set(`${element.type}:${element.id}`, element);
    }
    for (const element of nextData?.elements ?? []) {
        elementsById.set(`${element.type}:${element.id}`, element);
    }
    return { elements: [...elementsById.values()] };
}

function mergeBounds(first, second) {
    return {
        south: Math.min(first.south, second.south),
        west: Math.min(first.west, second.west),
        north: Math.max(first.north, second.north),
        east: Math.max(first.east, second.east),
        sizeKm: null
    };
}

function blendNetworkRequestDuration(previousDurationMs, nextDurationMs) {
    if (!Number.isFinite(nextDurationMs) || nextDurationMs <= 0) return previousDurationMs;
    return Math.round((previousDurationMs ?? DEFAULT_NETWORK_OBSERVED_LATENCY_MS) * 0.6 + nextDurationMs * 0.4);
}

function getBoundsKey(bounds) {
    return [bounds.south, bounds.west, bounds.north, bounds.east]
        .map((value) => Number(value).toFixed(6))
        .join(":");
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
