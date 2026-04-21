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
            const emptyGradeState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    导入路线后显示坡度图
                </text>
            `;
            const emptyElevationState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    导入路线后显示距离-海拔图
                </text>
            `;
            if (elements.elevationChart) elements.elevationChart.innerHTML = emptyGradeState;
            if (elements.setupElevationChart) elements.setupElevationChart.innerHTML = emptyElevationState;
            if (elements.rideDashboardElevationChart) elements.rideDashboardElevationChart.innerHTML = emptyGradeState;
            return;
        }

        if (route.hasElevationData === false) {
            const noGradeState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    当前 GPX 不包含海拔数据，无法生成有效坡度图
                </text>
            `;
            const noElevationState = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    当前 GPX 不包含海拔数据，无法生成有效距离-海拔图
                </text>
            `;
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

function buildGradeChartSvg(route, currentRecord) {
    const width = 640;
    const height = 180;
    const paddingBottom = 20;
    const paddingTop = 20;
    const innerHeight = height - paddingTop - paddingBottom;
    const totalDist = Math.max(route.totalDistanceMeters, 1);
    const grades = route.points.map((point) => point.gradePercent ?? 0);
    const maxGrade = Math.max(...grades, 5);
    const minGrade = Math.min(...grades, -5);
    const gradeRange = Math.max(maxGrade - minGrade, 1);
    const zeroY = paddingTop + innerHeight * (maxGrade / gradeRange);
    let svgContent = `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" />`;

    for (let index = 1; index < route.points.length; index += 1) {
        const prevPoint = route.points[index - 1];
        const currentPoint = route.points[index];
        const prevX = (prevPoint.distanceMeters / totalDist) * width;
        const currentX = (currentPoint.distanceMeters / totalDist) * width;
        const prevY = paddingTop + innerHeight * ((maxGrade - (prevPoint.gradePercent ?? 0)) / gradeRange);
        const currentY = paddingTop + innerHeight * ((maxGrade - (currentPoint.gradePercent ?? 0)) / gradeRange);
        const color = getGradeColor(currentPoint.gradePercent ?? 0);

        svgContent += `
            <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${currentX},${currentY} ${currentX},${zeroY}"
                     fill="${color}" opacity="0.8" />
            <line x1="${prevX}" y1="${prevY}" x2="${currentX}" y2="${currentY}"
                  stroke="${color}" stroke-width="1.5" />
        `;
    }

    if (!currentRecord) {
        return svgContent;
    }

    const posX = ((currentRecord.distanceKm * 1000) / totalDist) * width;
    return `${svgContent}
        <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
        <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="2" stroke-dasharray="4 4" />
        <circle cx="${posX}" cy="${zeroY}" r="5" fill="white" stroke="var(--text)" stroke-width="2" />
    `;
}

function buildElevationProfileSvg(route, currentRecord) {
    const width = 640;
    const height = 180;
    const paddingLeft = 40;
    const paddingRight = 12;
    const paddingTop = 16;
    const paddingBottom = 28;
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;
    const totalDist = Math.max(route.totalDistanceMeters, 1);
    const elevations = route.points.map((point) => point.elevationMeters ?? 0);
    const minElevation = Math.min(...elevations);
    const maxElevation = Math.max(...elevations);
    const elevationRange = Math.max(maxElevation - minElevation, 10);
    const baseY = height - paddingBottom;
    const toX = (distanceMeters) => paddingLeft + (distanceMeters / totalDist) * innerWidth;
    const toY = (elevationMeters) => paddingTop + (1 - ((elevationMeters - minElevation) / elevationRange)) * innerHeight;
    const polyline = route.points
        .map((point) => `${toX(point.distanceMeters).toFixed(1)},${toY(point.elevationMeters ?? 0).toFixed(1)}`)
        .join(" ");
    const areaPath = `M ${toX(route.points[0].distanceMeters).toFixed(1)} ${baseY} L ${polyline.replaceAll(" ", " L ")} L ${toX(route.points.at(-1).distanceMeters).toFixed(1)} ${baseY} Z`;
    const distanceKm = totalDist / 1000;
    let markerSvg = "";

    if (currentRecord) {
        const currentDistanceMeters = currentRecord.distanceKm * 1000;
        const currentPoint = route.points.find((point) => point.distanceMeters >= currentDistanceMeters) ?? route.points.at(-1);
        const currentX = toX(Math.min(currentDistanceMeters, totalDist));
        const currentY = toY(currentPoint.elevationMeters ?? 0);
        markerSvg = `
            <line x1="${currentX.toFixed(1)}" y1="${paddingTop}" x2="${currentX.toFixed(1)}" y2="${baseY}" stroke="#f8fafc" stroke-width="1.5" stroke-dasharray="4 4" />
            <circle cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="4.5" fill="#f8fafc" stroke="#2563eb" stroke-width="2" />
        `;
    }

    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
        <line x1="${paddingLeft}" y1="${baseY}" x2="${width - paddingRight}" y2="${baseY}" stroke="#475569" stroke-width="1" />
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${baseY}" stroke="#475569" stroke-width="1" />
        <path d="${areaPath}" fill="rgba(56, 189, 248, 0.18)"></path>
        <polyline points="${polyline}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${markerSvg}
        <text x="${paddingLeft}" y="${height - 8}" fill="#94a3b8" font-size="12">0 km</text>
        <text x="${width - paddingRight}" y="${height - 8}" text-anchor="end" fill="#94a3b8" font-size="12">${formatNumber(distanceKm, 1)} km</text>
        <text x="${paddingLeft - 6}" y="${paddingTop + 4}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(maxElevation)} m</text>
        <text x="${paddingLeft - 6}" y="${baseY}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(minElevation)} m</text>
        <text x="${paddingLeft}" y="${paddingTop - 2}" fill="#cbd5e1" font-size="12">距离 - 海拔</text>
    `;
}

function getGradeColor(grade) {
    if (grade >= 10) return "#e11d48";
    if (grade >= 7) return "#f43f5e";
    if (grade >= 4) return "#f97316";
    if (grade >= 2) return "#fbbf24";
    if (grade > -2) return "#2dd4bf";
    return "#38bdf8";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
