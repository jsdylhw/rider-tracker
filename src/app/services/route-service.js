import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, sanitizeSegments } from "../../domain/route/route-builder.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";
import { defaultRouteSegments } from "../store/initial-state.js";

export function createRouteService({ store }) {
    function buildStateWithRoute(state, routeSegments, statusText) {
        return {
            ...state,
            routeSelectionConfirmed: false,
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
                routeSelectionConfirmed: false,
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

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx
    };
}
