import { formatNumber } from "../../shared/format.js";
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
        setMapProvider: (providerKey) => mapController?.setMapProvider?.(providerKey),
        syncRoute: (route) => mapController?.syncRoute?.(route),
        setPlannerClickHandler: (handler) => mapController?.setPlannerClickHandler?.(handler),
        setPlannerMode: (mode) => mapController?.setPlannerMode?.(mode),
        syncPlannerSelection: (selection) => mapController?.syncPlannerSelection?.(selection),
        invalidatePreviewSize: () => mapController?.invalidatePreviewSize?.()
    };
    const hasRouteModeControls = Boolean(elements.routeModeMapBtn || elements.mapRoutePanel);
    let routeInputMode = hasRouteModeControls ? "map" : "manual";
    let lastRenderedState = null;
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
        if (elements.mapProviderSelect) {
            visuals.setMapProvider(elements.mapProviderSelect.value);
            elements.mapProviderSelect.addEventListener("change", (e) => {
                visuals.setMapProvider(e.target.value);
            });
        }
        if (elements.clearMapRouteSelectionBtn) {
            elements.clearMapRouteSelectionBtn.addEventListener("click", clearMapRouteSelection);
        }
        if (elements.planMapRouteBtn) {
            elements.planMapRouteBtn.addEventListener("click", () => {
                onPlanMapRoute?.({
                    start: mapRouteSelection.start,
                    destination: mapRouteSelection.destination,
                    googleApiKey: elements.mapRouteGoogleApiKeyInput?.value?.trim() ?? ""
                });
            });
        }
        visuals.setPlannerClickHandler(({ mode, point }) => {
            if (routeInputMode !== "map") return;
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
        if (elements.routeSourceLabel) elements.routeSourceLabel.textContent = isGpx ? `GPX：${route.name}` : "手工路线";
        if (elements.addSegmentBtn) elements.addSegmentBtn.disabled = isGpx;
        if (elements.routeDistanceChip) elements.routeDistanceChip.textContent = `${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.routeElevationChip) elements.routeElevationChip.textContent = `${Math.round(route.totalElevationGainMeters)} m`;
        if (elements.routeSummary) {
            const sourceText = isGpx ? "GPX 导入" : "手工输入";
            const segmentsText = isGpx ? "" : `，共 ${route.segments.length} 段`;
            const elevationWarning = isGpx && route.hasElevationData === false
                ? "<br><span style=\"color: var(--danger);\">提示：当前 GPX 不含海拔数据，系统不会计算有效坡度，爬升与坡度图按 0 处理。</span>"
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
            visuals.syncRoute(state.route);
            visuals.syncPlannerSelection(mapRouteSelection);
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
        if (lastRenderedState) renderRouteTable(lastRenderedState);
        renderMapRoutePlanner();
    }

    function renderRouteModePanels() {
        if (!hasRouteModeControls) return;
        setPanelVisible(elements.gpxRoutePanel, routeInputMode === "gpx");
        setPanelVisible(elements.manualRoutePanel, routeInputMode === "manual");
        setPanelVisible(elements.mapRoutePanel, routeInputMode === "map");
        setPanelVisible(elements.routeMapShell, routeInputMode === "map");
        setModeButtonActive(elements.routeModeGpxBtn, routeInputMode === "gpx");
        setModeButtonActive(elements.routeModeManualBtn, routeInputMode === "manual");
        setModeButtonActive(elements.routeModeMapBtn, routeInputMode === "map");

        if (routeInputMode === "map") {
            queueMicrotask(() => {
                visuals.invalidatePreviewSize();
                if (lastRenderedState?.route) visuals.syncRoute(lastRenderedState.route);
                visuals.syncPlannerSelection(mapRouteSelection);
            });
        }
    }

    function clearMapRouteSelection() {
        onInvalidateMapRoute?.();
        mapRouteSelection.mode = null;
        mapRouteSelection.start = null;
        mapRouteSelection.destination = null;
        visuals.setPlannerMode("select");
        renderMapRoutePlanner();
    }

    function renderMapRoutePlanner() {
        if (!hasRouteModeControls) return;
        if (elements.mapRouteSelectionStatus) {
            elements.mapRouteSelectionStatus.textContent = mapRouteSelection.start && mapRouteSelection.destination
                ? "起点和起步目标已选择，可生成起步路线"
                : mapRouteSelection.start ? "已选择起点，点击地图选择起步目标" : "点击地图选择起点";
        }
        if (elements.mapRouteStartText) elements.mapRouteStartText.textContent = formatPoint(mapRouteSelection.start);
        if (elements.mapRouteDestinationText) elements.mapRouteDestinationText.textContent = formatPoint(mapRouteSelection.destination);
        if (elements.planMapRouteBtn) {
            elements.planMapRouteBtn.disabled = routeInputMode !== "map" || !mapRouteSelection.start || !mapRouteSelection.destination;
        }
        visuals.syncPlannerSelection(mapRouteSelection);
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

function setPanelVisible(panel, visible) {
    if (panel) panel.hidden = !visible;
}

function setModeButtonActive(button, active) {
    button?.classList?.toggle("active", active);
    button?.setAttribute?.("aria-selected", active ? "true" : "false");
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
