import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, sanitizeSegments } from "../../domain/route/route-builder.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createRouteEditorService({
    store,
    operations,
    defaultRouteSegments,
    invalidateExploration
}) {
    function replaceManualRoute(segments, statusText) {
        operations.commitRoute(buildRoute(segments), statusText);
    }

    function invalidateRouteEdits() {
        invalidateExploration?.();
        return operations.invalidateRequests();
    }

    function addSegment() {
        if (!operations.ensureRouteEditingAllowed()) return;
        invalidateRouteEdits();
        const segments = sanitizeSegments([
            ...(store.getState().route?.segments ?? []),
            { name: `路段 ${(store.getState().route?.segments?.length ?? 0) + 1}`, distanceKm: 1.5, gradePercent: 0 }
        ]);
        replaceManualRoute(segments, "已新增一段路线。");
    }

    function resetRoute() {
        if (!operations.ensureRouteEditingAllowed()) return;
        invalidateRouteEdits();
        replaceManualRoute(sanitizeSegments(defaultRouteSegments), "已清空手工路线。");
    }

    function updateRouteSegment(segmentId, field, value) {
        if (!operations.ensureRouteEditingAllowed()) return;
        invalidateRouteEdits();
        const segments = sanitizeSegments(
            (store.getState().route?.segments ?? []).map((segment) => (
                segment.id === segmentId ? { ...segment, [field]: value } : segment
            ))
        );
        replaceManualRoute(segments, "路线已更新。");
    }

    function removeRouteSegment(segmentId) {
        if (!operations.ensureRouteEditingAllowed()) return;
        invalidateRouteEdits();
        const segments = sanitizeSegments(
            (store.getState().route?.segments ?? []).filter((segment) => segment.id !== segmentId)
        );
        replaceManualRoute(segments, segments.length > 0 ? "已移除选中路段。" : "已清空手工路线。");
    }

    async function importGpx(file) {
        if (!operations.ensureRouteEditingAllowed()) return;
        invalidateExploration?.();
        const { requestId } = operations.beginRouteRequest("正在导入 GPX 路线...");
        try {
            const xmlText = await file.text();
            if (!operations.isCurrent(requestId)) return;
            if (operations.discardAfterRideStart("骑行已开始，已忽略未完成的 GPX 导入。")) return;

            const route = parseGpx(xmlText);
            operations.commitRoute(
                route,
                `已导入 GPX：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`
            );
        } catch (error) {
            if (!operations.isCurrent(requestId)) return;
            console.error("GPX 导入失败", error);
            operations.clearRouteLoading(`GPX 导入失败：${extractErrorMessage(error)}`);
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
