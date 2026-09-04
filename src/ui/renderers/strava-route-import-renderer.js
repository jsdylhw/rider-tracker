import { formatDuration, formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createStravaRouteImportRenderer({
    elements,
    onListStravaRoutes,
    onRefreshStravaRoutes,
    onImportStravaRoute
}) {
    let routes = [];
    let loading = false;
    let lastState = null;
    let initialized = false;

    function bindEvents() {
        elements.refreshStravaRoutesBtn?.addEventListener("click", () => void refreshLatest());
        elements.stravaRouteSelect?.addEventListener("change", renderControls);
        elements.importStravaRouteBtn?.addEventListener("click", () => void importSelected());
    }

    function render(state) {
        lastState = state;
        renderControls();
    }

    async function ensureLoaded() {
        if (initialized) return routes;
        return loadCached();
    }

    async function loadCached() {
        if (loading || isEditingLocked()) return;
        setLoading(true, "正在读取已缓存的 Strava 路线…");
        try {
            const catalog = await onListStravaRoutes?.() ?? {};
            routes = Array.isArray(catalog.routes) ? catalog.routes : [];
            initialized = true;
            renderOptions();
            setStatus(catalog.hasCache
                ? buildCacheStatus(routes.length, catalog.cachedAt)
                : "尚未缓存 Strava 路线；点击“刷新最新路线”从 Strava 获取。以后的页面加载不会自动请求 Strava。");
        } catch (error) {
            routes = [];
            renderOptions();
            setStatus(`Strava 路线缓存读取失败：${extractErrorMessage(error)}`);
        } finally {
            setLoading(false);
        }
    }

    async function refreshLatest() {
        if (loading || isEditingLocked()) return;
        setLoading(true, "正在从 Strava 刷新最新路线…");
        try {
            const catalog = await onRefreshStravaRoutes?.() ?? {};
            routes = Array.isArray(catalog.routes) ? catalog.routes : [];
            initialized = true;
            renderOptions();
            setStatus(`已刷新并缓存 ${routes.length} 条 Strava 路线${formatCachedAt(catalog.cachedAt)}。`);
        } catch (error) {
            setStatus(`Strava 路线刷新失败：${extractErrorMessage(error)}；仍可使用上次缓存。`);
        } finally {
            setLoading(false);
        }
    }

    async function importSelected() {
        const route = selectedRoute();
        if (!route || loading || isEditingLocked()) return;
        setLoading(true, `正在导入“${route.name}”…`);
        try {
            const imported = await onImportStravaRoute?.({ routeId: route.id, name: route.name });
            if (!imported) throw new Error("路线未能导入，请重试。");
            setStatus(`已导入“${route.name}”，可以预览并开始骑行。`);
            return imported;
        } catch (error) {
            setStatus(`Strava 路线导入失败：${extractErrorMessage(error)}`);
            return null;
        } finally {
            setLoading(false);
        }
    }

    function renderOptions() {
        if (!elements.stravaRouteSelect) return;
        elements.stravaRouteSelect.innerHTML = routes.length
            ? routes.map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(formatRoute(route))}</option>`).join("")
            : "<option value=\"\">暂无 Strava 路线</option>";
        elements.stravaRouteSelect.value = routes[0]?.id ?? "";
    }

    function renderControls() {
        const locked = loading || isEditingLocked();
        if (elements.refreshStravaRoutesBtn) elements.refreshStravaRoutesBtn.disabled = locked;
        if (elements.stravaRouteSelect) elements.stravaRouteSelect.disabled = locked || routes.length === 0;
        if (elements.importStravaRouteBtn) elements.importStravaRouteBtn.disabled = locked || !selectedRoute();
    }

    function selectedRoute() {
        return routes.find((route) => String(route.id) === elements.stravaRouteSelect?.value) ?? null;
    }

    function isEditingLocked() {
        return lastState?.liveRide?.isActive === true || lastState?.route?.isLoading === true;
    }

    function setLoading(value, status = "") {
        loading = value;
        if (status) setStatus(status);
        renderControls();
    }

    function setStatus(value) {
        if (elements.stravaRouteImportStatus) elements.stravaRouteImportStatus.textContent = value;
    }

    return { bindEvents, render, ensureLoaded, loadCached, refreshLatest, importSelected };
}

function buildCacheStatus(count, cachedAt) {
    return `本地缓存 ${count} 条 Strava 路线${formatCachedAt(cachedAt)}；需要最新目录时点击“刷新最新路线”。`;
}

function formatCachedAt(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleString()}`;
}

function formatRoute(route) {
    const distance = `${formatNumber(Number(route.distanceMeters) / 1000, 1)} km`;
    const elevation = Number(route.elevationGainMeters) > 0
        ? ` · 爬升 ${Math.round(route.elevationGainMeters)} m`
        : "";
    const duration = Number(route.estimatedMovingTimeSeconds) > 0
        ? ` · ${formatDuration(route.estimatedMovingTimeSeconds)}`
        : "";
    return `${route.name} · ${distance}${elevation}${duration}`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
