import { formatNumber } from "../../shared/format.js";

export function createRouteDetailsRenderer({
    elements,
    hasRouteModeControls,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onListSavedGpxRoutes,
    onLoadSavedGpxRoute,
    onContinueSavedGpxRoute,
    onDeleteSavedGpxRoute,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    getInputMode
}) {
    let lastRenderedState = null;
    let savedGpxRoutes = [];
    let savedRoutesLoading = false;

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
                await refreshSavedGpxRoutes();
            } finally {
                event.target.value = "";
            }
        });
        elements.refreshSavedGpxRoutesBtn?.addEventListener("click", () => {
            void refreshSavedGpxRoutes();
        });
        elements.loadSavedGpxRouteBtn?.addEventListener("click", async () => {
            const routeId = elements.savedGpxRouteSelect?.value;
            if (!routeId || isRouteEditingLocked() || isRouteLoading()) return;
            setSavedRouteStatus("正在加载已保存路线...");
            const route = await onLoadSavedGpxRoute?.(routeId);
            setSavedRouteStatus(route ? `已从起点加载：${route.name}` : "加载路线失败，请重试。");
        });
        elements.continueSavedGpxRouteBtn?.addEventListener("click", async () => {
            const routeId = elements.savedGpxRouteSelect?.value;
            if (!routeId || isRouteEditingLocked() || isRouteLoading()) return;
            setSavedRouteStatus("正在从上次位置继续路线...");
            const route = await onContinueSavedGpxRoute?.(routeId);
            setSavedRouteStatus(route ? `已从上次位置继续：${route.name}` : "继续路线失败，请重试。");
        });
        elements.deleteSavedGpxRouteBtn?.addEventListener("click", async () => {
            const routeId = elements.savedGpxRouteSelect?.value;
            if (!routeId || isRouteEditingLocked()) return;
            const route = savedGpxRoutes.find((item) => item.id === routeId);
            if (typeof window !== "undefined" && !window.confirm(`删除已保存路线“${route?.name ?? ""}”？不会删除历史活动。`)) return;
            try {
                await onDeleteSavedGpxRoute?.(routeId);
                setSavedRouteStatus("已删除保存的路线。");
                await refreshSavedGpxRoutes();
            } catch (error) {
                setSavedRouteStatus(`删除失败：${error?.message ?? "请重试。"}`);
            }
        });
        elements.savedGpxRouteSelect?.addEventListener("change", renderSavedGpxRouteControls);
        void refreshSavedGpxRoutes();
    }

    function render(state) {
        lastRenderedState = state;
        renderRouteTable(state);
        renderRouteSummary(state);
        renderSavedGpxRouteControls();
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
        const hasUsableRoute = Number.isFinite(route.totalDistanceMeters) && route.totalDistanceMeters > 0;
        const isPendingMapExploration = inputMode === "map" && !isExploration;
        const isPendingGpxImport = inputMode === "gpx" && !isGpx;

        if (elements.routeSourceLabel) {
            elements.routeSourceLabel.textContent = isRouteLoading
                ? "路线处理中"
                : isPendingMapExploration
                    ? "地图探索（待生成）"
                    : isPendingGpxImport
                        ? "GPX（待导入）"
                        : isExploration
                            ? "OSM 街景探索"
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
        if (isPendingGpxImport) {
            elements.routeSummary.innerHTML = "<strong>GPX 导入</strong><br>选择 GPX 文件后显示路线距离、海拔和坡度图。";
            return;
        }
        if (!hasUsableRoute) {
            elements.routeSummary.innerHTML = "<strong>尚未设置路线</strong><br>可新增自定义路段、导入 GPX，或在地图上生成探索路线；设置完成后才能开始骑行。";
            return;
        }

        const sourceText = isExploration ? "OSM 地图探索" : isGpx ? "GPX 导入" : "手工输入";
        const segmentsText = isGpx ? "" : `，共 ${route.segments.length} 段`;
        const elevationWarning = route.hasElevationData === false
            ? `<br><span style="color: var(--danger);">提示：当前${isExploration ? "探索路线" : "GPX"}尚无海拔数据，坡度按 0 处理。${isExploration ? "可在骑行界面主动请求海拔。" : ""}</span>`
            : "";
        elements.routeSummary.innerHTML = `
            <strong>路线概览</strong><br>
            来源：${sourceText}${segmentsText}，累计距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km，
            累计爬升 ${Math.round(route.totalElevationGainMeters)} m，
            累计下降 ${Math.round(route.totalDescentMeters)} m。${elevationWarning}
        `;
    }

    function isRouteEditingLocked() {
        return lastRenderedState?.liveRide?.isActive === true;
    }

    function isRouteLoading() {
        return lastRenderedState?.route?.isLoading === true;
    }

    async function refreshSavedGpxRoutes() {
        if (!onListSavedGpxRoutes || savedRoutesLoading) return;
        savedRoutesLoading = true;
        renderSavedGpxRouteControls();
        try {
            savedGpxRoutes = await onListSavedGpxRoutes();
            if (!savedGpxRoutes.length) setSavedRouteStatus("还没有已保存的 GPX 路线。");
        } catch (error) {
            savedGpxRoutes = [];
            setSavedRouteStatus(`读取路线库失败：${error?.message ?? "请重试。"}`);
        } finally {
            savedRoutesLoading = false;
            renderSavedGpxRouteControls();
        }
    }

    function renderSavedGpxRouteControls() {
        const select = elements.savedGpxRouteSelect;
        if (!select) return;
        const previousValue = select.value;
        const routeEditingLocked = isRouteEditingLocked();
        const routeLoading = isRouteLoading();
        const hasRoutes = savedGpxRoutes.length > 0;
        if (savedRoutesLoading) {
            select.innerHTML = '<option value="">正在读取我的路线...</option>';
        } else if (!hasRoutes) {
            select.innerHTML = '<option value="">暂无已保存路线</option>';
        } else {
            select.innerHTML = savedGpxRoutes.map((route) => (
                `<option value="${escapeHtml(route.id)}">${escapeHtml(formatSavedRouteLabel(route))}</option>`
            )).join("");
            if (savedGpxRoutes.some((route) => route.id === previousValue)) select.value = previousValue;
        }
        select.disabled = savedRoutesLoading || !hasRoutes || routeEditingLocked || routeLoading;
        if (elements.refreshSavedGpxRoutesBtn) elements.refreshSavedGpxRoutesBtn.disabled = savedRoutesLoading || routeEditingLocked;
        if (elements.loadSavedGpxRouteBtn) elements.loadSavedGpxRouteBtn.disabled = !hasRoutes || routeEditingLocked || routeLoading;
        const selectedRoute = savedGpxRoutes.find((route) => route.id === select.value) ?? savedGpxRoutes[0] ?? null;
        const hasResumePosition = hasRouteResumePosition(selectedRoute);
        if (elements.continueSavedGpxRouteBtn) {
            elements.continueSavedGpxRouteBtn.hidden = !hasResumePosition;
            elements.continueSavedGpxRouteBtn.disabled = !hasResumePosition || routeEditingLocked || routeLoading;
            elements.continueSavedGpxRouteBtn.textContent = hasResumePosition
                ? `继续 ${formatNumber(selectedRoute.resumeDistanceMeters / 1000, 2)} km`
                : "继续上次";
        }
        if (elements.deleteSavedGpxRouteBtn) elements.deleteSavedGpxRouteBtn.disabled = !hasRoutes || routeEditingLocked || routeLoading;
    }

    function setSavedRouteStatus(message) {
        if (elements.savedGpxRouteStatus) elements.savedGpxRouteStatus.textContent = message;
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

function formatSavedRouteLabel(route) {
    const distanceKm = Number(route?.totalDistanceMeters ?? 0) / 1000;
    const resumeDistanceMeters = Number(route?.resumeDistanceMeters) || 0;
    const resumeText = hasRouteResumePosition(route)
        ? ` · 上次停在 ${formatNumber(resumeDistanceMeters / 1000, 2)} km`
        : "";
    return `${route?.name ?? "GPX 路线"} · ${formatNumber(distanceKm, 2)} km${resumeText}`;
}

function hasRouteResumePosition(route) {
    const resumeDistanceMeters = Number(route?.resumeDistanceMeters) || 0;
    const totalDistanceMeters = Number(route?.totalDistanceMeters) || 0;
    return resumeDistanceMeters > 0 && resumeDistanceMeters < totalDistanceMeters - 10;
}
