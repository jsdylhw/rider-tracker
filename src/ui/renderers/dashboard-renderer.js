import { formatNumber } from "../../shared/format.js";
import { isStreetViewDebugEnabled } from "../../shared/debug-flags.js";
import { buildStreetViewTargetFromRoute } from "../map/street-view-controller.js";
import { buildDashboardViewModel } from "../../app/view-models/live-ride-view-model.js";
import { buildImmersiveElevationGradeSvg } from "./svg/route-charts.js";
import { createDashboardMetricsRenderer } from "./dashboard-metrics-renderer.js";
import { createGoogleMapsRideActions } from "./google-maps-ride-actions.js";
import { createRideVisualSyncController } from "./ride-visual-sync-controller.js";
import { createWorkoutRuntimeRenderer } from "./workout-runtime-renderer.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import {
    DEFAULT_METRIC_SELECTION,
    METRIC_LABELS,
    METRIC_OPTIONS,
    normalizeMetricSelection
} from "../../shared/live-metrics.js";

const LIVE_VISUAL_UPDATE_INTERVAL_MS = 1000;

export function createDashboardRenderer({
    elements,
    rideVisuals,
    // Kept as a compatibility seam for focused renderer tests and external embedders.
    mapController,
    streetViewControllerRef,
    onEnableStreetView,
    onQueueExplorationTurn = () => {},
    onRequestRouteElevation = async () => {},
    requestGoogleMapsApiKey = async () => "",
    streetViewDebugEnabled = isStreetViewDebugEnabled()
}) {
    const visuals = rideVisuals ?? {
        hasStreetView: () => streetViewControllerRef?.current != null,
        enableStreetView: onEnableStreetView,
        enableConfiguredStreetView: async () => ({ enabled: false, reason: "missing-config" }),
        getGoogleMapsConfig: () => null,
        syncMap(route, currentRecord) {
            mapController?.syncRide(route, currentRecord);
        },
        invalidateDashboardSize() {
            mapController?.invalidateDashboardSize?.();
        },
        syncStreetView(route, currentRecord) {
            const target = buildStreetViewTargetFromRoute(route, currentRecord);
            if (target) {
                streetViewControllerRef?.current?.update(target);
            }
        }
    };

    function isStreetViewLoaded() {
        return visuals.hasStreetView();
    }
    const dashboardMetricsRenderer = createDashboardMetricsRenderer({ elements });
    const workoutRuntimeRenderer = createWorkoutRuntimeRenderer({ elements });
    const rideVisualSyncController = createRideVisualSyncController({
        visuals,
        isStreetViewLoaded
    });
    const customMetricsState = normalizeMetricSelection(DEFAULT_METRIC_SELECTION);

    let alertStates = {
        halfway: false,
        last3k: false
    };
    let immersiveStreetViewMode = false;
    let immersiveUiHidden = false;
    let previousImmersiveStreetViewMode = false;
    let previousDashboardOpen = false;
    let boundStore = null;
    let dashboardMapRefreshScheduled = false;
    const visualRenderState = {
        gradeChart: createVisualRenderSlot(),
        workoutRuntime: createVisualRenderSlot()
    };
    const googleMapsRideActions = createGoogleMapsRideActions({
        elements,
        visuals,
        streetViewDebugEnabled,
        onRequestRouteElevation,
        requestGoogleMapsApiKey,
        onRefresh: () => {
            if (boundStore) render(boundStore.getState());
        },
        onEnterDebugFallback: (store) => enterImmersiveStreetView(store, "moving"),
        onStreetViewFailure: () => setImmersiveUiHidden(false)
    });

    function resetVisualRenderState() {
        Object.values(visualRenderState).forEach((slot) => {
            slot.lastRenderedAt = 0;
            slot.lastSignature = "";
        });
        rideVisualSyncController.reset();
    }

    function setImmersiveUiHidden(hidden) {
        immersiveUiHidden = hidden;
        elements.rideDashboard?.classList.toggle("immersive-ui-hidden", immersiveUiHidden);
        if (elements.immersiveUiToggleBtn) {
            elements.immersiveUiToggleBtn.textContent = immersiveUiHidden ? "显示 UI" : "隐藏 UI";
        }
    }

    function scheduleDashboardMapRefresh() {
        if (dashboardMapRefreshScheduled) {
            return;
        }
        dashboardMapRefreshScheduled = true;
        scheduleAfterLayout(() => {
            dashboardMapRefreshScheduled = false;
            visuals.invalidateDashboardSize?.();
        });
    }

    function exitImmersiveStreetView() {
        immersiveStreetViewMode = false;
        setImmersiveUiHidden(false);
        elements.rideDashboard?.classList.remove("immersive-street-view");
        document.body.classList.remove("immersive-street-view-active");
        scheduleAfterLayout(() => visuals.invalidateStreetViewSize?.());
        scheduleDashboardMapRefresh();
        syncImmersiveStreetViewButtons();
        if (elements.immersiveStreetViewBtn) {
            elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
        }

    }

    function hasStreetViewPresentation() {
        return googleMapsRideActions.hasStreetViewPresentation();
    }

    function enterImmersiveStreetView(store, mode) {
        // Debug fallback intentionally has no Google panorama. Do not try to
        // create or switch a controller there: it would dereference
        // window.google after the failed load and make both mode buttons fail.
        if (isStreetViewLoaded()) {
            visuals.setStreetViewMode?.(mode, {
                container1: elements.svPano1,
                container2: elements.svPano2
            });
        }
        immersiveStreetViewMode = true;
        resetVisualRenderState();
        if (elements.metricsCustomizer) {
            elements.metricsCustomizer.hidden = true;
        }
        elements.rideDashboard?.classList.toggle("immersive-street-view", true);
        syncImmersiveStreetViewButtons();
        render(store.getState());
        scheduleAfterLayout(() => visuals.invalidateStreetViewSize?.());
        // The mini map keeps its live-ride viewport unless the newly visible
        // immersive layout explicitly refits the current route.
        scheduleDashboardMapRefresh();
    }

    function showRideAlert(message) {
        let container = document.getElementById("rideAlertsContainer");
        if (!container) {
            container = document.createElement("div");
            container.id = "rideAlertsContainer";
            container.className = "ride-alerts";
            document.body.appendChild(container);
        }
        
        const alertEl = document.createElement("div");
        alertEl.className = "ride-alert-toast";
        alertEl.textContent = message;
        container.appendChild(alertEl);

        setTimeout(() => {
            alertEl.style.opacity = "0";
            alertEl.style.transform = "translateY(-40px)";
            alertEl.style.transition = "all 0.4s ease";
            setTimeout(() => alertEl.remove(), 400);
        }, 5000);
    }

    function bindEvents(store) {
        boundStore = store;
        if (elements.customizeMetricsBtn) {
            elements.customizeMetricsBtn.addEventListener("click", () => {
                if (elements.metricsCustomizer) {
                    elements.metricsCustomizer.hidden = !elements.metricsCustomizer.hidden;
                }
            });
        }

        googleMapsRideActions.bindEvents(store);
        [
            [elements.explorationTurnLeftBtn, "left"],
            [elements.explorationTurnStraightBtn, "straight"],
            [elements.explorationTurnRightBtn, "right"]
        ].forEach(([button, intent]) => {
            button?.addEventListener("click", () => onQueueExplorationTurn(intent));
        });

        [
            [elements.immersiveMovingStreetViewBtn, "moving"],
            [elements.immersiveStableStreetViewBtn, "stable"],
            [elements.immersiveStreetViewBtn, "moving"]
        ].forEach(([button, mode]) => {
            button?.addEventListener("click", () => {
                if (!hasStreetViewPresentation()) {
                    alert("请先点击“加载街景”并完成 Google Maps API Key 配置。");
                    return;
                }
                const liveRide = store?.getState?.().liveRide ?? {};
                if (!liveRide.isActive && !streetViewDebugEnabled) {
                    alert("请先开始骑行，或使用 ?debugStreetView=1 打开街景调试模式。");
                    return;
                }
                enterImmersiveStreetView(store, mode);
            });
        });

        if (elements.immersiveUiToggleBtn) {
            elements.immersiveUiToggleBtn.textContent = "隐藏 UI";
            elements.immersiveUiToggleBtn.addEventListener("click", () => {
                if (!immersiveStreetViewMode) return;
                setImmersiveUiHidden(!immersiveUiHidden);
            });
        }

        if (elements.immersiveBackBtn) {
            elements.immersiveBackBtn.addEventListener("click", () => {
                exitImmersiveStreetView();
            });
        }

        bindCustomMetricControls(store);
    }

    function bindCustomMetricControls(store) {
        renderSelectedMetrics();
        syncMetricAddOptions();

        elements.addMetricBtn?.addEventListener("click", () => {
            const key = elements.metricAddSelect?.value;
            if (!key || !Object.hasOwn(customMetricsState, key)) return;

            customMetricsState[key] = true;
            if (elements.metricAddSelect) {
                elements.metricAddSelect.value = "";
            }
            renderSelectedMetrics();
            syncMetricAddOptions();
            if (store) render(store.getState());
        });

        elements.metricAddSelect?.addEventListener("change", () => {
            if (elements.addMetricBtn) {
                elements.addMetricBtn.disabled = !elements.metricAddSelect.value;
            }
        });

        elements.selectedMetricsList?.addEventListener("click", (event) => {
            const removeButton = event.target.closest("[data-remove-metric]");
            if (!removeButton) return;

            const key = removeButton.dataset.removeMetric;
            if (!Object.hasOwn(customMetricsState, key)) return;

            customMetricsState[key] = false;
            renderSelectedMetrics();
            syncMetricAddOptions();
            if (store) render(store.getState());
        });
    }

    function renderSelectedMetrics() {
        if (!elements.selectedMetricsList) return;
        const enabledOptions = METRIC_OPTIONS.filter((option) => customMetricsState[option.key]);

        if (!enabledOptions.length) {
            elements.selectedMetricsList.innerHTML = `<p class="section-subtitle">还没有选择数据项，请从上方下拉菜单添加。</p>`;
            return;
        }

        elements.selectedMetricsList.innerHTML = enabledOptions
            .map((option) => `
                <span class="metric-chip-item">
                    <span class="metric-chip-group">${option.group}</span>
                    ${option.label}
                    <button type="button" class="metric-chip-remove" data-remove-metric="${option.key}" aria-label="移除${option.label}">×</button>
                </span>
            `)
            .join("");
    }

    function syncMetricAddOptions() {
        if (!elements.metricAddSelect) return;

        [...elements.metricAddSelect.options].forEach((option) => {
            if (!option.value) return;
            option.disabled = customMetricsState[option.value] === true;
            const metric = METRIC_LABELS[option.value];
            if (metric) {
                option.textContent = customMetricsState[option.value]
                    ? `${metric.label}（已添加）`
                    : metric.label;
            }
        });

        if (elements.addMetricBtn) {
            elements.addMetricBtn.disabled = !elements.metricAddSelect.value;
        }
    }

    function render(state) {
        if (!elements.rideDashboard) return;
        const now = Date.now();
        const viewModel = buildDashboardViewModel({
            state,
            customMetricsState,
            immersiveStreetViewMode,
            streetViewLoaded: hasStreetViewPresentation(),
            streetViewDebugEnabled
        });
        const { ride, training, metricsData, enabledMetricKeys } = viewModel;
        const { session, currentRecord, route, records, distanceKm } = ride;
        const isGradeSimulation = training.mode === WORKOUT_MODES.GRADE_SIM;
        const modeChanged = previousImmersiveStreetViewMode !== immersiveStreetViewMode;
        const dashboardOpenChanged = previousDashboardOpen !== ride.dashboardOpen;
        if (modeChanged) {
            resetVisualRenderState();
            previousImmersiveStreetViewMode = immersiveStreetViewMode;
        }
        if (dashboardOpenChanged) {
            resetVisualRenderState();
            previousDashboardOpen = ride.dashboardOpen;
        }

        elements.rideDashboard.hidden = !ride.dashboardOpen;
        if (ride.dashboardOpen) {
            document.body.classList.add('dashboard-open');
        } else {
            document.body.classList.remove('dashboard-open');
        }
        if (dashboardOpenChanged && ride.dashboardOpen) {
            scheduleDashboardMapRefresh();
        }
        
        if (elements.stopRideDashboardBtn) {
            elements.stopRideDashboardBtn.disabled = !ride.isActive;
        }
        if (elements.startRideDashboardBtn) {
            elements.startRideDashboardBtn.disabled = !ride.canStart || ride.isActive;
        }
        if (elements.deviceControlsPanel) {
            elements.deviceControlsPanel.style.display = ride.isActive ? "none" : "grid";
        }
        if (elements.rideDashboard) {
            elements.rideDashboard.classList.toggle("immersive-street-view", immersiveStreetViewMode);
            elements.rideDashboard.classList.toggle("immersive-ui-hidden", immersiveUiHidden);
        }
        renderRouteContext(route, currentRecord);
        renderExplorationTurnControls(route, ride);
        syncElevationChartCopy();
        document.body.classList.toggle("immersive-street-view-active", immersiveStreetViewMode && ride.dashboardOpen);
        if (elements.immersiveMovingStreetViewBtn || elements.immersiveStableStreetViewBtn || elements.immersiveStreetViewBtn) {
            const canShow = viewModel.canShowImmersiveStreetView;
            syncImmersiveStreetViewButtons(null, canShow);
            if (!canShow && immersiveStreetViewMode) {
                exitImmersiveStreetView();
            }
        }

        if (!ride.dashboardOpen) {
            return;
        }

        googleMapsRideActions.syncButtons({ route, ride });

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = "实时骑行界面";
            if (elements.rideDashboardSubtitle) {
                elements.rideDashboardSubtitle.textContent = streetViewDebugEnabled && hasStreetViewPresentation()
                    ? googleMapsRideActions.isDebugFallback()
                        ? "街景调试模式：Google 街景未加载，正在显示黑屏占位与完整骑行 UI。"
                        : "街景调试模式：未开始骑行时也可以进入沉浸街景预览。"
                    : "";
            }
            dashboardMetricsRenderer.render({
                metricsData,
                enabledMetricKeys,
                immersiveStreetViewMode,
                hasSession: false
            });

            const debugCurrentRecord = streetViewDebugEnabled
                ? buildDebugStreetViewRecord(route)
                : null;
            renderHeavyVisuals({
                session,
                route,
                currentRecord: debugCurrentRecord,
                records: debugCurrentRecord ? [debugCurrentRecord] : records,
                training,
                isGradeSimulation,
                now,
                force: modeChanged || dashboardOpenChanged
            });
            return;
        }

        const progressPercent = ride.progressPercent;
        const totalDistanceKm = ride.totalDistanceKm;
        const remainingKm = ride.remainingKm;

        if (ride.isActive && totalDistanceKm > 3) {
            if (progressPercent >= 50 && progressPercent < 55 && !alertStates.halfway) {
                showRideAlert("里程过半！你已经完成了 50% 的路线，继续保持！");
                alertStates.halfway = true;
            }
            if (remainingKm <= 3 && remainingKm > 0 && !alertStates.last3k) {
                showRideAlert("冲刺阶段！距离终点仅剩最后 3 km，加油！");
                alertStates.last3k = true;
            }
        }

        if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = route.name || "实时骑行界面";
        if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = ride.isActive
            ? "骑行界面已开启，正在按实时功率推进路线。"
            : "骑行已结束，可在这里回看本次路线进度和核心指标。";
        dashboardMetricsRenderer.render({
            metricsData,
            enabledMetricKeys,
            immersiveStreetViewMode,
            hasSession: true
        });

        renderHeavyVisuals({
            session,
            route,
            currentRecord,
            records,
            training,
            isGradeSimulation,
            now,
            force: modeChanged || dashboardOpenChanged
        });
    }

    function renderExplorationTurnControls(route, ride) {
        const isExplorationRide = route?.source === "osm-exploration" && ride.isActive;
        if (elements.explorationTurnControls) {
            elements.explorationTurnControls.hidden = !isExplorationRide;
        }
        if (!isExplorationRide) {
            return;
        }

        const pendingIntent = route.exploration?.pendingIntent ?? "straight";
        if (elements.explorationTurnStatus) {
            elements.explorationTurnStatus.textContent = pendingIntent === "left"
                ? "下一路口：左拐"
                : pendingIntent === "right"
                    ? "下一路口：右拐"
                    : "下一路口：默认直行";
        }
        [
            [elements.explorationTurnLeftBtn, "left"],
            [elements.explorationTurnStraightBtn, "straight"],
            [elements.explorationTurnRightBtn, "right"]
        ].forEach(([button, intent]) => {
            if (!button) return;
            button.classList.toggle("is-selected", pendingIntent === intent);
            button.setAttribute("aria-pressed", String(pendingIntent === intent));
        });
    }

    function renderRouteContext(route, currentRecord) {
        const routeName = route?.source === "osm-exploration"
            ? "OSM 自由探索"
            : route?.name ?? "--";
        const position = formatRoutePosition(route, currentRecord);
        if (elements.rideRouteContext) {
            elements.rideRouteContext.textContent = `当前路线：${routeName} · 当前位置：${position}`;
        }

        const hasMappableRoute = ["gpx", "osm-map", "osm-exploration"].includes(route?.source);
        const showRouteMiniMap = !immersiveStreetViewMode || hasMappableRoute;
        const hideRouteMiniMap = !showRouteMiniMap;
        if (elements.rideDashboardMap && Boolean(elements.rideDashboardMap.hidden) !== hideRouteMiniMap) {
            elements.rideDashboardMap.hidden = hideRouteMiniMap;
            if (showRouteMiniMap) {
                scheduleDashboardMapRefresh();
            }
        }
    }

    function syncImmersiveStreetViewButtons(store, canShowOverride = null) {
        const liveRide = store?.getState?.().liveRide ?? {};
        const canShow = canShowOverride ?? (hasStreetViewPresentation() && (liveRide.isActive || streetViewDebugEnabled));
        [elements.immersiveMovingStreetViewBtn, elements.immersiveStableStreetViewBtn]
            .filter(Boolean)
            .forEach((button) => { button.hidden = !canShow || immersiveStreetViewMode; });
        if (elements.immersiveStreetViewBtn) {
            elements.immersiveStreetViewBtn.hidden = !canShow;
            if (!immersiveStreetViewMode) elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
        }
    }

    function renderHeavyVisuals({
        session,
        route,
        currentRecord,
        records,
        training,
        isGradeSimulation,
        now,
        force = false
    }) {
        const routeSignature = buildRouteSignature(route);
        const distanceMeters = Math.round((currentRecord?.distanceKm ?? 0) * 1000);
        const positionSignature = `${routeSignature}:${distanceMeters}`;
        const workoutSignature = [
            records?.length ?? 0,
            training?.mode ?? "",
            training?.runtime?.customWorkoutTargetStepIndex ?? "",
            training?.runtime?.customWorkoutTargetPowerWatts ?? "",
            training?.runtime?.targetErgPowerWatts ?? "",
            Math.round((training?.runtime?.customWorkoutTargetProgress ?? 0) * 100)
        ].join(":");

        if (shouldRenderVisual(visualRenderState.gradeChart, positionSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force)) {
            renderImmersiveGradeChart(route, currentRecord, isGradeSimulation);
        }

        if (shouldRenderVisual(visualRenderState.workoutRuntime, workoutSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force)) {
            workoutRuntimeRenderer.render({ liveSession: session, training, records });
        }

        rideVisualSyncController.sync({
            route,
            currentRecord,
            immersive: immersiveStreetViewMode,
            now,
            force
        });
    }

    function renderImmersiveGradeChart(route, currentRecord, isGradeSimulation) {
        if (!elements.rideDashboardElevationChart || !immersiveStreetViewMode || !isGradeSimulation) {
            return;
        }

        elements.rideDashboardElevationChart.setAttribute("preserveAspectRatio", "xMidYMid meet");
        elements.rideDashboardElevationChart.innerHTML = buildImmersiveElevationGradeSvg(
            route,
            currentRecord,
            { transparent: true }
        );
    }

    function syncElevationChartCopy() {
        if (elements.rideElevationChartTitle) {
            elements.rideElevationChartTitle.textContent = immersiveStreetViewMode ? "海拔与附近坡度" : "路线海拔剖面";
        }
        if (elements.rideElevationChartSubtitle) {
            elements.rideElevationChartSubtitle.textContent = immersiveStreetViewMode
                ? "左侧显示距离-海拔，右侧显示当前位置附近坡度。"
                : "距离-海拔图（含当前骑行位置）。";
        }
        elements.rideDashboardElevationChart?.setAttribute(
            "preserveAspectRatio",
            "xMidYMid meet"
        );
    }

    return {
        bindEvents,
        render
    };
}

