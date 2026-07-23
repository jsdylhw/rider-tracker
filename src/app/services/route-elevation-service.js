import { buildRouteFromTrackPoints } from "../../domain/route/route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "../../domain/route/track-route.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createRouteElevationService({
    store,
    operations,
    googleMapsConfig,
    loadGoogleMaps,
    enrichElevation,
    onExplorationElevationRequested = () => {}
}) {
    async function enrichRoute(route) {
        const apiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!apiKey) {
            throw new Error("请先填写 Google Maps API Key。");
        }
        await loadGoogleMaps(apiKey);
        googleMapsConfig?.lockApiKey?.(apiKey);
        const elevationResult = await enrichElevation(route.points);
        return {
            route: rebuildRouteWithElevation(route, elevationResult.points, elevationResult.hasElevationData),
            summary: elevationResult.summary
        };
    }

    async function requestCurrentRouteElevation() {
        const initialRoute = store.getState().route;
        if (store.getState().liveRide?.isActive) {
            throw new Error("骑行开始后不能替换路线海拔，请先结束当前骑行。");
        }
        if (initialRoute?.isLoading) {
            throw new Error("当前路线仍在处理中，请等待完成后再请求海拔。");
        }
        if (!hasCoordinateRoute(initialRoute)) {
            throw new Error("当前路线没有坐标，无法请求 Google 海拔。");
        }
        if (initialRoute.hasElevationData) {
            return { updated: false, reason: "already-loaded" };
        }
        if (!(googleMapsConfig?.getApiKey?.() ?? "")) {
            throw new Error("请先填写 Google Maps API Key。");
        }

        const { requestId, route } = operations.beginRouteRequest(
            `正在请求 Google 海拔：${initialRoute.points.length} 个采样点...`
        );
        try {
            const result = await enrichRoute(route);
            if (!operations.isCurrent(requestId) || store.getState().route !== route) {
                return { updated: false, reason: "stale" };
            }
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的路线海拔请求。")) {
                return { updated: false, reason: "ride-active" };
            }

            onExplorationElevationRequested(result.route);
            operations.commitRoute(result.route, buildElevationUpdateStatus(result.summary));
            return { updated: true, summary: result.summary };
        } catch (error) {
            if (operations.isCurrent(requestId) && store.getState().route === route) {
                operations.clearRouteLoading(`Google 海拔请求失败：${extractErrorMessage(error)}`);
            }
            throw error;
        }
    }

    return { enrichRoute, requestCurrentRouteElevation };
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

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function buildElevationUpdateStatus(summary) {
    const quotaText = summary?.skippedByQuota ? "，部分采样点因 quota cap 未请求" : "";
    return `路线海拔已更新：Google 请求 ${summary?.requests ?? 0} 次 / ${summary?.requestedPoints ?? 0} 点，缓存命中 ${summary?.cacheHits ?? 0}${quotaText}。`;
}
