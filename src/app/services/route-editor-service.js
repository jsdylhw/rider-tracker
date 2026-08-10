import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, sanitizeSegments } from "../../domain/route/route-builder.js";
import { buildRouteContinuation, getRouteLibraryCompletionDistance } from "../../domain/route/route-continuation.js";
import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createRouteEditorService({
    store,
    operations,
    defaultRouteSegments,
    invalidateExploration,
    routeLibrary
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
            const routeWithImportMetadata = {
                ...route,
                importFileName: normalizeImportedFileName(file.name)
            };
            const savedRoute = await saveImportedGpxRoute(routeWithImportMetadata, xmlText);
            if (!operations.isCurrent(requestId)) return;
            const routeWithLibraryId = savedRoute?.id
                ? {
                    ...routeWithImportMetadata,
                    libraryRouteId: savedRoute.id,
                    routeLibraryResumeDistanceMeters: savedRoute.resumeDistanceMeters ?? 0
                }
                : routeWithImportMetadata;
            const saveStatus = savedRoute
                ? savedRoute.created ? "已保存到我的路线。" : "已更新我的路线库中的同一路线。"
                : "路线库保存失败，本次仍可正常骑行。";
            operations.commitRoute(
                routeWithLibraryId,
                `已导入 GPX：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km。${saveStatus}`
            );
        } catch (error) {
            if (!operations.isCurrent(requestId)) return;
            console.error("GPX 导入失败", error);
            operations.clearRouteLoading(`GPX 导入失败：${extractErrorMessage(error)}`);
        }
    }

    async function listSavedGpxRoutes() {
        return routeLibrary?.listSavedGpxRoutes?.() ?? [];
    }

    async function loadSavedGpxRoute(routeId) {
        return loadSavedRoute(routeId, { continueFromLastPosition: false });
    }

    async function continueSavedGpxRoute(routeId) {
        return loadSavedRoute(routeId, { continueFromLastPosition: true });
    }

    async function loadSavedRoute(routeId, { continueFromLastPosition }) {
        if (!operations.ensureRouteEditingAllowed()) return null;
        invalidateExploration?.();
        const { requestId } = operations.beginRouteRequest("正在加载已保存 GPX 路线...");
        try {
            const savedRoute = await routeLibrary?.loadSavedRoute?.(routeId);
            if (!savedRoute?.route) throw new Error("已保存路线不存在或数据已损坏。");
            if (!operations.isCurrent(requestId) || operations.discardAfterRideStart("骑行已开始，已忽略路线库加载。")) return null;
            const baseRoute = {
                ...savedRoute.route,
                source: "gpx",
                libraryRouteId: savedRoute.id,
                importFileName: savedRoute.importFileName ?? savedRoute.route.importFileName,
                routeLibraryResumeDistanceMeters: savedRoute.resumeDistanceMeters ?? 0
            };
            const route = continueFromLastPosition
                ? buildRouteContinuation(baseRoute, savedRoute.resumeDistanceMeters)
                : baseRoute;
            operations.commitRoute(
                route,
                continueFromLastPosition
                    ? `已从 ${formatNumber(savedRoute.resumeDistanceMeters / 1000, 2)} km 继续：${route.name}，剩余 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km。`
                    : `已从起点加载：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km。`
            );
            return route;
        } catch (error) {
            if (operations.isCurrent(requestId)) {
                operations.clearRouteLoading(`加载已保存路线失败：${extractErrorMessage(error)}`);
            }
            return null;
        }
    }

    async function deleteSavedGpxRoute(routeId) {
        if (!routeId) return null;
        return routeLibrary?.deleteSavedRoute?.(routeId) ?? null;
    }

    async function updateSavedGpxRouteProgress({ route, sessionDistanceMeters }) {
        if (!route?.libraryRouteId) return null;
        const previousResumeDistance = Number(route.routeLibraryResumeDistanceMeters) || 0;
        const wasContinued = Number(route.continuation?.startDistanceMeters) > 0;

        const completedDistanceMeters = getRouteLibraryCompletionDistance(route, sessionDistanceMeters);
        const totalDistanceMeters = Number(route.continuation?.originalTotalDistanceMeters) || Number(route.totalDistanceMeters) || 0;
        const isCompleted = totalDistanceMeters > 0 && completedDistanceMeters >= totalDistanceMeters - 10;
        if (!wasContinued && previousResumeDistance > 0 && !isCompleted) return null;
        return routeLibrary?.updateSavedRouteResumeDistance?.(
            route.libraryRouteId,
            isCompleted ? 0 : completedDistanceMeters
        ) ?? null;
    }

    async function saveImportedGpxRoute(route, xmlText) {
        try {
            return await routeLibrary?.saveGpxRoute?.({ route, originalGpxText: xmlText }) ?? null;
        } catch (error) {
            console.warn("GPX 路线库保存失败", error);
            return null;
        }
    }

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx,
        listSavedGpxRoutes,
        loadSavedGpxRoute,
        continueSavedGpxRoute,
        deleteSavedGpxRoute,
        updateSavedGpxRouteProgress
    };
}

function normalizeImportedFileName(fileName) {
    const baseName = String(fileName ?? "")
        .replace(/\.[^.]+$/, "")
        .trim();
    return baseName || "GPX 路线";
}