function formatRoutePosition(route, currentRecord) {
    const latitude = currentRecord?.positionLat;
    const longitude = currentRecord?.positionLong;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
    const target = buildStreetViewTargetFromRoute(route, currentRecord);
    return target
        ? `${target.latitude.toFixed(5)}, ${target.longitude.toFixed(5)}`
        : "--";
}

function createVisualRenderSlot() {
    return {
        lastRenderedAt: 0,
        lastSignature: ""
    };
}

function scheduleAfterLayout(callback) {
    if (typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(callback);
        return;
    }
    queueMicrotask(callback);
}

function shouldRenderVisual(slot, signature, now, intervalMs, force = false) {
    if (force || slot.lastRenderedAt === 0) {
        slot.lastRenderedAt = now;
        slot.lastSignature = signature;
        return true;
    }

    if (signature === slot.lastSignature) {
        return false;
    }

    if (now - slot.lastRenderedAt < intervalMs) {
        return false;
    }

    slot.lastRenderedAt = now;
    slot.lastSignature = signature;
    return true;
}

function buildRouteSignature(route) {
    if (!route) return "no-route";
    return [
        route.source ?? "unknown",
        route.name ?? "route",
        route.totalDistanceMeters ?? 0,
        route.points?.length ?? 0
    ].join(":");
}

function buildDebugStreetViewRecord(route) {
    const firstPoint = route?.points?.[0];
    if (!firstPoint) {
        return null;
    }

    const distanceMeters = Number.isFinite(firstPoint.distanceMeters) ? firstPoint.distanceMeters : 0;
    return {
        elapsedSeconds: 0,
        distanceKm: distanceMeters / 1000,
        routeProgress: route?.totalDistanceMeters > 0 ? distanceMeters / route.totalDistanceMeters : 0,
        latitude: firstPoint.latitude,
        longitude: firstPoint.longitude,
        elevationMeters: firstPoint.elevationMeters ?? 0,
        gradePercent: firstPoint.gradePercent ?? 0,
        speedKph: 0,
        power: 0,
        cadence: 0,
        heartRate: 0,
        segmentName: "街景调试起点"
    };
}
