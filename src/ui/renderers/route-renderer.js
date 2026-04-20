import { formatNumber } from "../../shared/format.js";

export function createRouteRenderer({
    elements,
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment
}) {
    let lastRenderedRouteSignature = "";

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
        mapController.syncRoute(state.route);
        renderElevationChart(state.route, null);
    }

    function renderElevationChart(route, currentRecord) {
        if (!elements.elevationChart && !elements.setupElevationChart && !elements.rideDashboardElevationChart) return;

        if (!route || !route.points || route.points.length === 0) {
            const emptyState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    导入路线后显示坡度图
                </text>
            `;
            if (elements.elevationChart) elements.elevationChart.innerHTML = emptyState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = emptyState;
            if (elements.rideDashboardElevationChart) elements.rideDashboardElevationChart.innerHTML = emptyState;
            return;
        }

        if (route.hasElevationData === false) {
            const noElevationState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    当前 GPX 不包含海拔数据，无法生成有效坡度图
                </text>
            `;
            if (elements.elevationChart) elements.elevationChart.innerHTML = noElevationState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = noElevationState;
            if (elements.rideDashboardElevationChart) elements.rideDashboardElevationChart.innerHTML = noElevationState;
            return;
        }

        const width = 640;
        const height = 180;
        const paddingBottom = 20;
        const paddingTop = 20;
        const innerHeight = height - paddingTop - paddingBottom;

        const totalDist = route.totalDistanceMeters;
        
        const maxGrade = Math.max(...route.points.map(p => p.gradePercent), 5);
        const minGrade = Math.min(...route.points.map(p => p.gradePercent), -5);
        
        const gradeRange = maxGrade - minGrade;
        const zeroY = paddingTop + innerHeight * (maxGrade / gradeRange);

        let svgContent = '';

        function getGradeColor(grade) {
            if (grade >= 10) return '#e11d48'; // 爬墙 (HC)
            if (grade >= 7) return '#f43f5e';  // 陡坡 (1级)
            if (grade >= 4) return '#f97316';  // 显著上坡 (2级)
            if (grade >= 2) return '#fbbf24';  // 缓坡 (3级)
            if (grade > -2) return '#2dd4bf';  // 平路或微坡
            return '#38bdf8';                  // 下坡
        }

        svgContent += `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" />`;

        for (let i = 1; i < route.points.length; i++) {
            const prevPoint = route.points[i - 1];
            const currentPoint = route.points[i];
            
            const prevX = (prevPoint.distanceMeters / totalDist) * width;
            const curX = (currentPoint.distanceMeters / totalDist) * width;
            
            const prevY = paddingTop + innerHeight * ((maxGrade - prevPoint.gradePercent) / gradeRange);
            const curY = paddingTop + innerHeight * ((maxGrade - currentPoint.gradePercent) / gradeRange);
            
            const color = getGradeColor(currentPoint.gradePercent);

            svgContent += `
                <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${curX},${curY} ${curX},${zeroY}" 
                         fill="${color}" opacity="0.8" />
            `;
            
            svgContent += `
                <line x1="${prevX}" y1="${prevY}" x2="${curX}" y2="${curY}" 
                      stroke="${color}" stroke-width="1.5" />
            `;
        }

        let fullSvgContent = svgContent;

        if (currentRecord) {
            const posX = (currentRecord.distanceKm * 1000 / totalDist) * width;
            fullSvgContent += `
                <!-- 已骑行区域遮罩 -->
                <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
                <!-- 骑行者标记 -->
                <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="2" stroke-dasharray="4 4" />
                <circle cx="${posX}" cy="${zeroY}" r="5" fill="white" stroke="var(--text)" stroke-width="2" />
            `;
        }

        if (elements.elevationChart) {
            elements.elevationChart.innerHTML = fullSvgContent;
        }
        if (elements.rideDashboardElevationChart) {
            elements.rideDashboardElevationChart.innerHTML = fullSvgContent;
        }
        if (elements.setupElevationChart) {
            elements.setupElevationChart.innerHTML = svgContent;
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
