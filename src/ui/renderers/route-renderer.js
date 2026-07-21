import { formatNumber } from "../../shared/format.js";
import { buildRouteGeometryKey, collectRouteMapLatLngs } from "../map/map-controller.js";
import {
    buildElevationProfileSvg,
    buildGradeChartSvg,
    buildRouteChartEmptyStateSvg
} from "./svg/route-charts.js";

export function createRouteRenderer({
    elements,
    rideVisuals,
    // Compatibility for focused renderer tests while callers move to rideVisuals.
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onInvalidateMapRoute,
    onPlanMapRoute,
    onUpdateRouteSegment,
    onRemoveRouteSegment
}) {
    const visuals = rideVisuals ?? {
        syncRoute: (route) => mapController?.syncRoute?.(route),
        setPlannerClickHandler: (handler) => mapController?.setPlannerClickHandler?.(handler),
        setPlannerMode: (mode) => mapController?.setPlannerMode?.(mode),
        syncPlannerSelection: (selection) => mapController?.syncPlannerSelection?.(selection),
        invalidatePreviewSize: () => mapController?.invalidatePreviewSize?.()
    };
    const hasRouteModeControls = Boolean(elements.routeModeMapBtn || elements.mapRoutePanel);
    let routeInputMode = hasRouteModeControls ? "map" : "manual";
    let lastRenderedState = null;
    let lastRenderedMapRouteSignature = "";
    let isEditingMapRoute = false;
    let isPlanningMapRoute = false;
    const mapRouteSelection = { mode: null, start: null, destination: null };

    function bindEvents() {
        if (elements.addSegmentBtn) {
            elements.addSegmentBtn.addEventListener("click", onAddSegment);
        }
        if (elements.resetRouteBtn) {
            elements.resetRouteBtn.addEventListener("click", onResetRoute);
        }
        bindRouteModeButton(elements.routeModeGpxBtn, "gpx");
        bindRouteModeButton(elements.routeModeManualBtn, "manual");
        bindRouteModeButton(elements.routeModeMapBtn, "map");
        if (elements.gpxFileInput) {
            elements.gpxFileInput.addEventListener("click", (event) => {
                // 允许重复选择同一个文件时依然触发 change
                event.target.value = "";
            });
            elements.gpxFileInput.addEventListener("change", async (event) => {
                const [file] = event.target.files ?? [];
                if (!file) return;
                try {
                    await onImportGpx(file);
                } finally {
                    // 无论导入成功或失败，都清空，避免下次同名同文件不触发
                    event.target.value = "";
                }
            });
        }
        if (elements.clearMapRouteSelectionBtn) {
            elements.clearMapRouteSelectionBtn.addEventListener("click", clearMapRouteSelection);
        }
        if (elements.planMapRouteBtn) {
            elements.planMapRouteBtn.addEventListener("click", async () => {
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
        }
        visuals.setPlannerClickHandler(({ mode, point }) => {
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
        });
        if (routeInputMode === "map") {
            visuals.setPlannerMode("select");
        }
    }

    function render(state) {
        lastRenderedState = state;
        renderRouteTable(state);
        renderRouteSummary(state);
        renderRouteMap(state);
        renderRouteModePanels();
        renderMapRoutePlanner();
    }

    function renderRouteTable(state) {
        const isGpx = state.route.source === "gpx";
        const isEditable = !hasRouteModeControls
            ? !isGpx
            : routeInputMode === "manual" && state.route.source === "manual";
        
        if (elements.routeTableShell) {
            elements.routeTableShell.hidden = !isEditable;
        }

        if (!isEditable) {
            return;
        }

        if (elements.routeTableBody) {
            elements.routeTableBody.innerHTML = state.routeSegments.map((segment) => `
                <tr data-segment-id="${segment.id}">
                    <td>
                        <input data-field="name" value="${escapeHtml(segment.name)}">
                    </td>
                    <td>
                        <input data-field="distanceKm" type="number" min="0.1" max="200" step="0.1" value="${segment.distanceKm}">
                    </td>
                    <td>
                        <input data-field="gradePercent" type="number" min="-15" max="20" step="0.1" value="${segment.gradePercent}">
                    </td>
                    <td class="action-cell">
                        <button class="remove-segment-btn" data-remove-segment="${segment.id}" ${state.routeSegments.length === 1 ? "disabled" : ""}>×</button>
                    </td>
                </tr>
            `).join("");

            [...elements.routeTableBody.querySelectorAll("input[data-field]")].forEach((input) => {
                input.addEventListener("input", (event) => {
                    const row = event.target.closest("tr");
                    onUpdateRouteSegment(row.dataset.segmentId, event.target.dataset.field, event.target.value);
                });
            });

            [...elements.routeTableBody.querySelectorAll("[data-remove-segment]")].forEach((button) => {
                button.addEventListener("click", () => {
                    onRemoveRouteSegment(button.dataset.removeSegment);
                });
            });
        }
    }

    function renderRouteSummary(state) {
        const route = state.route;
        const isGpx = route.source === "gpx";
        const isExploration = route.source === "osm-exploration";
        const isPendingMapExploration = routeInputMode === "map" && !isExploration;
        const isPendingGpxImport = routeInputMode === "gpx" && !isGpx;
        if (elements.routeSourceLabel) {
            elements.routeSourceLabel.textContent = isPendingMapExploration
                ? "地图探索（待生成）"
                : isPendingGpxImport
                    ? "GPX（待导入）"
                : isExploration
                    ? "OSM 街景探索"
                    : isGpx
                        ? `GPX：${route.name}`
                        : "手工路线";
        }
        if (elements.addSegmentBtn) elements.addSegmentBtn.disabled = routeInputMode !== "manual" || isGpx;
        if (elements.routeDistanceChip) elements.routeDistanceChip.textContent = `${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.routeElevationChip) elements.routeElevationChip.textContent = `${Math.round(route.totalElevationGainMeters)} m`;
        if (elements.routeSummary) {
            if (isPendingMapExploration) {
                elements.routeSummary.innerHTML = `
                    <strong>地图探索</strong><br>
                    请在地图上选择起点和起步目标。系统会请求周边 OSM 路网，生成初始探索路线。
                `;
                return;
            }
            if (isPendingGpxImport) {
                elements.routeSummary.innerHTML = `
                    <strong>GPX 导入</strong><br>
                    选择 GPX 文件后显示路线距离、海拔和坡度图。
                `;
                return;
            }

            const sourceText = isExploration ? "OSM 地图探索" : isGpx ? "GPX 导入" : "手工输入";
            const segmentsText = isGpx ? "" : `，共 ${route.segments.length} 段`;
            const elevationWarning = route.hasElevationData === false
                ? `<br><span style="color: var(--danger);">提示：当前${isExploration ? "探索路线" : "GPX"}尚无海拔数据，坡度按 0 处理；可在骑行界面请求路线海拔。</span>`
                : "";
            
            elements.routeSummary.innerHTML = `
                <strong>路线概览</strong><br>
                来源：${sourceText}${segmentsText}，累计距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km，
                累计爬升 ${Math.round(route.totalElevationGainMeters)} m，
                累计下降 ${Math.round(route.totalDescentMeters)} m。${elevationWarning}
            `;
        }
    }

    function renderRouteMap(state) {
        try {
            const routeSignature = buildMapRouteSignature(state.route);
            if (routeSignature === lastRenderedMapRouteSignature) {
                return;
            }
            visuals.syncRoute(state.route);
            lastRenderedMapRouteSignature = routeSignature;
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
        if (lastRenderedState) {
            renderRouteTable(lastRenderedState);
            renderRouteSummary(lastRenderedState);
        }
        renderMapRoutePlanner();
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
        onInvalidateMapRoute?.();
        isEditingMapRoute = true;
        isPlanningMapRoute = false;
        mapRouteSelection.mode = null;
        mapRouteSelection.start = null;
        mapRouteSelection.destination = null;
        visuals.setPlannerMode("select");
        renderMapRoutePlanner();
    }

    function renderMapRoutePlanner() {
        if (!hasRouteModeControls) return;
        const hasGeneratedRoute = hasGeneratedMapRoute();
        if (elements.mapRouteSelectionStatus) {
            elements.mapRouteSelectionStatus.textContent = hasGeneratedRoute
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
            elements.clearMapRouteSelectionBtn.textContent = hasGeneratedRoute ? "重新选点" : "清空";
        }
        if (elements.planMapRouteBtn) {
            elements.planMapRouteBtn.hidden = hasGeneratedRoute;
            elements.planMapRouteBtn.disabled = isPlanningMapRoute
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

    function getVisiblePlannerSelection() {
        if (lastRenderedState?.route?.source === "osm-exploration" && !isEditingMapRoute) {
            return null;
        }
        return mapRouteSelection;
    }

    function renderElevationChart(route, currentRecord) {
        if (!elements.elevationChart && !elements.setupElevationChart && !elements.rideDashboardElevationChart) return;

        // 沉浸街景模式下 dashboard renderer 负责绘制坡度图，避免双图交替闪烁
        const isDashboardImmersive = elements.rideDashboard?.classList.contains("immersive-street-view") === true;

        if (!route || !route.points || route.points.length === 0) {
            const emptyGradeState = buildRouteChartEmptyStateSvg("导入路线后显示坡度图");
            const emptyElevationState = buildRouteChartEmptyStateSvg("导入路线后显示距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = emptyGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = emptyElevationState;
            if (elements.rideDashboardElevationChart && !isDashboardImmersive) elements.rideDashboardElevationChart.innerHTML = emptyGradeState;
            return;
        }

        if (route.hasElevationData === false) {
            const noGradeState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效坡度图");
            const noElevationState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = noGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = noElevationState;
            if (elements.rideDashboardElevationChart && !isDashboardImmersive) elements.rideDashboardElevationChart.innerHTML = noGradeState;
            return;
        }

        const gradeChartSvg = buildGradeChartSvg(route, currentRecord);
        const elevationProfileSvg = buildElevationProfileSvg(route, currentRecord);

        if (elements.elevationChart) {
            elements.elevationChart.innerHTML = gradeChartSvg;
        }
        if (elements.rideDashboardElevationChart && !isDashboardImmersive) {
            elements.rideDashboardElevationChart.innerHTML = elevationProfileSvg;
        }
        if (elements.setupElevationChart) {
            elements.setupElevationChart.innerHTML = elevationProfileSvg;
        }
    }

    bindEvents();

    return {
        render,
        renderElevationChart // Expose for dashboard to use with currentRecord
    };
}

function buildMapRouteSignature(route) {
    const geometry = collectRouteMapLatLngs(route);
    return `${route?.networkSource ?? "default"}:${buildRouteGeometryKey(route, geometry)}`;
}

function matchesRouteInputMode(route, inputMode) {
    if (inputMode === "map") {
        return route?.source === "osm-exploration";
    }
    if (inputMode === "gpx") {
        return route?.source === "gpx";
    }
    return route?.source === "manual";
}

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude));
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

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
