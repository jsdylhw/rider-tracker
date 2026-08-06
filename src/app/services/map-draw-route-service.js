import { buildMapDrawRoute } from "../../domain/route/map-draw-route.js";
import { fetchGoogleBicycleRoute } from "../../adapters/maps/google-routes-client.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createMapDrawRouteService({
    store,
    operations,
    googleMapsConfig,
    fetchGoogleRoute = fetchGoogleBicycleRoute,
    invalidateExploration
}) {
    async function createMapDrawRoute(waypoints) {
        if (!operations.ensureRouteEditingAllowed()) return null;

        invalidateExploration?.();
        const apiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!apiKey) {
            throw new Error("请先填写 Google Maps API Key。");
        }

        const { requestId, route: loadingRoute } = operations.beginRouteRequest("正在调用 Google Routes API 生成骑行路线...");
        try {
            const planned = await fetchGoogleRoute({ apiKey, waypoints });
            if (!operations.isCurrent(requestId) || store.getState().route !== loadingRoute) return null;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的地图路线。")) return null;

            const route = buildMapDrawRoute({
                waypoints,
                routePath: planned.path,
                totalDistanceMeters: planned.distanceMeters,
                estimatedDuration: planned.estimatedDuration,
                travelMode: planned.travelMode
            });
            operations.commitRoute(
                route,
                `${route.travelMode === "DRIVE" ? "Google 骑行路线不可用，已生成避开高速的道路路线" : "已生成 Google 骑行路线"}：${formatNumber(route.totalDistanceMeters / 1000, 2)} km。正在准备请求路线海拔。`
            );
            return route;
        } catch (error) {
            if (operations.isCurrent(requestId) && store.getState().route === loadingRoute) {
                operations.clearRouteLoading(`地图骑行路线生成失败：${extractErrorMessage(error)}`);
            }
            throw error;
        }
    }

    return { createMapDrawRoute };
}
