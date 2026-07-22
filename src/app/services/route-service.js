import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, buildRouteFromTrackPoints, sanitizeSegments } from "../../domain/route/route-builder.js";
import {
    buildRoadGraph,
    buildBoundsAroundRoute,
    buildSyntheticGridRoadNetwork,
    extendOsmRoute,
    planOsmRoute
} from "../../domain/route/osm-road-network.js";
import { buildSummarySegmentsFromTrackPoints } from "../../domain/route/track-route.js";
import { fetchOverpassRoadNetwork } from "../../adapters/osm/overpass-client.js";
import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";
import { enrichTrackPointsWithGoogleElevation } from "../../adapters/maps/google-elevation-client.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";
import { defaultRouteSegments } from "../store/initial-state.js";

export function createRouteService({
    store,
    googleMapsConfig = null,
    fetchRoadNetwork = fetchOverpassRoadNetwork,
    loadGoogleMaps = loadGoogleMapsApi,
    enrichElevation = enrichTrackPointsWithGoogleElevation
}) {
    const EXPLORATION_END_TOLERANCE_METERS = 1;
    const EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS = 20;
    let latestMapRouteRequestId = 0;
    let latestElevationRequestId = 0;
    let activeExploration = null;
    let roadNetworkCache = null;

    function invalidatePendingMapRoute() {
        if (!ensureRouteEditingAllowed()) {
            return null;
        }
        const requestId = invalidateRouteRequests();
        store.setState((state) => buildStateWithRoute(
            state,
            [],
            "已清空探索路线，请重新选择起点和起步目标。"
        ));
        return requestId;
    }

    function invalidateRouteRequests() {
        latestMapRouteRequestId += 1;
        latestElevationRequestId += 1;
        activeExploration = null;
        return latestMapRouteRequestId;
    }

    function ensureRouteEditingAllowed() {
        if (!store.getState().liveRide?.isActive) {
            return true;
        }
        store.setState((state) => ({
            ...state,
            statusText: "骑行进行中，路线已锁定。请先结束本次骑行后再修改。"
        }));
        return false;
    }

    function isCurrentMapRouteRequest(requestId) {
        return requestId === latestMapRouteRequestId;
    }

    function markCurrentRouteLoading(statusText) {
        let loadingRoute = null;
        store.setState((state) => {
            if (!state.route) {
                return {
                    ...state,
                    statusText
                };
            }
            loadingRoute = {
                ...state.route,
                isLoading: true
            };
            return {
                ...state,
                route: loadingRoute,
                statusText
            };
        });
        return loadingRoute;
    }

    function clearRouteLoading(statusText = null) {
        store.setState((state) => {
            if (state.route?.isLoading !== true) {
                return statusText === null ? state : { ...state, statusText };
            }
            return {
                ...state,
                route: {
                    ...state.route,
                    isLoading: false
                },
                ...(statusText === null ? {} : { statusText })
            };
        });
    }

    function discardRouteUpdateAfterRideStart(statusText) {
        if (!store.getState().liveRide?.isActive) {
            return false;
        }
        clearRouteLoading(statusText);
        return true;
    }

    function cacheRoadNetwork(exploration) {
        if (exploration?.networkSource !== "overpass" || exploration.graph?.synthetic === true || !exploration.bounds) {
            return;
        }
        roadNetworkCache = {
            graph: exploration.graph,
            bounds: exploration.bounds
        };
    }

    function getReusableRoadNetwork(start, destination) {
        if (!roadNetworkCache) {
            return null;
        }
        return isPointInsideBounds(start, roadNetworkCache.bounds)
            && isPointInsideBounds(destination, roadNetworkCache.bounds)
            ? roadNetworkCache
            : null;
    }

    function buildStateWithRoute(state, routeSegments, statusText) {
        return {
            ...state,
            routeSegments,
            route: buildRoute(routeSegments),
            statusText
        };
    }

    function addSegment() {
        if (!ensureRouteEditingAllowed()) return;
        invalidateRouteRequests();
        store.setState((state) => {
            const routeSegments = sanitizeSegments([
                ...state.routeSegments,
                { name: `路段 ${state.routeSegments.length + 1}`, distanceKm: 1.5, gradePercent: 0 }
            ]);
            return buildStateWithRoute(state, routeSegments, "已新增一段路线。");
        });
    }

    function resetRoute() {
        if (!ensureRouteEditingAllowed()) return;
        invalidateRouteRequests();
        store.setState((state) => buildStateWithRoute(state, sanitizeSegments(defaultRouteSegments), "已清空手工路线。"));
    }

    function updateRouteSegment(segmentId, field, value) {
        if (!ensureRouteEditingAllowed()) return;
        invalidateRouteRequests();
        store.setState((state) => {
            const routeSegments = sanitizeSegments(
                state.routeSegments.map((segment) => (
                    segment.id === segmentId ? { ...segment, [field]: value } : segment
                ))
            );
            return buildStateWithRoute(state, routeSegments, "路线已更新。");
        });
    }

    function removeRouteSegment(segmentId) {
        if (!ensureRouteEditingAllowed()) return;
        invalidateRouteRequests();
        store.setState((state) => {
            const nextSegments = state.routeSegments.filter((segment) => segment.id !== segmentId);
            const routeSegments = sanitizeSegments(nextSegments);
            return buildStateWithRoute(state, routeSegments, routeSegments.length > 0 ? "已移除选中路段。" : "已清空手工路线。");
        });
    }

    async function importGpx(file) {
        if (!ensureRouteEditingAllowed()) return;
        const requestId = invalidateRouteRequests();
        markCurrentRouteLoading("正在导入 GPX 路线...");
        try {
            const xmlText = await file.text();
            if (!isCurrentMapRouteRequest(requestId)) return;
            if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的 GPX 导入。")) return;
            const route = parseGpx(xmlText);

            store.setState((state) => ({
                ...state,
                route,
                routeSegments: route.segments,
                statusText: `已导入 GPX：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`
            }));
        } catch (error) {
            if (!isCurrentMapRouteRequest(requestId)) return;
            console.error("GPX 导入失败", error);
            clearRouteLoading(`GPX 导入失败：${extractErrorMessage(error)}`);
        }
    }

    async function planMapRoute({ start, destination }) {
        let requestId = null;
        try {
            if (!ensureRouteEditingAllowed()) return;
            validateMapRoutePoint(start, "起点");
            validateMapRoutePoint(destination, "起步目标");
            requestId = invalidateRouteRequests();
            const bounds = buildBoundsAroundRoute(start, destination);
            const reusableNetwork = getReusableRoadNetwork(start, destination);
            let graph = reusableNetwork?.graph ?? null;
            let planned = null;
            let reusedNetwork = false;
            let networkSource = "overpass";
            let networkFailure = null;
            markCurrentRouteLoading(reusableNetwork
                ? "正在复用已加载的 OSM 路网生成街景探索起步路线..."
                : "正在请求 OSM 路网并生成街景探索起步路线...");

            if (graph) {
                try {
                    planned = planExplorationRoute(graph, start, destination, EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS);
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
                if (!isCurrentMapRouteRequest(requestId)) return;
                if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
                try {
                    graph = buildRoadGraph(overpassData);
                    planned = planExplorationRoute(graph, start, destination, EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS);
                } catch (error) {
                    if (networkSource === "synthetic") {
                        throw error;
                    }

                    networkSource = "synthetic";
                    networkFailure = summarizeOverpassFailure(error);
                    console.warn("实时 OSM 路网无法生成可骑行路线，改用本地备用网格。", error);
                    graph = buildRoadGraph(buildSyntheticGridRoadNetwork(bounds));
                    planned = planExplorationRoute(graph, start, destination, EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS);
                }
            }
            const points = planned.points;
            let hasElevationData = false;
            const requestElevation = false;

            const exploration = {
                graph,
                rawNodes: planned.rawNodes,
                requestElevation,
                networkSource,
                networkFailure,
                // A reused graph only covers the bounds it was originally
                // fetched for. Do not expand that cache entry to fit a new
                // request range.
                bounds: reusedNetwork ? reusableNetwork.bounds : bounds,
                extensionCount: 0,
                pendingIntent: null
            };
            const route = buildExplorationRoute({
                planned,
                points,
                hasElevationData,
                networkSource,
                networkFailure,
                extensionCount: exploration.extensionCount,
                pendingIntent: exploration.pendingIntent,
                start,
                destination
            });

            if (!isCurrentMapRouteRequest(requestId)) return;
            if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;

            store.setState((state) => ({
                ...state,
                route,
                routeSegments: route.segments,
                statusText: buildMapRouteStatus(route, {
                    hasGoogleElevation: false,
                    elevationSummary: null,
                    networkSource,
                    networkFailure,
                    reusedNetwork
                })
            }));
            activeExploration = exploration;
            cacheRoadNetwork(exploration);
        } catch (error) {
            if (requestId !== null && !isCurrentMapRouteRequest(requestId)) return;
            console.error("街景探索起步路线生成失败", error);
            if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return;
            clearRouteLoading(`街景探索起步路线生成失败：${extractErrorMessage(error)}`);
        }
    }

    function ensureExplorationRouteAhead({ distanceMeters } = {}) {
        const exploration = activeExploration;
        const state = store.getState();
        const route = state.route;
        if (!exploration || route?.source !== "osm-exploration" || !Number.isFinite(distanceMeters)) {
            return;
        }
        if (distanceMeters < route.totalDistanceMeters - EXPLORATION_END_TOLERANCE_METERS) {
            return;
        }

        let extension;
        const intent = exploration.pendingIntent ?? "straight";
        try {
            extension = extendOsmRoute({
                graph: exploration.graph,
                rawNodes: exploration.rawNodes,
                intent,
                intersectionCount: 1,
                sampleSpacingMeters: EXPLORATION_ELEVATION_SAMPLE_SPACING_METERS
            });
        } catch (error) {
            console.warn("OSM 探索路线无法继续延伸", error);
            const statusText = intent === "straight"
                ? `探索路线无法继续延伸：${extractErrorMessage(error)}`
                : `${getExplorationIntentLabel(intent)}不可用，已恢复默认直行。`;
            exploration.pendingIntent = null;
            updateExplorationRouteState({ pendingIntent: null, statusText });
            return;
        }

        exploration.rawNodes = extension.rawNodes;
        exploration.extensionCount += 1;
        exploration.pendingIntent = null;
        const extendedRoute = buildExplorationRoute({
            planned: extension,
            points: extension.points,
            hasElevationData: false,
            networkSource: exploration.networkSource,
            networkFailure: exploration.networkFailure,
            extensionCount: exploration.extensionCount,
            pendingIntent: exploration.pendingIntent
        });
        const intentLabel = getExplorationIntentLabel(intent);
        const statusText = extension.returnedAtDeadEnd
            ? "前方为死路，已自动回头并延伸至下一个路口。"
            : `${intentLabel}已执行，探索路线已延伸至下一个路口。`;
        applyExplorationRoute(extendedRoute, statusText);

        if (exploration.requestElevation) {
            void enrichExplorationExtension({ exploration });
        }
    }

    function queueExplorationTurn(intent) {
        if (!["left", "straight", "right"].includes(intent)) {
            return;
        }

        const exploration = activeExploration;
        const state = store.getState();
        if (!exploration || state.route?.source !== "osm-exploration") {
            return;
        }

        exploration.pendingIntent = intent;
        updateExplorationRouteState({
            pendingIntent: intent,
            statusText: `${getExplorationIntentLabel(intent)}已输入，将在当前探索段终点执行。`
        });
    }

    async function enrichExplorationExtension({ exploration }) {
        const route = store.getState().route;
        try {
            await enrichExplorationRoute({ exploration, route, statusPrefix: "探索路线坡度已增量更新" });
        } catch (error) {
            console.warn("探索路线海拔增量请求失败", error);
            updateExplorationElevationFailure({ exploration, route, error });
        }
    }

    async function enrichExplorationRoute({ exploration, route, statusPrefix }) {
        const googleApiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!googleApiKey || route?.source !== "osm-exploration") {
            return;
        }
        await loadGoogleMaps(googleApiKey);
        googleMapsConfig?.lockApiKey?.(googleApiKey);
        if (activeExploration !== exploration || store.getState().route !== route) {
            return;
        }

        const elevationResult = await enrichElevation(route.points);
        if (activeExploration !== exploration || store.getState().route !== route) {
            return;
        }
        const elevatedRoute = rebuildRouteWithElevation(route, elevationResult.points, elevationResult.hasElevationData);
        exploration.requestElevation = true;
        applyExplorationRoute(
            elevatedRoute,
            `${statusPrefix}：Google 请求 ${elevationResult.summary.requests} 次，缓存命中 ${elevationResult.summary.cacheHits}。`
        );
    }

    function updateExplorationElevationFailure({ exploration, route, error }) {
        if (activeExploration !== exploration || store.getState().route !== route) {
            return;
        }
        store.setState((state) => ({
            ...state,
            statusText: `Google 海拔请求失败：${extractErrorMessage(error)}；当前路线仍可继续骑行。`
        }));
    }

    async function requestCurrentRouteElevation() {
        const initialState = store.getState();
        let route = initialState.route;
        if (initialState.liveRide.isActive) {
            throw new Error("骑行开始后不能替换路线海拔，请先结束当前骑行。");
        }
        if (route?.isLoading) {
            throw new Error("当前路线仍在处理中，请等待完成后再请求海拔。");
        }
        if (!hasCoordinateRoute(route)) {
            throw new Error("当前路线没有坐标，无法请求 Google 海拔。");
        }
        if (route.hasElevationData) {
            return { updated: false, reason: "already-loaded" };
        }

        const apiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!apiKey) {
            throw new Error("请先填写 Google Maps API Key。");
        }

        const requestId = ++latestElevationRequestId;
        route = markCurrentRouteLoading(`正在请求 Google 海拔：${route.points.length} 个采样点...`);

        try {
            await loadGoogleMaps(apiKey);
            googleMapsConfig?.lockApiKey?.(apiKey);
            if (requestId !== latestElevationRequestId || store.getState().route !== route) {
                return { updated: false, reason: "stale" };
            }
            if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的路线海拔请求。")) {
                return { updated: false, reason: "ride-active" };
            }

            const elevationResult = await enrichElevation(route.points);
            if (requestId !== latestElevationRequestId || store.getState().route !== route) {
                return { updated: false, reason: "stale" };
            }
            if (discardRouteUpdateAfterRideStart("骑行已开始，已忽略未完成的路线海拔请求。")) {
                return { updated: false, reason: "ride-active" };
            }

            const elevatedRoute = rebuildRouteWithElevation(route, elevationResult.points, elevationResult.hasElevationData);
            if (route.source === "osm-exploration" && activeExploration) {
                activeExploration.requestElevation = true;
            }
            store.setState((state) => ({
                ...state,
                route: elevatedRoute,
                routeSegments: elevatedRoute.segments,
                statusText: buildElevationUpdateStatus(elevationResult.summary)
            }));
            return { updated: true, summary: elevationResult.summary };
        } catch (error) {
            if (requestId === latestElevationRequestId && store.getState().route === route) {
                clearRouteLoading(`Google 海拔请求失败：${extractErrorMessage(error)}`);
            }
            throw error;
        }
    }

    function applyExplorationRoute(route, statusText) {
        store.setState((state) => {
            if (state.route?.source !== "osm-exploration") {
                return state;
            }
            const session = state.liveRide.session;
            const shouldUpdateLiveSession = state.liveRide.isActive && session?.route?.source === "osm-exploration";
            return {
                ...state,
                route,
                routeSegments: route.segments,
                liveRide: shouldUpdateLiveSession ? {
                    ...state.liveRide,
                    session: {
                        ...session,
                        route
                    }
                } : state.liveRide,
                statusText
            };
        });
    }

    function updateExplorationRouteState({ pendingIntent, statusText }) {
        store.setState((state) => {
            if (state.route?.source !== "osm-exploration") {
                return state;
            }
            const route = {
                ...state.route,
                exploration: {
                    ...state.route.exploration,
                    pendingIntent
                }
            };
            const session = state.liveRide.session;
            const shouldUpdateLiveSession = state.liveRide.isActive && session?.route?.source === "osm-exploration";
            return {
                ...state,
                route,
                liveRide: shouldUpdateLiveSession ? {
                    ...state.liveRide,
                    session: {
                        ...session,
                        route
                    }
                } : state.liveRide,
                statusText
            };
        });
    }

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx,
        invalidatePendingMapRoute,
        planMapRoute,
        requestCurrentRouteElevation,
        queueExplorationTurn,
        ensureExplorationRouteAhead
    };
}

