import { formatNumber } from "../../shared/format.js";

export function createRouteDetailsRenderer({
    elements,
    hasRouteModeControls,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    getInputMode
}) {
    let lastRenderedState = null;

    function bindEvents() {
        elements.addSegmentBtn?.addEventListener("click", () => {
            if (!isRouteEditingLocked() && !isRouteLoading()) onAddSegment();
        });
        elements.resetRouteBtn?.addEventListener("click", () => {
            if (!isRouteEditingLocked() && !isRouteLoading()) onResetRoute();
        });
        elements.gpxFileInput?.addEventListener("click", (event) => {
            event.target.value = "";
        });
        elements.gpxFileInput?.addEventListener("change", async (event) => {
            const [file] = event.target.files ?? [];
            if (!file || isRouteEditingLocked() || isRouteLoading()) return;
            try {
                await onImportGpx(file);
            } finally {
                event.target.value = "";
            }
        });
    }

    function render(state) {
        lastRenderedState = state;
        renderRouteTable(state);
        renderRouteSummary(state);
    }

    function renderRouteTable(state) {
        const route = state.route;
        const isGpx = route.source === "gpx";
        const routeEditingLocked = state.liveRide?.isActive === true;
        const isEditable = !hasRouteModeControls
            ? !isGpx
            : getInputMode() === "manual" && route.source === "manual";

        if (elements.routeTableShell) {
            elements.routeTableShell.hidden = !isEditable;
        }
        if (!isEditable || !elements.routeTableBody) return;

        const segments = route.segments ?? [];
        elements.routeTableBody.innerHTML = segments.map((segment) => `
            <tr data-segment-id="${segment.id}">
                <td>
                    <input data-field="name" value="${escapeHtml(segment.name)}" ${routeEditingLocked ? "disabled" : ""}>
                </td>
                <td>
                    <input data-field="distanceKm" type="number" min="0.1" max="200" step="0.1" value="${segment.distanceKm}" ${routeEditingLocked ? "disabled" : ""}>
                </td>
                <td>
                    <input data-field="gradePercent" type="number" min="-15" max="20" step="0.1" value="${segment.gradePercent}" ${routeEditingLocked ? "disabled" : ""}>
                </td>
                <td class="action-cell">
                    <button class="remove-segment-btn" data-remove-segment="${segment.id}" ${segments.length === 1 || routeEditingLocked ? "disabled" : ""}>×</button>
                </td>
            </tr>
        `).join("");

        [...elements.routeTableBody.querySelectorAll("input[data-field]")].forEach((input) => {
            input.addEventListener("change", (event) => {
                const row = event.target.closest("tr");
                if (!isRouteEditingLocked()) {
                    onUpdateRouteSegment(row.dataset.segmentId, event.target.dataset.field, event.target.value);
                }
            });
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.target.blur?.();
                }
            });
        });
        [...elements.routeTableBody.querySelectorAll("[data-remove-segment]")].forEach((button) => {
            button.addEventListener("click", () => {
                if (!isRouteEditingLocked()) onRemoveRouteSegment(button.dataset.removeSegment);
            });
        });
    }

    function renderRouteSummary(state) {
        const route = state.route;
        const inputMode = getInputMode();
        const isRouteLoading = route?.isLoading === true;
        const isGpx = route.source === "gpx";
        const isExploration = route.source === "osm-exploration";
        const isMapDrawn = route.source === "map-drawn";
        const isAgentPlanned = route.source === "agent-planned";
        const isAgentDraft = isAgentPlanned && route.isDraft === true;
        const hasUsableRoute = Number.isFinite(route.totalDistanceMeters) && route.totalDistanceMeters > 0;
        const isPendingMapExploration = inputMode === "map" && !isExploration;
        const isPendingMapDrawing = inputMode === "draw" && !isMapDrawn;
        const isPendingAgentRoute = inputMode === "ai" && !isAgentPlanned;
        const isPendingGpxImport = inputMode === "gpx" && !isGpx;

        if (elements.routeSourceLabel) {
            elements.routeSourceLabel.textContent = isRouteLoading
                ? "路线处理中"
                : isPendingMapExploration
                    ? "地图探索（待生成）"
                    : isPendingAgentRoute
                        ? "AI 路线（等待预览）"
                    : isPendingMapDrawing
                        ? "地图选择路线（待生成）"
                    : isPendingGpxImport
                        ? "GPX（待导入）"
                        : isExploration
                            ? "OSM 街景探索"
                            : isAgentPlanned
                                ? `AI 路线：${route.name}`
                            : isMapDrawn
                                ? "Google 地图选择路线"
                            : isGpx
                                ? `GPX：${route.name}`
                                : "手工路线";
        }

        const routeEditingLocked = state.liveRide?.isActive === true;
        if (elements.addSegmentBtn) elements.addSegmentBtn.disabled = inputMode !== "manual" || isGpx || routeEditingLocked || isRouteLoading;
        if (elements.resetRouteBtn) elements.resetRouteBtn.disabled = routeEditingLocked || isRouteLoading;
        if (elements.gpxFileInput) elements.gpxFileInput.disabled = routeEditingLocked || isRouteLoading;
        if (elements.routeDistanceChip) elements.routeDistanceChip.textContent = `${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.routeElevationChip) elements.routeElevationChip.textContent = `${Math.round(route.totalElevationGainMeters)} m`;
        if (!elements.routeSummary) return;

        if (isRouteLoading) {
            elements.routeSummary.innerHTML = "<strong>路线处理中</strong><br>正在完成路线导入、路网规划或海拔请求；完成前不能开始骑行。";
            return;
        }
        if (isPendingMapExploration) {
            elements.routeSummary.innerHTML = "<strong>地图探索</strong><br>请在地图上选择起点和起步目标。系统会请求周边 OSM 路网，生成初始探索路线。";
            return;
        }
        if (isPendingAgentRoute) {
            elements.routeSummary.innerHTML = "<strong>AI 路线</strong><br>在上方对话区描述路线需求，再从候选中选择一条；路线会显示在下方的统一地图中。";
            return;
        }
        if (isPendingMapDrawing) {
            elements.routeSummary.innerHTML = "<strong>地图选择路线</strong><br>在 OSM 地图上依次点击起点、途经点和终点。系统会调用 Google Routes API 生成实际可骑行道路路线，再自动请求 Google 海拔。";
            return;
        }
        if (isPendingGpxImport) {
            elements.routeSummary.innerHTML = "<strong>GPX 导入</strong><br>选择 GPX 文件后显示路线距离、海拔和坡度图。";
            return;
        }
        if (!hasUsableRoute) {
            elements.routeSummary.innerHTML = "<strong>尚未设置路线</strong><br>可新增自定义路段、导入 GPX，或在地图上生成探索路线；设置完成后才能开始骑行。";
            return;
        }

        const usedDrivingFallback = isMapDrawn && route.travelMode === "DRIVE";
        const sourceText = isAgentPlanned ? "Personal FIT Agent 虚拟路线" : isExploration ? "OSM 地图探索" : isMapDrawn ? usedDrivingFallback ? "Google 道路路线（驾车回退）" : "Google 骑行路线" : isGpx ? "GPX 导入" : "手工输入";
        const segmentsText = isGpx ? "" : `，共 ${route.segments.length} 段`;
        const elevationWarning = route.hasElevationData === false && !isAgentPlanned
            ? `<br><span style="color: var(--danger);">提示：当前${isExploration ? "探索路线" : isMapDrawn ? "骑行路线" : "GPX"}尚无海拔数据，坡度按 0 处理。${isExploration ? "可在骑行界面主动请求海拔。" : isMapDrawn ? "可在地图选择路线中请求海拔。" : ""}</span>`
            : "";
        const bicycleRouteWarning = usedDrivingFallback
            ? "<br><span style=\"color: var(--danger);\">提示：当前区域没有可用的 Google 骑行路线，已按避开高速的普通道路生成；请确认自行车实际通行条件。</span>"
            : isMapDrawn
            ? "<br><span class=\"muted\">提示：Google 自行车路线仍可能缺少部分自行车道或通行限制信息，请结合当地实际道路判断。</span>"
            : "";
        const prototypeWarning = isAgentDraft
            ? "<br><span style=\"color: var(--danger);\">当前仍是路线草稿；请点击“最终确认”后再开始骑行。</span>"
            : isAgentPlanned
            ? "<br><span class=\"muted\">AI 虚拟路线已确认，不包含海拔，坡度按 0 处理；建议配合 ERG 模式骑行。</span>"
            : "";
        elements.routeSummary.innerHTML = `
            <strong>路线概览</strong><br>
            来源：${sourceText}${segmentsText}，累计距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km，
            累计爬升 ${Math.round(route.totalElevationGainMeters)} m，
            累计下降 ${Math.round(route.totalDescentMeters)} m。${elevationWarning}${bicycleRouteWarning}${prototypeWarning}
        `;
    }

    function isRouteEditingLocked() {
        return lastRenderedState?.liveRide?.isActive === true;
    }

    function isRouteLoading() {
        return lastRenderedState?.route?.isLoading === true;
    }

    return { bindEvents, render };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
