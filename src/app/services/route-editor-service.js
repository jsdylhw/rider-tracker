import { parseGpx } from "../../domain/route/gpx-parser.js";
import { buildRoute, sanitizeSegments } from "../../domain/route/route-builder.js";
import { buildRouteContinuation, getSavedRouteCompletionDistance } from "../../domain/route/route-continuation.js";
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
            const savedRoute = await saveRouteAsset({
                route: routeWithImportMetadata,
                source: "gpx",
                originalGpxText: xmlText
            });
            if (!operations.isCurrent(requestId)) return;
            const committedRoute = savedRoute
                ? attachSavedRoute(routeWithImportMetadata, savedRoute)
                : routeWithImportMetadata;
            operations.commitRoute(
                committedRoute,
                `已导入 GPX：${route.name}，距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km。`
                + (savedRoute ? "已保存到路线库。" : "路线库保存失败，本次仍可正常骑行。")
            );
        } catch (error) {
            if (!operations.isCurrent(requestId)) return;
            console.error("GPX 导入失败", error);
            operations.clearRouteLoading(`GPX 导入失败：${extractErrorMessage(error)}`);
        }
    }

    async function listRoutes(options = {}) {
        return routeLibrary?.listSavedRoutes?.(options) ?? [];
    }

    async function loadRoute(routeId, { continueFromLastPosition = false } = {}) {
        if (!operations.ensureRouteEditingAllowed()) return null;
        invalidateExploration?.();
        const { requestId } = operations.beginRouteRequest("正在加载已保存路线...");
        try {
            const saved = await routeLibrary?.loadSavedRoute?.(routeId);
            if (!saved?.route) throw new Error("已保存路线不存在或数据损坏。");
            if (!operations.isCurrent(requestId) || operations.discardAfterRideStart("骑行已开始，已忽略路线加载。")) return null;
            const base = attachSavedRoute(saved.route, saved);
            const route = continueFromLastPosition
                ? buildRouteContinuation(base, saved.resumeDistanceMeters)
                : base;
            operations.commitRoute(
                route,
                continueFromLastPosition && saved.resumeDistanceMeters > 0
                    ? `已从 ${formatNumber(saved.resumeDistanceMeters / 1000, 2)} km 继续：${route.name}。`
                    : `已从起点加载：${route.name}。`
            );
            return route;
        } catch (error) {
            if (operations.isCurrent(requestId)) {
                operations.clearRouteLoading(`加载路线失败：${extractErrorMessage(error)}`);
            }
            return null;
        }
    }

    async function saveCurrentRoute({ name = "" } = {}) {
        const route = store.getState().route;
        if (!route?.points?.length) throw new Error("当前没有可以保存的路线。");
        const saved = await routeLibrary?.saveRoute?.({
            route,
            source: route.source,
            name: name || route.name,
            agentPlanId: route.agentPlanId,
            agentCandidateId: route.agentCandidateId,
            metadata: route.agentMetadata ?? {}
        });
        if (!saved) throw new Error("路线库没有返回保存结果。");
        const committed = attachSavedRoute(route, saved);
        operations.commitRoute(committed, `路线已保存：${saved.name}。`);
        return saved;
    }

    async function updateSavedRouteProgress({
        route,
        sessionDistanceMeters,
        lastActivityId = null,
        startedAt = null
    }) {
        if (!route?.savedRouteId) return null;
        const completedDistanceMeters = getSavedRouteCompletionDistance(route, sessionDistanceMeters);
        const totalDistanceMeters = Number(route?.continuation?.originalTotalDistanceMeters)
            || Number(route.totalDistanceMeters) || 0;
        if (totalDistanceMeters <= 0) return null;
        if (completedDistanceMeters >= totalDistanceMeters - 10) {
            return routeLibrary?.clearRouteProgress?.(route.savedRouteId) ?? null;
        }
        return routeLibrary?.saveRouteProgress?.(route.savedRouteId, {
            resumeDistanceMeters: completedDistanceMeters,
            lastActivityId,
            startedAt
        }) ?? null;
    }

    async function saveRouteAsset(input) {
        try {
            return await routeLibrary?.saveRoute?.(input) ?? null;
        } catch (error) {
            console.warn("路线库保存失败", error);
            return null;
        }
    }

    return {
        addSegment,
        resetRoute,
        updateRouteSegment,
        removeRouteSegment,
        importGpx,
        listSavedRoutes: listRoutes,
        loadSavedRoute: (routeId) => loadRoute(routeId),
        continueSavedRoute: (routeId) => loadRoute(routeId, { continueFromLastPosition: true }),
        renameSavedRoute: (routeId, name) => routeLibrary?.renameSavedRoute?.(routeId, name),
        deleteSavedRoute: (routeId) => routeLibrary?.deleteSavedRoute?.(routeId),
        saveCurrentRoute,
        updateSavedRouteProgress
    };
}

function attachSavedRoute(route, saved) {
    return {
        ...route,
        savedRouteId: saved.id,
        savedRouteResumeDistanceMeters: saved.resumeDistanceMeters ?? 0
    };
}

function normalizeImportedFileName(fileName) {
    const baseName = String(fileName ?? "")
        .replace(/\.[^.]+$/, "")
        .trim();
    return baseName || "GPX 路线";
}
