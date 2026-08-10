import { buildRouteGeometryKey, collectRouteMapLatLngs } from "../map/map-controller.js";

export function createRouteInputController({
    elements,
    visuals,
    onInvalidateMapRoute,
    onPlanMapRoute,
    onInputModeChange = () => {}
}) {
    const hasRouteModeControls = Boolean(elements.routeModeMapBtn || elements.mapRoutePanel);
    let routeInputMode = hasRouteModeControls ? "map" : "manual";
    let lastRenderedState = null;
    let lastRenderedMapRouteSignature = "";
    let isEditingMapRoute = false;
    let isPlanningMapRoute = false;
    const mapRouteSelection = { mode: null, start: null, destination: null };

    function bindEvents() {
        bindRouteModeButton(elements.routeModeGpxBtn, "gpx");
        bindRouteModeButton(elements.routeModeManualBtn, "manual");
        bindRouteModeButton(elements.routeModeMapBtn, "map");
        elements.clearMapRouteSelectionBtn?.addEventListener("click", clearMapRouteSelection);
        elements.planMapRouteBtn?.addEventListener("click", async () => {
            if (isRouteEditingLocked() || isRouteLoading()) return;
            isEditingMapRoute = false;
            isPlanningMapRoute = true;
            renderMapRoutePlanner();
            try {
                await onPlanMapRoute?.({
                    start: mapRouteSelection.start,
                    destination: mapRouteSelection.destination
                });
            } finally {
                isPlanningMapRoute = false;
                renderMapRoutePlanner();
            }
        });
        visuals.setPlannerClickHandler(({ mode, point }) => {
            if (routeInputMode !== "map" || isRouteEditingLocked() || isRouteLoading()) return;
            isEditingMapRoute = true;
            isPlanningMapRoute = false;
            const selectionMode = mode === "start" || mode === "destination"
                ? mode
                : (!mapRouteSelection.start || mapRouteSelection.destination ? "start" : "destination");
            onInvalidateMapRoute?.();
            if (selectionMode === "start") mapRouteSelection.destination = null;
            mapRouteSelection[selectionMode] = point;
            mapRouteSelection.mode = null;
            visuals.setPlannerMode("select");
            renderMapRoutePlanner();
        });
        if (routeInputMode === "map") visuals.setPlannerMode("select");
    }

    function render(state) {
        if (hasActiveRoute(lastRenderedState?.route) && !hasActiveRoute(state?.route)) {
            resetMapRouteSelection();
        }
        lastRenderedState = state;
        renderRouteMap(state);
        renderRouteModePanels();
        renderMapRoutePlanner();
    }

    function getInputMode() {
        return routeInputMode;
    }

    function renderRouteMap(state) {
        try {
            const signature = buildMapRouteSignature(state.route);
            if (signature === lastRenderedMapRouteSignature) return;
            visuals.syncRoute(state.route);
            lastRenderedMapRouteSignature = signature;
            visuals.syncPlannerSelection(getVisiblePlannerSelection());
        } catch (error) {
            console.warn("路线地图渲染失败，不影响距离/海拔预览。", error);
        }
    }

    function bindRouteModeButton(button, mode) {
        button?.addEventListener("click", () => setRouteInputMode(mode));
    }

    function setRouteInputMode(mode) {
        routeInputMode = mode;
        if (mode === "map") {
            visuals.setPlannerMode("select");
        } else {
            mapRouteSelection.mode = null;
            visuals.setPlannerMode(null);
        }
        renderRouteModePanels();
        renderMapRoutePlanner();
        if (lastRenderedState) {
            onInputModeChange(lastRenderedState);
        }
    }

    function renderRouteModePanels() {
        if (!hasRouteModeControls) return;
        const route = lastRenderedState?.route;
        const hasActiveRouteForMode = matchesRouteInputMode(route, routeInputMode);
        const shouldShowRouteMap = routeInputMode === "map"
            || (hasActiveRouteForMode && hasCoordinateRoute(route));
        setPanelVisible(elements.gpxRoutePanel, routeInputMode === "gpx");
        setPanelVisible(elements.manualRoutePanel, routeInputMode === "manual");
        setPanelVisible(elements.mapRoutePanel, routeInputMode === "map");
        setPanelVisible(elements.routeMapShell, shouldShowRouteMap);
        setPanelVisible(elements.setupElevationChartShell, hasActiveRouteForMode);
        setPanelVisible(elements.routeCurrentSourceRow, hasActiveRouteForMode);
        setModeButtonActive(elements.routeModeGpxBtn, routeInputMode === "gpx");
        setModeButtonActive(elements.routeModeManualBtn, routeInputMode === "manual");
        setModeButtonActive(elements.routeModeMapBtn, routeInputMode === "map");

        if (shouldShowRouteMap) {
            scheduleMapPreviewRefresh(() => {
                visuals.invalidatePreviewSize();
                if (lastRenderedState?.route) visuals.syncRoute(lastRenderedState.route);
                visuals.syncPlannerSelection(getVisiblePlannerSelection());
            });
        }
    }

    function clearMapRouteSelection() {
        if (isRouteEditingLocked()) return;
        onInvalidateMapRoute?.();
        resetMapRouteSelection();
        renderMapRoutePlanner();
    }

    function resetMapRouteSelection() {
        isEditingMapRoute = true;
        isPlanningMapRoute = false;
        mapRouteSelection.mode = null;
        mapRouteSelection.start = null;
        mapRouteSelection.destination = null;
        if (routeInputMode === "map") visuals.setPlannerMode("select");
    }

    function renderMapRoutePlanner() {
        if (!hasRouteModeControls) return;
        const hasGeneratedRoute = hasGeneratedMapRoute();
        const routeEditingLocked = isRouteEditingLocked();
        const routeLoading = isRouteLoading();
        if (elements.mapRouteSelectionStatus) {
            elements.mapRouteSelectionStatus.textContent = routeEditingLocked
                ? "骑行中路线已锁定，结束骑行后可重新选点"
                : routeLoading
                    ? "正在处理路线，完成前不能开始骑行"
                    : hasGeneratedRoute
                        ? "起步路线已生成，可开始骑行或重新选点"
                        : isPlanningMapRoute
                            ? "正在请求路网并生成起步路线..."
                            : mapRouteSelection.start && mapRouteSelection.destination
                                ? "起点和起步目标已选择，可生成起步路线"
                                : mapRouteSelection.start ? "已选择起点，点击地图选择起步目标" : "点击地图选择起点";
        }
        if (elements.mapRouteStartText) elements.mapRouteStartText.textContent = formatPoint(mapRouteSelection.start);
        if (elements.mapRouteDestinationText) elements.mapRouteDestinationText.textContent = formatPoint(mapRouteSelection.destination);
        if (elements.clearMapRouteSelectionBtn) {
            elements.clearMapRouteSelectionBtn.textContent = hasGeneratedRoute ? "重选路线" : "清空";
            elements.clearMapRouteSelectionBtn.disabled = routeEditingLocked;
        }
        if (elements.planMapRouteBtn) {
            elements.planMapRouteBtn.hidden = hasGeneratedRoute;
            elements.planMapRouteBtn.disabled = isPlanningMapRoute
                || routeLoading
                || routeEditingLocked
                || routeInputMode !== "map"
                || !mapRouteSelection.start
                || !mapRouteSelection.destination;
        }
        visuals.syncPlannerSelection(getVisiblePlannerSelection());
    }

    function hasGeneratedMapRoute() {
        return routeInputMode === "map"
            && lastRenderedState?.route?.source === "osm-exploration"
            && !isEditingMapRoute;
    }

    function isRouteEditingLocked() {
        return lastRenderedState?.liveRide?.isActive === true;
    }

    function isRouteLoading() {
        return lastRenderedState?.route?.isLoading === true;
    }

    function getVisiblePlannerSelection() {
        if (lastRenderedState?.route?.source === "osm-exploration" && !isEditingMapRoute) return null;
        return mapRouteSelection;
    }

    return { bindEvents, render, getInputMode };
}

function buildMapRouteSignature(route) {
    const geometry = collectRouteMapLatLngs(route);
    return `${route?.networkSource ?? "default"}:${buildRouteGeometryKey(route, geometry)}`;
}

function matchesRouteInputMode(route, inputMode) {
    if (inputMode === "map") return route?.source === "osm-exploration";
    if (inputMode === "gpx") return route?.source === "gpx";
    return route?.source === "manual";
}

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude));
}

function hasActiveRoute(route) {
    return Number(route?.totalDistanceMeters) > 0;
}

function setPanelVisible(panel, visible) {
    if (panel) panel.hidden = !visible;
}

function setModeButtonActive(button, active) {
    button?.classList?.toggle("active", active);
    button?.setAttribute?.("aria-selected", active ? "true" : "false");
}

function scheduleMapPreviewRefresh(callback) {
    if (typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(callback);
        return;
    }
    queueMicrotask(callback);
}

function formatPoint(point) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return "未选择";
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}
