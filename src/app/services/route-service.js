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

export function createRouteService({ store }) {
    let latestMapRouteRequestId = 0;
    let activeExploration = null;

    function invalidatePendingMapRoute() {
        latestMapRouteRequestId += 1;
        activeExploration = null;
        return latestMapRouteRequestId;
    }

    function isCurrentMapRouteRequest(requestId) {
        return requestId === latestMapRouteRequestId;
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
        invalidatePendingMapRoute();
        store.setState((state) => {
            const routeSegments = sanitizeSegments([
                ...state.routeSegments,
                { name: `路段 ${state.routeSegments.length + 1}`, distanceKm: 1.5, gradePercent: 0 }
            ]);
            return buildStateWithRoute(state, routeSegments, "已新增一段路线。");
        });
    }

    function resetRoute() {
        invalidatePendingMapRoute();
        store.setState((state) => buildStateWithRoute(state, sanitizeSegments(defaultRouteSegments), "已恢复默认手工路线。"));
    }

    function updateRouteSegment(segmentId, field, value) {
        invalidatePendingMapRoute();
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
        invalidatePendingMapRoute();
        store.setState((state) => {
            const nextSegments = state.routeSegments.filter((segment) => segment.id !== segmentId);
            const routeSegments = sanitizeSegments(nextSegments.length > 0 ? nextSegments : defaultRouteSegments.slice(0, 1));
            return buildStateWithRoute(state, routeSegments, "已移除选中路段。");
        });
    }

    async function importGpx(file) {
        invalidatePendingMapRoute();
        try {
            const xmlText = await file.text();
            const route = parseGpx(xmlText);

            store.setState((state) => ({
                ...state,
                route,
                routeSegments: route.segments,
                statusText: `已导入 GPX：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`
            }));
        } catch (error) {
            console.error("GPX 导入失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `GPX 导入失败：${extractErrorMessage(error)}`
            }));
        }
    }

    async function planMapRoute({ start, destination, googleApiKey }) {
        let requestId = null;
        try {
            validateMapRoutePoint(start, "起点");
            validateMapRoutePoint(destination, "起步目标");
            requestId = invalidatePendingMapRoute();

            store.setState((state) => ({
                ...state,
                statusText: "正在请求 OSM 路网并生成街景探索起步路线..."
            }));

            const bounds = buildBoundsAroundRoute(start, destination);
            let networkSource = "overpass";
            let networkFailure = null;
            let overpassData;

            try {
                overpassData = await fetchOverpassRoadNetwork(bounds);
            } catch (error) {
                networkSource = "synthetic";
                networkFailure = summarizeOverpassFailure(error);
                overpassData = buildSyntheticGridRoadNetwork(bounds);
                console.warn("实时 OSM 路网不可用，改用本地备用网格。", error);
            }
            if (!isCurrentMapRouteRequest(requestId)) return;
            const graph = buildRoadGraph(overpassData);
            const planned = planOsmRoute({ graph, start, destination });
            let points = planned.points;
            let hasElevationData = false;
            let elevationSummary = null;

            if (googleApiKey) {
                store.setState((state) => ({
                    ...state,
                    statusText: `OSM 路线已生成，正在请求 Google 海拔：${points.length} 个采样点...`
                }));

                await loadGoogleMapsApi(googleApiKey);
                if (!isCurrentMapRouteRequest(requestId)) return;
                const elevationResult = await enrichTrackPointsWithGoogleElevation(points);
                if (!isCurrentMapRouteRequest(requestId)) return;
                points = elevationResult.points;
                hasElevationData = elevationResult.hasElevationData;
                elevationSummary = elevationResult.summary;
            }

            const exploration = {
                graph,
                rawNodes: planned.rawNodes,
                googleApiKey,
                networkSource,
                networkFailure,
                extensionCount: 0
            };
            const route = buildExplorationRoute({
                planned,
                points,
                hasElevationData,
                networkSource,
                networkFailure,
                extensionCount: exploration.extensionCount,
                start,
                destination
            });

            if (!isCurrentMapRouteRequest(requestId)) return;

            store.setState((state) => ({
                ...state,
                route,
                routeSegments: route.segments,
                statusText: buildMapRouteStatus(route, {
                    hasGoogleElevation: Boolean(googleApiKey),
                    elevationSummary,
                    networkSource,
                    networkFailure
                })
            }));
            activeExploration = exploration;
        } catch (error) {
            if (requestId !== null && !isCurrentMapRouteRequest(requestId)) return;
            console.error("街景探索起步路线生成失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `街景探索起步路线生成失败：${extractErrorMessage(error)}`
            }));
        }
    }

    function ensureExplorationRouteAhead({ distanceMeters, minAheadMeters = 250 } = {}) {
        const exploration = activeExploration;
        const state = store.getState();
        const route = state.route;
        if (!exploration || route?.source !== "osm-exploration" || !Number.isFinite(distanceMeters)) {
            return;
        }
        if (route.totalDistanceMeters - distanceMeters > minAheadMeters) {
            return;
        }

        let extension;
        try {
            extension = extendOsmRoute({
                graph: exploration.graph,
                rawNodes: exploration.rawNodes,
                intersectionCount: 2
            });
        } catch (error) {
            console.warn("OSM 探索路线无法继续延伸", error);
            store.setState((currentState) => ({
                ...currentState,
                statusText: `探索路线无法继续延伸：${extractErrorMessage(error)}`
            }));
            return;
        }

        exploration.rawNodes = extension.rawNodes;
        exploration.extensionCount += 1;
        const extendedRoute = buildExplorationRoute({
            planned: extension,
            points: extension.points,
            hasElevationData: false,
            networkSource: exploration.networkSource,
            networkFailure: exploration.networkFailure,
            extensionCount: exploration.extensionCount
        });
        applyExplorationRoute(extendedRoute, `探索路线已自动延伸，前方已缓冲 ${Math.round(extendedRoute.totalDistanceMeters - distanceMeters)} m。`);

        if (exploration.googleApiKey) {
            void enrichExplorationExtension({ exploration, extension });
        }
    }

    async function enrichExplorationExtension({ exploration, extension }) {
        try {
            const elevationResult = await enrichTrackPointsWithGoogleElevation(extension.points);
            if (activeExploration !== exploration || exploration.rawNodes !== extension.rawNodes) {
                return;
            }
            const elevatedRoute = buildExplorationRoute({
                planned: extension,
                points: elevationResult.points,
                hasElevationData: elevationResult.hasElevationData,
                networkSource: exploration.networkSource,
                networkFailure: exploration.networkFailure,
                extensionCount: exploration.extensionCount
            });
            applyExplorationRoute(
                elevatedRoute,
                `探索路线坡度已增量更新：${elevationResult.summary.requests} 次请求，缓存命中 ${elevationResult.summary.cacheHits}。`
            );
        } catch (error) {
            console.warn("探索路线海拔增量请求失败", error);
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

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx,
        invalidatePendingMapRoute,
        planMapRoute,
        ensureExplorationRouteAhead
    };
}

