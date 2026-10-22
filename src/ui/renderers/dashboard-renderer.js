import { buildRideHintSnapshot, buildRideHintRevision } from "../../domain/narration/ride-hint-snapshot.js";
import { isStreetViewDebugEnabled } from "../../shared/debug-flags.js";
import { buildStreetViewTargetFromRoute } from "../map/street-view-controller.js";
import { buildDashboardViewModel } from "../../app/view-models/live-ride-view-model.js";
import { buildImmersiveElevationGradeSvg } from "./svg/route-charts.js";
import { createDashboardMetricsRenderer } from "./dashboard-metrics-renderer.js";
import { createGoogleMapsRideActions } from "./google-maps-ride-actions.js";
import { createRideVisualSyncController } from "./ride-visual-sync-controller.js";
import { createWorkoutRuntimeRenderer } from "./workout-runtime-renderer.js";
import { resolveDeviceButtonLabel } from "./device-renderer.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { createDashboardMetricCustomizer } from "./dashboard/dashboard-metric-customizer.js";
import { createDashboardRoutePresentation } from "./dashboard/dashboard-route-presentation.js";
import { showRideAlert } from "./dashboard/ride-alert-presenter.js";
import { createRouteNarrationService } from "../../app/services/route-narration-service.js";
import { createRouteNarrationRenderer } from "./route-narration-renderer.js";
import { createRouteNarrationClient } from "../../adapters/narration/route-narration-client.js";

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
    onToggleHeartRate = () => {},
    onTogglePowerMeter = () => {},
    onToggleTrainer = () => {},
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
    let alertStates = {
        halfway: false,
        last3k: false
    };
    let immersiveStreetViewMode = false;
    let immersiveUiHidden = false;
    let previousImmersiveStreetViewMode = false;
    let previousDashboardOpen = false;
    let previousRideActive = false;
    let narrationRouteObject = null;
    let boundStore = null;
    let dashboardMapRefreshScheduled = false;
    let deviceStatusDialogOpen = false;
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
    const metricCustomizer = createDashboardMetricCustomizer({
        elements,
        onChange: () => {
            if (boundStore) render(boundStore.getState());
        }
    });
    const routePresentation = createDashboardRoutePresentation({
        elements,
        onMapShown: scheduleDashboardMapRefresh
    });
    const routeNarrationClient = createRouteNarrationClient();
    const routeNarrationService = createRouteNarrationService({
        refreshHint: (request, options) => routeNarrationClient.refreshHint(request, options),
        buildHintSnapshot: (options) => buildRideHintSnapshot(boundStore?.getState?.() ?? {}, options),
        onChange: () => renderNarrationState(),
        preparePlan: (route, options) => routeNarrationClient.prepare(route, {
            ...options,
            rideSettings: boundStore?.getState?.().settings
        })
    });
    const routeNarrationRenderer = createRouteNarrationRenderer({
        elements,
        onLoad: () => {
            const route = boundStore?.getState?.().route;
            if (!route) return;
            void routeNarrationService.load(route).then(renderNarrationState);
            renderNarrationState();
        },
        onClose: () => renderNarrationState(routeNarrationService.dismiss()),
        onPrevious: () => {
            routeNarrationRenderer.render(routeNarrationService.previous(), {
                visible: immersiveStreetViewMode
            });
        },
        onNext: () => {
            routeNarrationRenderer.render(routeNarrationService.next(), {
                visible: immersiveStreetViewMode
            });
        },
        onRetry: () => {
            const route = boundStore?.getState?.().route;
            if (!route) return;
            void routeNarrationService.retry(route).then(renderNarrationState);
            renderNarrationState();
        }
    });

    function renderNarrationState(state = routeNarrationService.getState()) {
        routeNarrationRenderer.render(state, { visible: immersiveStreetViewMode });
    }

    function resetVisualRenderState() {
        Object.values(visualRenderState).forEach((slot) => {
            slot.lastRenderedAt = 0;
            slot.lastSignature = "";
        });
        rideVisualSyncController.reset();
    }

    function setDeviceStatusDialogOpen(isOpen) {
        deviceStatusDialogOpen = isOpen === true;
        elements.rideDeviceStatusOverlay?.classList.toggle("open", deviceStatusDialogOpen);
        elements.rideDeviceStatusOverlay?.setAttribute("aria-hidden", String(!deviceStatusDialogOpen));
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
        narrationRouteObject = null;
        routeNarrationService.leave();
        renderNarrationState();
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

    function resetStreetViewPresentation() {
        exitImmersiveStreetView();
        googleMapsRideActions.resetStreetViewPresentation();
        visuals.resetStreetView?.();
        routeNarrationService.reset();
        routeNarrationRenderer.render(routeNarrationService.getState());
        resetVisualRenderState();
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
        narrationRouteObject = store.getState().route;
        routeNarrationService.enter(store.getState().route);
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

    function bindEvents(store) {
        boundStore = store;
        metricCustomizer.bindEvents();
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
                    alert("请先点击“加载街景”；如功能不可用，请检查 config.yaml 中的 Google API 配置。");
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

        elements.rideDeviceStatusBtn?.addEventListener("click", () => {
            setDeviceStatusDialogOpen(true);
        });
        elements.closeRideDeviceStatusBtn?.addEventListener("click", () => {
            setDeviceStatusDialogOpen(false);
        });
        elements.rideConnectHrBtn?.addEventListener("click", () => onToggleHeartRate());
        elements.rideConnectPowerBtn?.addEventListener("click", () => onTogglePowerMeter());
        elements.rideConnectTrainerBtn?.addEventListener("click", () => onToggleTrainer());

    }

    function render(state) {
        if (!elements.rideDashboard) return;
        const now = Date.now();
        const viewModel = buildDashboardViewModel({
            state,
            customMetricsState: metricCustomizer.selection,
            immersiveStreetViewMode,
            streetViewLoaded: hasStreetViewPresentation(),
            streetViewDebugEnabled
        });
        const { ride, training, metricsData, enabledMetricKeys } = viewModel;
        const { session, currentRecord, route, records, distanceKm } = ride;
        if (immersiveStreetViewMode && narrationRouteObject !== route) {
            narrationRouteObject = route;
            routeNarrationService.enter(route);
        }
        const narrationState = routeNarrationService.update({
            distanceMeters: (currentRecord?.distanceKm ?? 0) * 1000,
            elapsedSeconds: currentRecord?.elapsedSeconds ?? 0,
            rideContext: {
                active: ride.isActive && immersiveStreetViewMode && ride.dashboardOpen,
                sessionId: String(session?.startedAt ?? ""),
                revision: buildRideHintRevision(state, { active: ride.isActive && immersiveStreetViewMode && ride.dashboardOpen, now })
            }
        });
        routeNarrationRenderer.render(narrationState, {
            visible: immersiveStreetViewMode && ride.dashboardOpen,
            agentCapabilities: state.agentCapabilities
        });
        const isGradeSimulation = training.mode === WORKOUT_MODES.GRADE_SIM;
        const modeChanged = previousImmersiveStreetViewMode !== immersiveStreetViewMode;
        const dashboardOpenChanged = previousDashboardOpen !== ride.dashboardOpen;
        const rideActiveChanged = previousRideActive !== ride.isActive;
        if (modeChanged) {
            resetVisualRenderState();
            previousImmersiveStreetViewMode = immersiveStreetViewMode;
        }
        if (dashboardOpenChanged) {
            resetVisualRenderState();
            previousDashboardOpen = ride.dashboardOpen;
        }
        if (rideActiveChanged) {
            resetVisualRenderState();
            if (previousRideActive && !ride.isActive) {
                routeNarrationService.clear();
            }
            previousRideActive = ride.isActive;
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
        const showRideDeviceStatus = ride.isActive && !immersiveStreetViewMode;
        if (elements.rideDeviceStatusBtn) {
            elements.rideDeviceStatusBtn.hidden = !showRideDeviceStatus;
            elements.rideDeviceStatusBtn.textContent = state.ble.trainer?.isReconnecting
                ? "骑行台重连中"
                : state.ble.trainer?.reconnectEligible && !state.ble.trainer?.isConnected
                    ? "骑行台断开 · 重连"
                    : "设备连接状态";
        }
        if (!showRideDeviceStatus && deviceStatusDialogOpen) {
            setDeviceStatusDialogOpen(false);
        }
        renderRideDeviceStatusDialog(state);
        if (elements.startRideDashboardBtn) {
            elements.startRideDashboardBtn.disabled = !ride.canStart || ride.isActive;
        }
        if (elements.rideDashboard) {
            elements.rideDashboard.classList.toggle("immersive-street-view", immersiveStreetViewMode);
            elements.rideDashboard.classList.toggle("immersive-ui-hidden", immersiveUiHidden);
        }
        routePresentation.render({ route, currentRecord, ride, immersiveStreetViewMode });
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

        googleMapsRideActions.syncButtons({ route, ride, agentCapabilities: state.agentCapabilities });

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = "实时骑行界面";
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

    function renderRideDeviceStatusDialog(state) {
        const heartRate = state.ble?.heartRate ?? {};
        const powerMeter = state.ble?.powerMeter ?? {};
        const trainer = state.ble?.trainer ?? {};
        const bluetoothSupported = state.ble?.supported === true;

        renderConnectionButton(elements.rideConnectHrBtn, {
            label: "心率带",
            isConnected: heartRate.isConnected,
            isConnecting: heartRate.isConnecting,
            deviceName: heartRate.deviceName,
            bluetoothSupported
        });
        renderConnectionButton(elements.rideConnectPowerBtn, {
            label: "功率计",
            isConnected: powerMeter.externalConnected,
            isConnecting: powerMeter.externalConnecting,
            deviceName: powerMeter.externalDeviceName,
            bluetoothSupported
        });
        renderConnectionButton(elements.rideConnectTrainerBtn, {
            label: "骑行台",
            isConnected: trainer.isConnected,
            isConnecting: trainer.isConnecting,
            isReconnecting: trainer.isReconnecting,
            canReconnect: trainer.reconnectEligible === true,
            deviceName: trainer.deviceName,
            bluetoothSupported
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

    return {
        bindEvents,
        resetStreetViewPresentation,
        render
    };
}

function renderConnectionButton(button, {
    label,
    isConnected,
    isConnecting,
    isReconnecting = false,
    canReconnect = false,
    deviceName,
    bluetoothSupported
}) {
    if (!button) return;
    button.disabled = !bluetoothSupported || isConnecting === true;
    button.textContent = resolveDeviceButtonLabel({
        label,
        isConnected,
        isConnecting,
        isReconnecting,
        canReconnect,
        deviceName
    });
    button.title = isConnected
        ? `点击断开${label}`
        : !isConnecting && canReconnect ? `点击立即重连${label}` : "";
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
        heartRate: null,
        segmentName: "街景调试起点"
    };
}
