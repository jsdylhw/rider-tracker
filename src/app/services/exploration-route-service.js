import { buildRoute, buildRouteFromTrackPoints } from "../../domain/route/route-builder.js";
import {
    buildRoadGraph,
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
            const bounds = buildBoundsAroundRoute(start, destination);
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
                let overpassData;
                try {
                    overpassData = await fetchRoadNetwork(bounds);
                } catch (error) {
                    networkSource = "synthetic";
                    networkFailure = summarizeOverpassFailure(error);
                    overpassData = buildSyntheticGridRoadNetwork(bounds);
                    console.warn("实时 OSM 路网不可用，改用本地备用网格。", error);
                }
                if (!operations.isCurrent(requestId)) return;
                if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
                try {
                    graph = buildRoadGraph(overpassData);
                    planned = planExplorationRoute(graph, start, destination);
                } catch (error) {
                    if (networkSource === "synthetic") throw error;

                    networkSource = "synthetic";
                    networkFailure = summarizeOverpassFailure(error);
                    console.warn("实时 OSM 路网无法生成可骑行路线，改用本地备用网格。", error);
                    graph = buildRoadGraph(buildSyntheticGridRoadNetwork(bounds));
                    planned = planExplorationRoute(graph, start, destination);
                }
            }

            const exploration = {
                graph,
                rawNodes: planned.rawNodes,
                requestElevation: false,
                networkSource,
                networkFailure,
                bounds: reusedNetwork ? reusableNetwork.bounds : bounds,
                extensionCount: 0,
                pendingIntent: null
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
        } catch (error) {
            if (requestId !== null && !operations.isCurrent(requestId)) return;
            console.error("街景探索起步路线生成失败", error);
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
            operations.clearRouteLoading(`街景探索起步路线生成失败：${extractErrorMessage(error)}`);
        }
    }

    function ensureExplorationRouteAhead({ distanceMeters } = {}) {
        const route = store.getState().route;
        if (!activeExploration || route?.source !== "osm-exploration" || !Number.isFinite(distanceMeters)) return;
        if (distanceMeters < route.totalDistanceMeters - EXPLORATION_END_TOLERANCE_METERS) return;

        const intent = activeExploration.pendingIntent ?? "straight";
        let extension;
        try {
            extension = extendOsmRoute({
                graph: activeExploration.graph,
                rawNodes: activeExploration.rawNodes,
                intent,
                intersectionCount: 1,
                sampleSpacingMeters: EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS
            });
        } catch (error) {
            console.warn("OSM 探索路线无法继续延伸", error);
            activeExploration.pendingIntent = null;
            updateExplorationRouteState({
                pendingIntent: null,
                statusText: intent === "straight"
                    ? `探索路线无法继续延伸：${extractErrorMessage(error)}`
                    : `${getExplorationIntentLabel(intent)}不可用，已恢复默认直行。`
            });
            return;
        }

        activeExploration.rawNodes = extension.rawNodes;
        activeExploration.extensionCount += 1;
        activeExploration.pendingIntent = null;
        const extendedRoute = buildExplorationRoute({
            planned: extension,
            points: extension.points,
            hasElevationData: false,
            networkSource: activeExploration.networkSource,
            networkFailure: activeExploration.networkFailure,
            extensionCount: activeExploration.extensionCount,
            pendingIntent: null
        });
        applyExplorationRoute(
            extendedRoute,
            extension.returnedAtDeadEnd
                ? "前方为死路，已自动回头并延伸至下一个路口。"
                : `${getExplorationIntentLabel(intent)}已执行，探索路线已延伸至下一个路口。`
        );

        if (activeExploration.requestElevation) {
            void enrichExplorationExtension(activeExploration);
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
        }
    }

    async function enrichExplorationExtension(exploration) {
        const route = store.getState().route;
        try {
            const result = await enrichRoute(route);
            if (activeExploration !== exploration || store.getState().route !== route) return;
            exploration.requestElevation = true;
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

    function cacheRoadNetwork(exploration) {
        if (exploration?.networkSource !== "overpass" || exploration.graph?.synthetic === true || !exploration.bounds) return;
        roadNetworkCache = { graph: exploration.graph, bounds: exploration.bounds };
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
