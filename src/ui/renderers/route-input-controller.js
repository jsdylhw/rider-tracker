import { buildRouteGeometryKey, collectRouteMapLatLngs } from "../map/map-controller.js";
import { capabilityMessage } from "../../domain/agent/agent-capabilities.js";

export function createRouteInputController({
    elements,
    visuals,
    onCreateMapDrawRoute,
    onInvalidateMapRoute,
    onPlanMapRoute,
    onRequestRouteElevation,
    requestGoogleMapsApiKey = async () => "",
    onInputModeChange = () => {}
}) {
    const hasRouteModeControls = Boolean(elements.routeModeMapBtn || elements.mapRoutePanel || elements.routeModeDrawBtn);
    let routeInputMode = elements.routeModeAiBtn ? "ai" : (hasRouteModeControls ? "map" : "manual");
    let lastRenderedState = null;
    let lastRenderedMapRouteSignature = "";
    let isEditingMapRoute = false;
    let isPlanningMapRoute = false;
    let isEditingMapDrawRoute = false;
    let isCreatingMapDrawRoute = false;
    let isRequestingMapDrawElevation = false;
    let mapDrawFeedback = "";
    const mapRouteSelection = { mode: null, start: null, destination: null };
    const mapDrawSelection = { waypoints: [] };

    function bindEvents() {
        bindRouteModeButton(elements.routeModeAiBtn, "ai");
        bindRouteModeButton(elements.routeModeLibraryBtn, "library");
        bindRouteModeButton(elements.routeModeManualBtn, "manual");
        bindRouteModeButton(elements.routeModeDrawBtn, "draw");
        bindRouteModeButton(elements.routeModeMapBtn, "map");
        elements.clearMapRouteSelectionBtn?.addEventListener("click", clearMapRouteSelection);
        elements.planMapRouteBtn?.addEventListener("click", planMapRoute);
        elements.undoMapDrawWaypointBtn?.addEventListener("click", undoMapDrawWaypoint);
        elements.clearMapDrawRouteBtn?.addEventListener("click", clearMapDrawRoute);
        elements.createMapDrawRouteBtn?.addEventListener("click", createMapDrawRoute);
        elements.requestMapDrawElevationBtn?.addEventListener("click", () => requestMapDrawElevation());
        visuals.setPlannerClickHandler(({ mode, point }) => handlePlannerClick(mode, point));
        if (routeInputMode === "map") visuals.setPlannerMode("select");
    }

    function render(state) {
        if (hasActiveRoute(lastRenderedState?.route) && !hasActiveRoute(state?.route)) {
            resetMapRouteSelection();
        }
        lastRenderedState = state;
        enforceAvailableInputMode();
        renderRouteMap(state);
        renderRouteModePanels();
        renderMapRoutePlanner();
        renderMapDrawRoutePlanner();
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
        button?.addEventListener("click", () => {
            if (!isInputModeAvailable(mode)) return;
            setRouteInputMode(mode);
        });
    }

    function setRouteInputMode(mode) {
        routeInputMode = mode;
        if (mode === "map" || mode === "draw") {
            visuals.setPlannerMode("select");
        } else {
            mapRouteSelection.mode = null;
            visuals.setPlannerMode(null);
        }
        renderRouteModePanels();
        renderMapRoutePlanner();
        renderMapDrawRoutePlanner();
        if (lastRenderedState) {
            onInputModeChange(lastRenderedState);
        }
    }

    function renderRouteModePanels() {
        if (!hasRouteModeControls) return;
        const route = lastRenderedState?.route;
        const hasCurrentRoute = hasActiveRoute(route);
        const shouldShowRouteMap = routeInputMode === "ai"
            || routeInputMode === "map"
            || routeInputMode === "draw"
            || (hasCurrentRoute && hasCoordinateRoute(route));
        setPanelVisible(elements.aiRoutePanel, routeInputMode === "ai");
        setPanelVisible(elements.routeLibraryPanel, routeInputMode === "library");
        setPanelVisible(elements.manualRoutePanel, routeInputMode === "manual");
        setPanelVisible(elements.mapDrawRoutePanel, routeInputMode === "draw");
        setPanelVisible(elements.mapRoutePanel, routeInputMode === "map");
        setPanelVisible(elements.routeMapShell, shouldShowRouteMap);
        const shouldShowElevation = hasCurrentRoute && route?.hasElevationData !== false;
        setPanelVisible(elements.setupElevationChartShell, shouldShowElevation);
        setPanelVisible(elements.routeCurrentSourceRow, hasCurrentRoute);
        setModeButtonActive(elements.routeModeAiBtn, routeInputMode === "ai");
        setModeButtonActive(elements.routeModeLibraryBtn, routeInputMode === "library");
        setModeButtonActive(elements.routeModeManualBtn, routeInputMode === "manual");
        setModeButtonActive(elements.routeModeDrawBtn, routeInputMode === "draw");
        setModeButtonActive(elements.routeModeMapBtn, routeInputMode === "map");
        renderRouteModeAvailability();

        if (shouldShowRouteMap) {
            scheduleMapPreviewRefresh(() => {
                visuals.invalidatePreviewSize();
                if (lastRenderedState?.route) visuals.syncRoute(lastRenderedState.route);
                visuals.syncPlannerSelection(getVisiblePlannerSelection());
            });
        }
    }

    function enforceAvailableInputMode() {
        const availability = lastRenderedState?.agentCapabilities;
        if (!availability || availability.backend === "checking") return;
        if (!isInputModeAvailable(routeInputMode)) routeInputMode = "library";
    }

    function isInputModeAvailable(mode) {
        if (mode === "library" || mode === "manual") return true;
        const availability = lastRenderedState?.agentCapabilities;
        if (!availability) return true;
        if (availability?.backend !== "available") return mode === "library";
        const capability = routeModeCapability(mode);
        return capability ? availability.capabilities?.[capability] === true : false;
    }

    function renderRouteModeAvailability() {
        const availability = lastRenderedState?.agentCapabilities;
        for (const [button, mode, capability] of [
            [elements.routeModeAiBtn, "ai", "ai_route_planning"],
            [elements.routeModeManualBtn, "manual", null],
            [elements.routeModeDrawBtn, "draw", "map_waypoint_routes"],
            [elements.routeModeMapBtn, "map", "map_exploration"]
        ]) {
            if (!button) continue;
            const available = isInputModeAvailable(mode);
            button.disabled = !available;
            button.title = available ? "" : capabilityMessage(availability, capability);
        }
        if (elements.routeModeLibraryBtn) {
            elements.routeModeLibraryBtn.disabled = false;
            elements.routeModeLibraryBtn.title = "GPX、Strava 与本地保存路线始终可以使用。";
        }
    }

    function handlePlannerClick(mode, point) {
        if (isRouteEditingLocked() || isRouteLoading()) return;
        if (routeInputMode === "draw") {
            onInvalidateMapRoute?.();
            isEditingMapDrawRoute = true;
            mapDrawSelection.waypoints.push(point);
            mapDrawFeedback = "";
            visuals.setPlannerMode("select");
            renderMapDrawRoutePlanner();
            return;
        }
        if (routeInputMode !== "map") return;

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
    }

    async function planMapRoute() {
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

    function undoMapDrawWaypoint() {
        if (isRouteEditingLocked() || isRouteLoading() || mapDrawSelection.waypoints.length === 0) return;
        onInvalidateMapRoute?.();
        isEditingMapDrawRoute = true;
        mapDrawSelection.waypoints.pop();
        visuals.setPlannerMode("select");
        renderMapDrawRoutePlanner();
    }

    function clearMapDrawRoute() {
        if (isRouteEditingLocked()) return;
        onInvalidateMapRoute?.();
        isEditingMapDrawRoute = true;
        isCreatingMapDrawRoute = false;
        mapDrawSelection.waypoints = [];
        mapDrawFeedback = "";
        visuals.setPlannerMode("select");
        renderMapDrawRoutePlanner();
    }

    async function createMapDrawRoute() {
        if (isRouteEditingLocked() || isRouteLoading() || mapDrawSelection.waypoints.length < 2) return;
        isCreatingMapDrawRoute = true;
        mapDrawFeedback = "正在准备 Google 骑行路线请求...";
        renderMapDrawRoutePlanner();
        try {
            const apiKey = await requestGoogleMapsApiKey({ featureLabel: "生成骑行路线" });
            if (!apiKey) {
                mapDrawFeedback = "Google API 未配置；请在 config.yaml 中配置后重启服务。";
                return;
            }
            mapDrawFeedback = "正在调用 Google Routes API 生成骑行路线...";
            renderMapDrawRoutePlanner();
            const route = await onCreateMapDrawRoute?.(mapDrawSelection.waypoints);
            if (!route) return;
            isEditingMapDrawRoute = false;
            mapDrawFeedback = "骑行路线已生成，正在请求 Google 参考海拔...";
            renderMapDrawRoutePlanner();
            await requestMapDrawElevation();
        } catch (error) {
            console.warn("地图路线生成失败", error);
            mapDrawFeedback = `地图骑行路线生成失败：${error?.message ?? "请检查 config.yaml、Google Routes API 和网络后重试。"}`;
        } finally {
            isCreatingMapDrawRoute = false;
            renderMapDrawRoutePlanner();
        }
    }

    async function requestMapDrawElevation() {
        const route = lastRenderedState?.route;
        if (route?.source !== "map-drawn"
            || route.hasElevationData
            || route.isLoading
            || isRouteEditingLocked()
            || isRequestingMapDrawElevation) return;

        const apiKey = await requestGoogleMapsApiKey({ featureLabel: "补全地图路线参考海拔" });
        if (!apiKey) return;

        isRequestingMapDrawElevation = true;
        mapDrawFeedback = "正在请求 Google 路线参考海拔...";
        renderMapDrawRoutePlanner();
        try {
            await onRequestRouteElevation?.();
            mapDrawFeedback = "";
        } catch (error) {
            console.warn("地图路线海拔请求失败", error);
            mapDrawFeedback = `路线参考海拔请求失败：${error?.message ?? "请检查 config.yaml、Google Elevation API 和网络后重试。"}`;
        } finally {
            isRequestingMapDrawElevation = false;
            renderMapDrawRoutePlanner();
        }
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
        if (routeInputMode === "map") visuals.syncPlannerSelection(getVisiblePlannerSelection());
    }

    function renderMapDrawRoutePlanner() {
        if (!hasRouteModeControls) return;
        const route = lastRenderedState?.route;
        const hasGeneratedRoute = hasGeneratedMapDrawRoute();
        const routeEditingLocked = isRouteEditingLocked();
        const routeLoading = isRouteLoading();
        const waypointCount = mapDrawSelection.waypoints.length;

        if (elements.mapDrawRouteStatus) {
            elements.mapDrawRouteStatus.textContent = routeEditingLocked
                ? "骑行中路线已锁定，结束骑行后可重新选择"
                : routeLoading
                    ? "正在生成骑行路线或请求参考海拔，完成前不能开始骑行"
                    : hasGeneratedRoute
                        ? route.hasElevationData ? "骑行路线和参考海拔已生成，可开始骑行或重选" : "骑行路线已生成，可请求参考海拔或重选"
                        : waypointCount >= 2
                            ? `已选择 ${waypointCount} 个点，可继续添加途经点或生成路线`
                            : "点击地图依次添加起点、途经点和终点";
        }
        if (elements.mapDrawWaypointSummary) {
            const selectedText = waypointCount === 0
                ? "尚未选择"
                : `共 ${waypointCount} 个点 · ${formatPoint(mapDrawSelection.waypoints[0])} ${waypointCount > 1 ? `→ ${formatPoint(mapDrawSelection.waypoints.at(-1))}` : ""}`;
            elements.mapDrawWaypointSummary.textContent = `${selectedText}${buildWaypointSnapSummary(route, hasGeneratedRoute)}`;
        }
        if (elements.undoMapDrawWaypointBtn) {
            elements.undoMapDrawWaypointBtn.disabled = routeEditingLocked || routeLoading || waypointCount === 0;
        }
        if (elements.clearMapDrawRouteBtn) {
            elements.clearMapDrawRouteBtn.textContent = hasGeneratedRoute ? "重选路线" : "清空";
            elements.clearMapDrawRouteBtn.disabled = routeEditingLocked;
        }
        if (elements.createMapDrawRouteBtn) {
            elements.createMapDrawRouteBtn.hidden = hasGeneratedRoute;
            elements.createMapDrawRouteBtn.disabled = routeEditingLocked
                || routeLoading
                || isCreatingMapDrawRoute
                || routeInputMode !== "draw"
                || waypointCount < 2;
        }
        if (elements.requestMapDrawElevationBtn) {
            elements.requestMapDrawElevationBtn.hidden = !hasGeneratedRoute || route?.hasElevationData === true;
            elements.requestMapDrawElevationBtn.disabled = routeEditingLocked || routeLoading || isRequestingMapDrawElevation;
            elements.requestMapDrawElevationBtn.textContent = isRequestingMapDrawElevation ? "正在请求参考海拔" : "请求参考海拔";
        }
        if (elements.mapDrawRoutePlanStatus) {
            const statusText = mapDrawFeedback || (hasGeneratedRoute ? (lastRenderedState?.statusText ?? "") : "");
            elements.mapDrawRoutePlanStatus.hidden = !statusText;
            elements.mapDrawRoutePlanStatus.textContent = statusText;
        }
        if (routeInputMode === "draw") visuals.syncPlannerSelection(getVisiblePlannerSelection());
    }

    function hasGeneratedMapRoute() {
        return routeInputMode === "map"
            && lastRenderedState?.route?.source === "osm-exploration"
            && !isEditingMapRoute;
    }

    function hasGeneratedMapDrawRoute() {
        return routeInputMode === "draw"
            && lastRenderedState?.route?.source === "map-drawn"
            && !isEditingMapDrawRoute;
    }

    function isRouteEditingLocked() {
        return lastRenderedState?.liveRide?.isActive === true;
    }

    function isRouteLoading() {
        return lastRenderedState?.route?.isLoading === true;
    }

    function getVisiblePlannerSelection() {
        if (routeInputMode === "draw") {
            return hasGeneratedMapDrawRoute() ? null : mapDrawSelection;
        }
        if (routeInputMode === "map") {
            return lastRenderedState?.route?.source === "osm-exploration" && !isEditingMapRoute
                ? null
                : mapRouteSelection;
        }
        return null;
    }

    return { bindEvents, render, getInputMode, setInputMode: setRouteInputMode };
}

function routeModeCapability(mode) {
    if (mode === "ai") return "ai_route_planning";
    if (mode === "draw") return "map_waypoint_routes";
    if (mode === "map") return "map_exploration";
    return null;
}

function buildMapRouteSignature(route) {
    const geometry = collectRouteMapLatLngs(route);
    const overlays = (route?.agentSegmentOverlays ?? []).map((item) => (
        `${item.segmentId}:${item.coordinates?.length ?? 0}`
    )).join(",");
    return `${route?.networkSource ?? "default"}:${buildRouteGeometryKey(route, geometry)}:${overlays}`;
}

function buildWaypointSnapSummary(route, hasGeneratedRoute) {
    if (!hasGeneratedRoute) return "";
    const offsets = (route?.waypointSnaps ?? [])
        .map((snap) => Number(snap?.offsetMeters))
        .filter(Number.isFinite);
    const maximumOffset = Math.max(0, ...offsets);
    const roadSnapText = maximumOffset >= 3 ? ` · 已吸附至道路（最大偏移 ${Math.round(maximumOffset)} m）` : "";
    return roadSnapText;
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
