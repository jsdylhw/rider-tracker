import { formatNumber } from "../../shared/format.js";
import {
    buildElevationProfileSvg,
    buildGradeChartSvg,
    buildRouteChartEmptyStateSvg
} from "./svg/route-charts.js";

export function createRouteRenderer({
    elements,
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment
}) {
    function bindEvents() {
        if (elements.addSegmentBtn) {
            elements.addSegmentBtn.addEventListener("click", onAddSegment);
        }
        if (elements.resetRouteBtn) {
            elements.resetRouteBtn.addEventListener("click", onResetRoute);
        }
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
            mapController.setMapProvider(elements.mapProviderSelect.value);
            elements.mapProviderSelect.addEventListener("change", (e) => {
                mapController.setMapProvider(e.target.value);
            });
        }
    }

    function render(state) {
        renderRouteTable(state);
        renderRouteSummary(state);
        renderElevationChart(state.route, null);
        renderRouteMap(state);
    }

    function renderRouteTable(state) {
        const isGpx = state.route.source === "gpx";
        
        if (elements.routeTableShell) {
            elements.routeTableShell.hidden = isGpx;
        }

        if (isGpx) {
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
        if (elements.savedSessionChip) elements.savedSessionChip.textContent = state.session ? "已更新" : state.hasPersistedSession ? "已恢复" : "未保存";
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
            mapController.syncRoute(state.route);
        } catch (error) {
            console.warn("路线地图渲染失败，不影响距离/海拔预览。", error);
        }
    }

    function renderElevationChart(route, currentRecord) {
        if (!elements.elevationChart && !elements.setupElevationChart && !elements.rideDashboardElevationChart) return;

        if (!route || !route.points || route.points.length === 0) {
            const emptyGradeState = buildRouteChartEmptyStateSvg("导入路线后显示坡度图");
            const emptyElevationState = buildRouteChartEmptyStateSvg("导入路线后显示距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = emptyGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = emptyElevationState;
            if (elements.rideDashboardElevationChart) elements.rideDashboardElevationChart.innerHTML = emptyGradeState;
            return;
        }

        if (route.hasElevationData === false) {
            const noGradeState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效坡度图");
            const noElevationState = buildRouteChartEmptyStateSvg("当前 GPX 不包含海拔数据，无法生成有效距离-海拔图");
            if (elements.elevationChart) elements.elevationChart.innerHTML = noGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = noElevationState;
            if (elements.rideDashboardElevationChart) elements.rideDashboardElevationChart.innerHTML = noGradeState;
            return;
        }

        const gradeChartSvg = buildGradeChartSvg(route, currentRecord);
        const elevationProfileSvg = buildElevationProfileSvg(route, currentRecord);

        if (elements.elevationChart) {
            elements.elevationChart.innerHTML = gradeChartSvg;
        }
        if (elements.rideDashboardElevationChart) {
            elements.rideDashboardElevationChart.innerHTML = gradeChartSvg;
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

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