function buildExplorationRoute({
    planned,
    points,
    hasElevationData,
    networkSource,
    networkFailure,
    extensionCount,
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
        start,
        initialTarget: destination
    };
    return route;
}

function validateMapRoutePoint(point, label) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        throw new Error(`请先在地图上选择${label}`);
    }
}

function buildMapRouteStatus(route, { hasGoogleElevation, elevationSummary, networkSource, networkFailure }) {
    const distanceText = formatNumber(route.totalDistanceMeters / 1000, 2);
    const routePrefix = networkSource === "synthetic"
        ? `已生成备用网格探索路线：${distanceText} km。实时 OSM 路网不可用，当前线路不代表真实道路。失败摘要：${networkFailure}`
        : `已生成 OSM 街景探索起步路线：${distanceText} km。`;

    if (!hasGoogleElevation) {
        return `${routePrefix}未填写 Google API Key，坡度按 0 处理。`;
    }

    const quotaText = elevationSummary?.skippedByQuota ? "，部分点因 quota cap 未请求" : "";
    return `${routePrefix}Google 海拔请求 ${elevationSummary?.requests ?? 0} 次 / ${elevationSummary?.requestedPoints ?? 0} 点${quotaText}。`;
}

function summarizeOverpassFailure(error) {
    const message = extractErrorMessage(error).replaceAll(/\s+/g, " ").trim();
    return message.length > 260 ? `${message.slice(0, 257)}...` : message;
}
