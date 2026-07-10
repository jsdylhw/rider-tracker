import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, buildRouteFromTrackPoints, sanitizeSegments } from "../../domain/route/route-builder.js";
import { buildRoadGraph, buildBoundsAroundRoute, planOsmRoute } from "../../domain/route/osm-road-network.js";
import { buildSummarySegmentsFromTrackPoints } from "../../domain/route/track-route.js";
import { fetchOverpassRoadNetwork } from "../../adapters/osm/overpass-client.js";
import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";
import { enrichTrackPointsWithGoogleElevation } from "../../adapters/maps/google-elevation-client.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";
import { defaultRouteSegments } from "../store/initial-state.js";

export function createRouteService({ store }) {
    function buildStateWithRoute(state, routeSegments, statusText) {
        return {
            ...state,
            routeSegments,
            route: buildRoute(routeSegments),
            statusText
        };
    }

    function addSegment() {
        store.setState((state) => {
            const routeSegments = sanitizeSegments([
                ...state.routeSegments,
                { name: `路段 ${state.routeSegments.length + 1}`, distanceKm: 1.5, gradePercent: 0 }
            ]);
            return buildStateWithRoute(state, routeSegments, "已新增一段路线。");
        });
    }

    function resetRoute() {
        store.setState((state) => buildStateWithRoute(state, sanitizeSegments(defaultRouteSegments), "已恢复默认手工路线。"));
    }

    function updateRouteSegment(segmentId, field, value) {
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
        store.setState((state) => {
            const nextSegments = state.routeSegments.filter((segment) => segment.id !== segmentId);
            const routeSegments = sanitizeSegments(nextSegments.length > 0 ? nextSegments : defaultRouteSegments.slice(0, 1));
            return buildStateWithRoute(state, routeSegments, "已移除选中路段。");
        });
    }

    async function importGpx(file) {
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
        try {
            validateMapRoutePoint(start, "起点");
            validateMapRoutePoint(destination, "终点");

            store.setState((state) => ({
                ...state,
                statusText: "正在请求 OSM 路网并生成地图路线..."
            }));

            const bounds = buildBoundsAroundRoute(start, destination);
            const overpassData = await fetchOverpassRoadNetwork(bounds);
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
                const elevationResult = await enrichTrackPointsWithGoogleElevation(points);
                points = elevationResult.points;
                hasElevationData = elevationResult.hasElevationData;
                elevationSummary = elevationResult.summary;
            }

            const segments = buildSummarySegmentsFromTrackPoints(points, {
                hasElevationData,
                namePrefix: "OSM"
            });
            const route = buildRouteFromTrackPoints({
                source: "osm-map",
                name: "OSM 地图规划路线",
                points,
                segments,
                hasElevationData
            });

            store.setState((state) => ({
                ...state,
                route,
                routeSegments: route.segments,
                statusText: buildMapRouteStatus(route, {
                    hasGoogleElevation: Boolean(googleApiKey),
                    elevationSummary
                })
            }));
        } catch (error) {
            console.error("地图路线生成失败", error);
            store.setState((state) => ({
                ...state,
                statusText: `地图路线生成失败：${extractErrorMessage(error)}`
            }));
        }
    }

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx,
        planMapRoute
    };
}

function validateMapRoutePoint(point, label) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        throw new Error(`请先在地图上选择${label}`);
    }
}

function buildMapRouteStatus(route, { hasGoogleElevation, elevationSummary }) {
    const distanceText = formatNumber(route.totalDistanceMeters / 1000, 2);

    if (!hasGoogleElevation) {
        return `已生成 OSM 地图路线：${distanceText} km。未填写 Google API Key，坡度按 0 处理。`;
    }

    const quotaText = elevationSummary?.skippedByQuota ? "，部分点因 quota cap 未请求" : "";
    return `已生成 OSM 地图路线：${distanceText} km，Google 海拔请求 ${elevationSummary?.requests ?? 0} 次 / ${elevationSummary?.requestedPoints ?? 0} 点${quotaText}。`;
}
