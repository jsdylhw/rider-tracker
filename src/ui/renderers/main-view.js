import { createRideVisualsController } from "../map/ride-visuals-controller.js";
import { createRouteRenderer } from "./route-renderer.js";
import { createDashboardRenderer } from "./dashboard-renderer.js";
import { createDeviceRenderer } from "./device-renderer.js";
import { createLayoutCoordinator } from "./layout-coordinator.js";
import { createWorkoutRenderer } from "./workout-renderer.js";
import { createCustomWorkoutTargetRenderer } from "./custom-workout-target-renderer.js";
import { createActivityHistoryRenderer } from "./activity-history-renderer.js";
import { createSessionSummaryRenderer } from "./session-summary-renderer.js";
import { createSessionChartRenderer } from "./session-chart-renderer.js";
import { createHomeView } from "../views/home-view.js";
import { createLiveView } from "../views/live-view.js";
import { createGoogleMapsServiceModal } from "../views/google-maps-service-modal.js";
import { createExportView } from "../views/export-view.js";
import { createActivityDetailView } from "../views/activity-detail-view.js";
import { buildActivityDetailPageHtml } from "./activity-detail-renderer.js";
import { buildRouteGeometryKey, collectRouteMapLatLngs } from "../map/map-controller.js";

export function createMainView({ store, pipController, actions }) {
    const { navigation, workout, route, ride, device, export: exportActions, googleMaps, pip } = actions;
    const homeView = createHomeView({
        onSetUiMode: navigation.setUiMode,
        onEnterLiveMode: navigation.enterLiveMode,
        onUpdateSettings: actions.user.updateSettings
    });
    const liveView = createLiveView({
        onCloseRideDashboard: ride.closeRideDashboard,
        onStartRide: ride.startRide,
        onStopRide: ride.stopRide,
        onUpdateRideInput: ride.updateRideInput
    });
    const exportView = createExportView({
        onImportFit: exportActions.importFit
    });
    const activityDetailView = createActivityDetailView({
        onSetUiMode: navigation.setUiMode,
        onConnectStrava: exportActions.connectStrava,
        onUploadActivityFit: exportActions.uploadActivityFit,
        onDownloadActivitySession: exportActions.downloadActivitySession,
        onDownloadActivityFit: exportActions.downloadActivityFit,
        onUpdateExportMetadata: exportActions.updateExportMetadata,
        getExportMetadata: () => store.getState().exportMetadata
    });
    const elements = {
        ...homeView.elements,
        ...liveView.elements,
        ...exportView.elements,
        ...activityDetailView.elements,
        pipBtn: document.getElementById("pipBtn")
    };

    // These are view-local render caches, not application state.
    let lastRenderedSettingsSignature = "";
    let lastRenderedActivityDetailSignature = "";

    const layoutCoordinator = createLayoutCoordinator({ elements });
    const rideVisuals = createRideVisualsController({ elements, googleMapsConfig: googleMaps });
    const routeRenderer = createRouteRenderer({
        elements,
        rideVisuals,
        onAddSegment: route.addSegment,
        onResetRoute: route.resetRoute,
        onImportGpx: route.importGpx,
        onListSavedGpxRoutes: route.listSavedGpxRoutes,
        onLoadSavedGpxRoute: route.loadSavedGpxRoute,
        onContinueSavedGpxRoute: route.continueSavedGpxRoute,
        onDeleteSavedGpxRoute: route.deleteSavedGpxRoute,
        onInvalidateMapRoute: route.invalidatePendingMapRoute,
        onPlanMapRoute: route.planMapRoute,
        onUpdateRouteSegment: route.updateSegment,
        onRemoveRouteSegment: route.removeSegment
    });
    const googleMapsServiceModal = createGoogleMapsServiceModal({ elements, googleMapsConfig: googleMaps });
    const dashboardRenderer = createDashboardRenderer({
        elements,
        rideVisuals,
        onQueueExplorationTurn: route.queueExplorationTurn,
        onRequestRouteElevation: route.requestCurrentRouteElevation,
        requestGoogleMapsApiKey: googleMapsServiceModal.requestApiKey,
        onToggleHeartRate: device.toggleHeartRate,
        onTogglePowerMeter: device.togglePowerMeter,
        onToggleTrainer: device.toggleTrainer
    });
    dashboardRenderer.bindEvents(store);
    bindPipMetricControls();
    const deviceRenderer = createDeviceRenderer({
        elements,
        onToggleHeartRate: device.toggleHeartRate,
        onTogglePowerMeter: device.togglePowerMeter,
        onToggleTrainer: device.toggleTrainer,
        onOpenRideDashboard: ride.openRideDashboard,
        onStartRide: ride.startRide,
        onStopRide: ride.stopRide
    });
    const workoutRenderer = createWorkoutRenderer({
        elements,
        onUpdateWorkoutMode: workout.updateMode,
        onUpdateGradeSimulationConfig: workout.updateGradeSimulationConfig,
        onUpdateErgTargetPower: workout.updateErgTargetPower,
        onUpdateErgConfirmationMode: workout.updateErgConfirmationMode,
        onUpdateResistanceLevel: workout.updateResistanceLevel
    });
    const customWorkoutTargetRenderer = createCustomWorkoutTargetRenderer({
        elements,
        onUpdateCustomWorkoutTargetEnabled: workout.updateCustomTargetEnabled,
        onAddCustomWorkoutTargetStep: workout.addCustomTargetStep,
        onEditCustomWorkoutTarget: workout.editCustomTarget,
        onApplyCustomWorkoutTargetPreset: workout.applyCustomTargetPreset,
        onUpdateCustomWorkoutTargetStep: workout.updateCustomTargetStep,
        onRemoveCustomWorkoutTargetStep: workout.removeCustomTargetStep
    });
    const sessionSummaryRenderer = createSessionSummaryRenderer({ elements });
    const sessionChartRenderer = createSessionChartRenderer({ elements, routeRenderer });
    const activityHistoryRenderer = createActivityHistoryRenderer({
        containers: [elements.historyContainer, elements.postRideHistoryContainer],
        onStatus: (statusText) => store.setState((state) => ({ ...state, statusText })),
        onSummary: (summary) => homeView.renderActivitySummary(summary),
        onOpenActivityDetail: navigation.openActivityDetail
    });
    void activityHistoryRenderer.refresh();

    store.subscribe((state, previousState) => {
        const initialRender = previousState === undefined;
        const rideEnded = !initialRender
            && previousState.liveRide?.isActive === true
            && state.liveRide?.isActive !== true;
        const routeChangedWhileIdle = !initialRender
            && state.route !== previousState.route
            && hasRouteGeometryChanged(previousState.route, state.route)
            && state.liveRide?.isActive !== true;
        if (rideEnded || routeChangedWhileIdle) {
            dashboardRenderer.resetStreetViewPresentation();
        }
        if (initialRender || state.uiMode !== previousState.uiMode) {
            layoutCoordinator.render(state);
        }
        if (initialRender || state.settings !== previousState.settings) renderSettings(state);
        if (initialRender || state.route !== previousState.route || state.uiMode !== previousState.uiMode) {
            routeRenderer.render(state);
        }
        if (initialRender || state.workout !== previousState.workout || state.ble !== previousState.ble) {
            workoutRenderer.render(state);
            customWorkoutTargetRenderer.render(state);
        }
        if (initialRender || state.ble !== previousState.ble || state.liveRide !== previousState.liveRide || state.rideInput !== previousState.rideInput || state.workout !== previousState.workout) {
            deviceRenderer.render(state);
        }
        if (initialRender || state.liveRide !== previousState.liveRide || state.session !== previousState.session || state.settings !== previousState.settings || state.statusText !== previousState.statusText || state.route !== previousState.route || state.workout !== previousState.workout) {
            sessionSummaryRenderer.render(state);
            sessionChartRenderer.render(state);
        }
        if (shouldRenderDashboard(state, previousState)) {
            dashboardRenderer.render(state);
        }
        if (initialRender || state.selectedActivity !== previousState.selectedActivity) renderActivityDetail(state);
        if (!initialRender && state.uiMode === "activity-detail" && state.uiMode !== previousState.uiMode) {
            activityDetailView.invalidateMapSize();
        }
        if (initialRender || state.liveRide !== previousState.liveRide || state.ble !== previousState.ble || state.route !== previousState.route || state.pipConfig !== previousState.pipConfig || state.pipChartConfig !== previousState.pipChartConfig || state.pipLayout !== previousState.pipLayout) {
            renderPipControls(state);
        }
    });

    function renderSettings(state) {
        const signature = JSON.stringify(state.settings);
        if (signature === lastRenderedSettingsSignature) return;
        homeView.renderSettings(state);
        lastRenderedSettingsSignature = signature;
    }

    function renderActivityDetail(state) {
        if (!elements.activityDetailContent) return;
        const activity = state.selectedActivity;
        const signature = activity
            ? [
                activity.id ?? "",
                activity.updatedAt ?? "",
                activity.rawSession?.records?.length ?? 0,
                activity.rawSession?.createdAt ?? "",
                activity.isSaving === true,
                activity.saveError ?? ""
            ].join("|")
            : "empty";
        if (signature === lastRenderedActivityDetailSignature) return;
        lastRenderedActivityDetailSignature = signature;
        elements.activityDetailContent.innerHTML = buildActivityDetailPageHtml(activity);
        activityDetailView.setActivity(activity);
    }

    function renderPipControls(state) {
        if (!elements.pipBtn) return;
        const hasLiveData = state.ble.heartRate.value !== null || state.ble.powerMeter.power !== null;
        const hasRoute = state.route && state.route.segments.length > 0;
        elements.pipBtn.disabled = !pipController.isSupported || (!state.liveRide.isActive && !hasLiveData && !hasRoute);
        elements.pipMetricInputs?.forEach((input) => { input.checked = state.pipConfig?.[input.value] === true; });
        elements.pipChartInputs?.forEach((input) => { input.checked = state.pipChartConfig?.[input.value] === true; });
        if (elements.pipLayoutSelect && elements.pipLayoutSelect.value !== state.pipLayout) elements.pipLayoutSelect.value = state.pipLayout ?? "grid";
        pipController.render();
        pipController.sync();
    }

    function bindPipMetricControls() {
        elements.pipMetricInputs?.forEach((input) => input.addEventListener("change", (event) => pip.updateConfig(event.target.value, event.target.checked)));
        elements.pipChartInputs?.forEach((input) => input.addEventListener("change", (event) => pip.updateChartConfig(event.target.value, event.target.checked)));
        elements.pipLayoutSelect?.addEventListener("change", (event) => pip.updateLayout(event.target.value));
    }

    return {
        destroy: () => {
            googleMapsServiceModal.destroy();
            rideVisuals.destroy();
            activityDetailView.destroy();
        }
    };
}

export function shouldRenderDashboard(state, previousState) {
    return previousState === undefined
        || state.liveRide !== previousState.liveRide
        || state.route !== previousState.route
        || state.ble !== previousState.ble
        || state.workout !== previousState.workout
        || state.settings !== previousState.settings
        || state.uiMode !== previousState.uiMode;
}

export function hasRouteGeometryChanged(previousRoute, nextRoute) {
    return buildRouteGeometryKey(previousRoute, collectRouteMapLatLngs(previousRoute))
        !== buildRouteGeometryKey(nextRoute, collectRouteMapLatLngs(nextRoute));
}