function rebuildRouteWithElevation(route, points, hasElevationData) {
    const rebuilt = buildRouteFromTrackPoints({
        source: route.source,
        name: route.name,
        points,
        segments: buildSummarySegmentsFromTrackPoints(points, {
            hasElevationData,
            namePrefix: route.source === "osm-exploration" ? "OSM 探索" : "路线"
        }),
        hasElevationData
    });
    return { ...route, ...rebuilt, isLoading: false };
}

function planExplorationRoute(graph, start, destination, sampleSpacingMeters) {
    const planned = planOsmRoute({
        graph,
        start,
        destination,
        sampleSpacingMeters
    });
    return extendInitialExplorationRoute(graph, planned);
}

function isPointInsideBounds(point, bounds) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng) || !bounds) {
        return false;
    }
    if (point.lat < bounds.south || point.lat > bounds.north) {
        return false;
    }
    return bounds.west <= bounds.east
        ? point.lng >= bounds.west && point.lng <= bounds.east
        : point.lng >= bounds.west || point.lng <= bounds.east;
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
        // A dead end or a sparse graph is still a valid initial route; only
        // extend when we can actually reach a later decision intersection.
        return planned;
    }
}

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function buildElevationUpdateStatus(summary) {
    const quotaText = summary?.skippedByQuota ? "，部分采样点因 quota cap 未请求" : "";
    return `路线海拔已更新：Google 请求 ${summary?.requests ?? 0} 次 / ${summary?.requestedPoints ?? 0} 点，缓存命中 ${summary?.cacheHits ?? 0}${quotaText}。`;
}

