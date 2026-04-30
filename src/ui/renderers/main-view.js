import { formatDuration, formatNumber } from "../../shared/format.js";
import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";
import { createMapController } from "../map/map-controller.js";
import { createRouteRenderer } from "./route-renderer.js";
import { createDashboardRenderer } from "./dashboard-renderer.js";
import { createExportRenderer } from "./export-renderer.js";
import { createDeviceRenderer } from "./device-renderer.js";
import { createLayoutCoordinator } from "./layout-coordinator.js";
import { createWorkoutRenderer } from "./workout-renderer.js";
import { createCustomWorkoutTargetRenderer } from "./custom-workout-target-renderer.js";
import { createActivityHistoryRenderer } from "./activity-history-renderer.js";
import { buildDistanceTimeChartSvg } from "./svg/session-charts.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { createHomeView } from "../views/home-view.js";
import { createSimulationView } from "../views/simulation-view.js";
import { createLiveView } from "../views/live-view.js";
import { createExportView } from "../views/export-view.js";
import { createActivityDetailView } from "../views/activity-detail-view.js";
import { buildActivityDetailPageHtml } from "./activity-detail-renderer.js";

export function createMainView({
    store,
    onSetUiMode,
    onOpenActivityDetail,
    onEnterSimulationMode,
    onEnterLiveMode,
    onUpdateWorkoutMode,
    onUpdateGradeSimulationConfig,
    onUpdateErgTargetPower,
    onUpdateErgConfirmationMode,
    onUpdateResistanceLevel,
    onUpdateCustomWorkoutTargetEnabled,
    onAddCustomWorkoutTargetStep,
    onUpdateCustomWorkoutTargetStep,
    onRemoveCustomWorkoutTargetStep,
    onAddSegment,
    onResetRoute,
    onToggleHeartRate,
    onTogglePowerMeter,
    onToggleTrainer,
    onOpenRideDashboard,
    onCloseRideDashboard,
    onStartRide,
    onStopRide,
    onRunSimulation,
    onDownloadSession,
    onDownloadFit,
    onConnectStrava,
    onUploadFit,
    onUploadActivityFit,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    onUpdateSettings,
    onUpdateExportMetadata,
    onUpdatePipConfig,
    onUpdatePipLayout,
    pipController
}) {
    const homeView = createHomeView({
        onSetUiMode,
        onEnterSimulationMode,
        onEnterLiveMode,
        onUpdateSettings
    });
    const simulationView = createSimulationView({
        onRunSimulation,
        onUpdateSettings
    });
    const liveView = createLiveView({
        onCloseRideDashboard,
        onStartRide,
        onStopRide
    });
    const exportView = createExportView({
        onDownloadSession,
        onDownloadFit,
        onConnectStrava,
        onUploadFit
    });
    const activityDetailView = createActivityDetailView({
        onSetUiMode,
        onConnectStrava,
        onUploadActivityFit
    });

    const elements = {
        ...homeView.elements,
        ...simulationView.elements,
        ...liveView.elements,
        ...exportView.elements,
        ...activityDetailView.elements,
        pipBtn: document.getElementById("pipBtn")
    };

    let lastRenderedSettingsSignature = "";

    const layoutCoordinator = createLayoutCoordinator({ elements });
    const mapController = createMapController({
        previewElement: elements.routeMapPreview,
        dashboardElement: elements.rideDashboardMap,
        initialProviderKey: elements.mapProviderSelect?.value
    });
    const routeRenderer = createRouteRenderer({
        elements,
        mapController,
        onAddSegment,
        onResetRoute,
        onImportGpx,
        onUpdateRouteSegment,
        onRemoveRouteSegment
    });
    const dashboardRenderer = createDashboardRenderer({ elements, mapController });
    dashboardRenderer.bindEvents(store);
    bindPipMetricControls();

    const exportRenderer = createExportRenderer({
        elements,
        onUpdateExportMetadata
    });
    const deviceRenderer = createDeviceRenderer({
        elements,
        onToggleHeartRate,
        onTogglePowerMeter,
        onToggleTrainer,
        onOpenRideDashboard,
        onStartRide,
        onStopRide
    });
    const workoutRenderer = createWorkoutRenderer({
        elements,
        onUpdateWorkoutMode,
        onUpdateGradeSimulationConfig,
        onUpdateErgTargetPower,
        onUpdateErgConfirmationMode,
        onUpdateResistanceLevel
    });
    const customWorkoutTargetRenderer = createCustomWorkoutTargetRenderer({
        elements,
        onUpdateCustomWorkoutTargetEnabled,
        onAddCustomWorkoutTargetStep,
        onUpdateCustomWorkoutTargetStep,
        onRemoveCustomWorkoutTargetStep
    });
    const activityHistoryRenderer = createActivityHistoryRenderer({
        containers: [
            elements.historyContainer,
            elements.postRideHistoryContainer
        ],
        onStatus: (statusText) => {
            store.setState((state) => ({
                ...state,
                statusText
            }));
        },
        onOpenActivityDetail: (activity) => {
            onOpenActivityDetail(activity);
        }
    });
    void activityHistoryRenderer.refresh();

    store.subscribe((state) => {
        layoutCoordinator.render(state);
        renderSettings(state);
        routeRenderer.render(state);
        dashboardRenderer.render(state);
        exportRenderer.render(state);
        workoutRenderer.render(state);
        customWorkoutTargetRenderer.render(state);
        deviceRenderer.render(state);
        renderSession(state);
        renderPostRideReport(state);
        renderActivityDetail(state);
        renderPipControls(state);
    });

    function renderSettings(state) {
        const signature = JSON.stringify(state.settings);
        if (signature === lastRenderedSettingsSignature) return;

        homeView.renderSettings(state);
        simulationView.renderSettings(state);
        lastRenderedSettingsSignature = signature;
    }

    function renderSession(state) {
        const isLiveMode = state.uiMode === "live";
        const session = isLiveMode
            ? (state.liveRide.session ?? state.session)
            : state.session;
        const summary = isLiveMode
            ? (state.liveRide.summary ?? session?.summary)
            : session?.summary;
        const records = isLiveMode
            ? (state.liveRide.records ?? session?.records ?? [])
            : (session?.records ?? []);
        const metrics = resolveRideMetrics({
            summary,
            records,
            ftp: state.settings?.ftp ?? null
        });

        if (elements.avgSpeedDisplay) elements.avgSpeedDisplay.innerHTML = `${formatNumber(metrics.speed.averageKph, 1)} <span class="unit">km/h</span>`;
        if (elements.distanceDisplay) elements.distanceDisplay.innerHTML = `${formatNumber(metrics.ride.distanceKm, 2)} <span class="unit">km</span>`;
        if (elements.heartRateDisplay) elements.heartRateDisplay.innerHTML = `${Math.round(metrics.heartRate.averageBpm)} <span class="unit">bpm</span>`;
        if (elements.elevationDisplay) elements.elevationDisplay.innerHTML = `${Math.round(metrics.ride.ascentMeters)} <span class="unit">m</span>`;
        if (elements.elapsedTimeValue) elements.elapsedTimeValue.textContent = formatDuration(metrics.ride.elapsedSeconds);
        if (elements.routeProgressValue) elements.routeProgressValue.textContent = `${Math.round((metrics.ride.routeProgress ?? 0) * 100)}%`;
        if (elements.currentGradeValue) elements.currentGradeValue.textContent = `${formatNumber(metrics.grade.currentPercent ?? 0, 1)}%`;
        if (elements.recordCountValue) elements.recordCountValue.textContent = String(records.length);
        if (elements.statusText) elements.statusText.textContent = state.statusText;

        if (elements.downloadSessionBtn) elements.downloadSessionBtn.disabled = !session || state.liveRide.isActive;
        if (elements.downloadFitBtn) elements.downloadFitBtn.disabled = !session || state.liveRide.isActive;
        if (elements.connectStravaBtn) elements.connectStravaBtn.disabled = state.liveRide.isActive || !state.exportMetadata.stravaServerUrl;
        if (elements.uploadFitBtn) {
            elements.uploadFitBtn.disabled = !session || state.liveRide.isActive || !state.exportMetadata.stravaServerUrl;
        }
        if (elements.runSimulationBtn) elements.runSimulationBtn.disabled = state.liveRide.isActive;
        if (elements.exportCardContainer && state.uiMode === "live") {
            elements.exportCardContainer.hidden = true;
        }
        if (elements.liveElevationCard) {
            const isGradeSimulation = state.workout?.mode === WORKOUT_MODES.GRADE_SIM;
            elements.liveElevationCard.hidden = !isGradeSimulation || (!session?.route && !state.route);
        }

        renderRecords(records, metrics);
        renderChart(records);

        const previewRoute = state.liveRide.isActive
            ? (state.liveRide.session?.route ?? state.route)
            : state.route;
        const currentRecord = state.liveRide.isActive
            ? (state.liveRide.session?.currentRecord ?? state.liveRide.records?.at(-1) ?? null)
            : null;
        routeRenderer.renderElevationChart(previewRoute, currentRecord);
    }

    function renderRecords(records, metrics) {
        if (!elements.recordsTableBody) return;

        if (records.length === 0) {
            elements.recordsTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">运行模拟后将在这里显示记录。</td></tr>`;
            return;
        }

        const durationSeconds = metrics.ride.elapsedSeconds;
        const distanceKm = metrics.ride.distanceKm;
        const avgSpeedKph = metrics.speed.averageKph;
        const avgPower = Math.round(metrics.power.averageWatts);
        const avgHr = Math.round(metrics.heartRate.averageBpm);
        const routeName = "当前路线总计";

        elements.recordsTableBody.innerHTML = `
            <tr>
                <td>${routeName}</td>
                <td>${formatDuration(durationSeconds)}</td>
                <td>${formatNumber(distanceKm, 2)} km</td>
                <td>${formatNumber(avgSpeedKph, 1)} km/h</td>
                <td>${avgPower} W</td>
                <td>${avgHr} bpm</td>
            </tr>
        `;
    }

    function renderChart(records) {
        if (!elements.distanceChart) return;
        elements.distanceChart.innerHTML = buildDistanceTimeChartSvg(records);
    }

    function renderPostRideReport(state) {
        if (!elements.postRideReportCard) return;
        elements.postRideReportCard.hidden = true;
    }

    function renderActivityDetail(state) {
        if (!elements.activityDetailContent) return;
        elements.activityDetailContent.innerHTML = buildActivityDetailPageHtml(state.selectedActivity);
    }

    function renderPipControls(state) {
        if (!elements.pipBtn) return;
        const hasLiveData = state.ble.heartRate.value !== null || state.ble.powerMeter.power !== null;
        const hasRoute = state.route && state.route.segments.length > 0;
        elements.pipBtn.disabled = !pipController.isSupported || (!state.liveRide.isActive && !state.session && !hasLiveData && !hasRoute);

        renderPipMetricControls(state);
        pipController.render();
        pipController.sync();
    }

    function bindPipMetricControls() {
        elements.pipMetricInputs?.forEach((input) => {
            input.addEventListener("change", (event) => {
                onUpdatePipConfig(event.target.value, event.target.checked);
            });
        });

        elements.pipLayoutSelect?.addEventListener("change", (event) => {
            onUpdatePipLayout(event.target.value);
        });
    }

    function renderPipMetricControls(state) {
        elements.pipMetricInputs?.forEach((input) => {
            input.checked = state.pipConfig?.[input.value] === true;
        });

        if (elements.pipLayoutSelect && elements.pipLayoutSelect.value !== state.pipLayout) {
            elements.pipLayoutSelect.value = state.pipLayout ?? "grid";
        }
    }
}
