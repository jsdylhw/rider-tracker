import { formatNumber } from "../../shared/format.js";
import { extractErrorMessage } from "../../shared/utils/common.js";

export function createRouteLibraryRenderer({
    elements,
    onListSavedRoutes,
    onLoadSavedRoute,
    onContinueSavedRoute,
    onSaveCurrentRoute,
    onDeleteSavedRoute
}) {
    let routes = [];
    let lastSavedRouteId = null;
    let loading = false;

    function bindEvents() {
        elements.routeLibraryToggleBtn?.addEventListener("click", () => void toggleLibrary());
        elements.refreshSavedRoutesBtn?.addEventListener("click", () => void refresh());
        elements.savedRouteSelect?.addEventListener("change", renderControls);
        elements.loadSavedRouteBtn?.addEventListener("click", () => void loadSelected(false));
        elements.continueSavedRouteBtn?.addEventListener("click", () => void loadSelected(true));
        elements.saveCurrentRouteBtn?.addEventListener("click", () => void saveCurrent());
        elements.deleteSavedRouteBtn?.addEventListener("click", () => void deleteSelected());
    }

    function render(state) {
        const route = state?.route;
        const editingLocked = state?.liveRide?.isActive === true || route?.isLoading === true;
        const hasSavableRoute = Array.isArray(route?.points)
            && route.points.filter(hasCoordinate).length >= 2
            && Number(route.totalDistanceMeters) > 0;
        if (elements.saveCurrentRouteBtn) {
            elements.saveCurrentRouteBtn.disabled = loading || editingLocked || !hasSavableRoute;
        }
        [elements.savedRouteSelect, elements.refreshSavedRoutesBtn].forEach((element) => {
            if (element) element.disabled = loading || state?.liveRide?.isActive === true;
        });
        if (!elements.routeLibraryPanel?.hidden && route?.savedRouteId && route.savedRouteId !== lastSavedRouteId) {
            lastSavedRouteId = route.savedRouteId;
            void refresh(route.savedRouteId);
        } else {
            renderControls(editingLocked);
        }
    }

    async function toggleLibrary() {
        if (!elements.routeLibraryPanel) return;
        const willOpen = elements.routeLibraryPanel.hidden;
        elements.routeLibraryPanel.hidden = !willOpen;
        elements.routeLibraryToggleBtn?.setAttribute?.("aria-expanded", willOpen ? "true" : "false");
        elements.routeLibraryToggleBtn?.classList?.toggle("active", willOpen);
        if (willOpen) await refresh(lastSavedRouteId ?? "");
    }

    async function refresh(preferredRouteId = "") {
        if (loading) return;
        setLoading(true, "正在读取已保存路线…");
        try {
            routes = await onListSavedRoutes?.() ?? [];
            renderOptions(preferredRouteId || elements.savedRouteSelect?.value);
            setStatus(routes.length ? `共 ${routes.length} 条；可从起点加载或继续未完成路线。` : "尚无路线；确认 AI 路线或导入 GPX 后会自动保存。");
        } catch (error) {
            routes = [];
            renderOptions();
            setStatus(`路线库读取失败：${extractErrorMessage(error)}`);
        } finally {
            setLoading(false);
            renderControls();
        }
    }

    async function loadSelected(continueFromLastPosition) {
        const route = getSelectedRoute();
        if (!route || loading) return;
        setLoading(true, continueFromLastPosition ? "正在恢复路线进度…" : "正在加载路线…");
        try {
            const loadedRoute = continueFromLastPosition
                ? await onContinueSavedRoute?.(route.id)
                : await onLoadSavedRoute?.(route.id);
            if (!loadedRoute) throw new Error("路线未能加载，请重试。");
            setLoading(false);
            await refresh(route.id);
            setStatus(continueFromLastPosition
                ? `已从 ${formatNumber(route.resumeDistanceMeters / 1000, 1)} km 继续：${route.name}`
                : `已从起点加载：${route.name}`);
            return loadedRoute;
        } catch (error) {
            setStatus(`路线加载失败：${extractErrorMessage(error)}`);
            return null;
        } finally {
            setLoading(false);
            renderControls();
        }
    }

    async function saveCurrent() {
        if (loading) return;
        setLoading(true, "正在保存当前路线…");
        try {
            const saved = await onSaveCurrentRoute?.();
            setLoading(false);
            await refresh(saved?.id ?? "");
        } catch (error) {
            setStatus(`路线保存失败：${extractErrorMessage(error)}`);
        } finally {
            setLoading(false);
            renderControls();
        }
    }

    async function deleteSelected() {
        const route = getSelectedRoute();
        if (!route || loading) return;
        setLoading(true, "正在删除路线…");
        try {
            await onDeleteSavedRoute?.(route.id);
            setLoading(false);
            await refresh();
        } catch (error) {
            setStatus(`路线删除失败：${extractErrorMessage(error)}`);
        } finally {
            setLoading(false);
            renderControls();
        }
    }

    function renderOptions(preferredRouteId = "") {
        if (!elements.savedRouteSelect) return;
        elements.savedRouteSelect.innerHTML = routes.length
            ? routes.map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(formatRouteOption(route))}</option>`).join("")
            : "<option value=\"\">暂无已保存路线</option>";
        const selected = routes.find((route) => route.id === preferredRouteId) ?? routes[0];
        elements.savedRouteSelect.value = selected?.id ?? "";
    }

    function renderControls(editingLocked = false) {
        const selected = getSelectedRoute();
        if (elements.loadSavedRouteBtn) elements.loadSavedRouteBtn.disabled = loading || editingLocked || !selected;
        if (elements.continueSavedRouteBtn) {
            elements.continueSavedRouteBtn.disabled = loading || editingLocked || !selected || !(selected.resumeDistanceMeters > 0);
        }
        if (elements.deleteSavedRouteBtn) elements.deleteSavedRouteBtn.disabled = loading || editingLocked || !selected;
    }

    function getSelectedRoute() {
        return routes.find((route) => route.id === elements.savedRouteSelect?.value) ?? null;
    }

    function setLoading(value, status = "") {
        loading = value;
        if (status) setStatus(status);
    }

    function setStatus(value) {
        if (elements.savedRouteLibraryStatus) elements.savedRouteLibraryStatus.textContent = value;
    }

    return { bindEvents, render, refresh, loadSelected, toggleLibrary };
}

function hasCoordinate(point) {
    const latitude = Number(point?.latitude ?? point?.lat);
    const longitude = Number(point?.longitude ?? point?.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function formatRouteOption(route) {
    const distance = `${formatNumber(Number(route.totalDistanceMeters) / 1000, 1)} km`;
    const progress = route.resumeDistanceMeters > 0
        ? ` · 已骑 ${formatNumber(route.resumeDistanceMeters / 1000, 1)} km`
        : "";
    return `${route.name} · ${distance}${progress}`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