function buildExplorationRoute({
    planned,
    points,
    hasElevationData,
    networkSource,
    networkFailure,
    extensionCount,
    pendingIntent = null,
    start = null,
    destination = null
}) {
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
    route.mapGeometry = planned.rawNodes.map((point) => ({
        latitude: point.lat,
        longitude: point.lng
    }));
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

function getExplorationIntentLabel(intent) {
    if (intent === "left") return "左拐";
    if (intent === "right") return "右拐";
    return "直行";
}

function validateMapRoutePoint(point, label) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        throw new Error(`请先在地图上选择${label}`);
    }
}

function buildMapRouteStatus(route, { hasGoogleElevation, elevationSummary, networkSource, networkFailure, reusedNetwork = false }) {
    const distanceText = formatNumber(route.totalDistanceMeters / 1000, 2);
    const routePrefix = networkSource === "synthetic"
        ? `已生成备用网格探索路线：${distanceText} km。实时 OSM 路网不可用，当前线路不代表真实道路。失败摘要：${networkFailure}`
        : reusedNetwork
            ? `已复用已加载的 OSM 路网，生成街景探索起步路线：${distanceText} km。`
            : `已生成 OSM 街景探索起步路线：${distanceText} km。`;

    if (!hasGoogleElevation) {
        return `${routePrefix}当前没有海拔，可在骑行界面点“请求路线海拔”。`;
    }

    const quotaText = elevationSummary?.skippedByQuota ? "，部分点因 quota cap 未请求" : "";
    return `${routePrefix}Google 海拔请求 ${elevationSummary?.requests ?? 0} 次 / ${elevationSummary?.requestedPoints ?? 0} 点${quotaText}。`;
}

function summarizeOverpassFailure(error) {
    const message = extractErrorMessage(error).replaceAll(/\s+/g, " ").trim();
    return message.length > 260 ? `${message.slice(0, 257)}...` : message;
}
