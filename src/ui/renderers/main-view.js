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
import { buildDistanceTimeChartSvg } from "./svg/session-charts.js";

export function createMainView({
    store,
    onSetUiMode,
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
    onUploadFit,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    onUpdateSettings,
    onUpdateExportMetadata,
    onUpdatePipConfig,
    pipController
}) {
    const elements = {
        viewHome: document.getElementById("view-home"),
        viewSimulation: document.getElementById("view-simulation"),
        viewLive: document.getElementById("view-live"),
        goToSimBtn: document.getElementById("goToSimBtn"),
        goToLiveBtn: document.getElementById("goToLiveBtn"),
        goHomeBtns: [...document.querySelectorAll(".go-home-btn")],
        homeProfileCard: document.getElementById("homeProfileCard"),
        homeHistoryCard: document.getElementById("homeHistoryCard"),
        simCol1: document.getElementById("sim-col-1"),
        liveCol1: document.getElementById("live-col-1"),
        routeCardContainer: document.getElementById("routeCardContainer"),
        routeCard: document.getElementById("routeCard"),
        routeMapShell: document.getElementById("routeMapShell"),
        setupElevationChartShell: document.getElementById("setupElevationChartShell"),
        exportCardContainer: document.getElementById("exportCardContainer"),
        liveExportSlot: document.getElementById("liveExportSlot"),
        exportCardTemplate: document.getElementById("export-card-template"),
        historyContainer: document.getElementById("historyContainer"),
        personalSettingsForm: document.getElementById("personalSettingsForm"),
        routeTableBody: document.getElementById("routeTableBody"),
        routeTableShell: document.getElementById("routeTableShell"),
        addSegmentBtn: document.getElementById("addSegmentBtn"),
        resetRouteBtn: document.getElementById("resetRouteBtn"),
        gpxFileInput: document.getElementById("gpxFileInput"),
        customWorkoutTargetEnabled: document.getElementById("customWorkoutTargetEnabled"),
        addCustomWorkoutTargetStepBtn: document.getElementById("addCustomWorkoutTargetStepBtn"),
        customWorkoutTargetTableBody: document.getElementById("customWorkoutTargetTableBody"),
        customWorkoutTargetStatus: document.getElementById("customWorkoutTargetStatus"),
        routeSourceLabel: document.getElementById("routeSourceLabel"),
        routeMapPreview: document.getElementById("routeMapPreview"),
        routeSummary: document.getElementById("routeSummary"),
        routeDistanceChip: document.getElementById("routeDistanceChip"),
        routeElevationChip: document.getElementById("routeElevationChip"),
        savedSessionChip: document.getElementById("savedSessionChip"),
        simulationForm: document.getElementById("simulationForm"),
        connectHrBtn: document.getElementById("connectHrBtn"),
        connectPowerBtn: document.getElementById("connectPowerBtn"),
        connectTrainerBtn: document.getElementById("connectTrainerBtn"),
        workoutModeForm: document.getElementById("workoutModeForm"),
        workoutModeSelect: document.getElementById("workoutModeSelect"),
        workoutModeRadios: [...document.querySelectorAll('input[name="workoutMode"]')],
        gradeDifficultyInput: document.getElementById("gradeDifficultyInput"),
        gradeLookaheadInput: document.getElementById("gradeLookaheadInput"),
        maxUphillInput: document.getElementById("maxUphillInput"),
        maxDownhillInput: document.getElementById("maxDownhillInput"),
        gradeSmoothingInput: document.getElementById("gradeSmoothingInput"),
        ergTargetPowerInput: document.getElementById("ergTargetPowerInput"),
        ergConfirmationRequiredInput: document.getElementById("ergConfirmationRequiredInput"),
        resistanceLevelInput: document.getElementById("resistanceLevelInput"),
        workoutModeLabel: document.getElementById("workoutModeLabel"),
        trainerTargetLabel: document.getElementById("trainerTargetLabel"),
        targetTrainerGradeValue: document.getElementById("targetTrainerGradeValue"),
        workoutControlStatus: document.getElementById("workoutControlStatus"),
        openRideDashboardBtn: document.getElementById("openRideDashboardBtn"),
        hrDeviceStatus: document.getElementById("hrDeviceStatus"),
        hrDeviceName: document.getElementById("hrDeviceName"),
        powerDeviceStatus: document.getElementById("powerDeviceStatus"),
        powerDeviceName: document.getElementById("powerDeviceName"),
        trainerDeviceStatus: document.getElementById("trainerDeviceStatus"),
        trainerDeviceName: document.getElementById("trainerDeviceName"),
        rideStatusLabel: document.getElementById("rideStatusLabel"),
        rideStatusMeta: document.getElementById("rideStatusMeta"),
        rideSegmentLabel: document.getElementById("rideSegmentLabel"),
        rideSegmentMeta: document.getElementById("rideSegmentMeta"),
        liveHeartRateDisplay: document.getElementById("liveHeartRateDisplay"),
        livePowerDisplay: document.getElementById("livePowerDisplay"),
        liveCadenceDisplay: document.getElementById("liveCadenceDisplay"),
        liveAvgPowerDisplay: document.getElementById("liveAvgPowerDisplay"),
        liveSpeedDisplay: document.getElementById("liveSpeedDisplay"),
        liveDistanceDisplay: document.getElementById("liveDistanceDisplay"),
        rideDashboard: document.getElementById("rideDashboard"),
        rideDashboardTitle: document.getElementById("rideDashboardTitle"),
        rideDashboardSubtitle: document.getElementById("rideDashboardSubtitle"),
        rideProgressHeadline: document.getElementById("rideProgressHeadline"),
        rideProgressBar: document.getElementById("rideProgressBar"),
        rideProgressDistance: document.getElementById("rideProgressDistance"),
        rideProgressSegment: document.getElementById("rideProgressSegment"),
        rideDashboardMap: document.getElementById("rideDashboardMap"),
        dashboardAvgHr: document.getElementById("dashboardAvgHr"),
        dashboardAvgPower: document.getElementById("dashboardAvgPower"),
        dashboardMaxPower: document.getElementById("dashboardMaxPower"),
        dashboardTss: document.getElementById("dashboardTss"),
        dashboardCurrentSpeed: document.getElementById("dashboardCurrentSpeed"),
        dashboardCurrentGrade: document.getElementById("dashboardCurrentGrade"),
        startRideDashboardBtn: document.getElementById("startRideDashboardBtn"),
        closeRideDashboardBtn: document.getElementById("closeRideDashboardBtn"),
        immersiveBackBtn: document.getElementById("immersiveBackBtn"),
        stopRideDashboardBtn: document.getElementById("stopRideDashboardBtn"),
        runSimulationBtn: document.getElementById("runSimulationBtn"),
        pipBtn: document.getElementById("pipBtn"),
        statusText: document.getElementById("statusText"),
        avgSpeedDisplay: document.getElementById("avgSpeedDisplay"),
        distanceDisplay: document.getElementById("distanceDisplay"),
        heartRateDisplay: document.getElementById("heartRateDisplay"),
        elevationDisplay: document.getElementById("elevationDisplay"),
        elapsedTimeValue: document.getElementById("elapsedTimeValue"),
        routeProgressValue: document.getElementById("routeProgressValue"),
        currentGradeValue: document.getElementById("currentGradeValue"),
        recordCountValue: document.getElementById("recordCountValue"),
        distanceChart: document.getElementById("distanceChart"),
        recordsTableBody: document.getElementById("recordsTableBody"),
        checkboxInputs: [...document.querySelectorAll(".checkbox-group input")],
        dashboardMetricsGrid: document.getElementById("dashboardMetricsGrid"),
        immersiveMetricsGrid: document.getElementById("immersiveMetricsGrid"),
        customizeMetricsBtn: document.getElementById("customizeMetricsBtn"),
        metricsCustomizer: document.getElementById("metricsCustomizer"),
        elevationChart: document.getElementById("elevationChart"),
        liveElevationCard: document.getElementById("liveElevationCard"),
        setupElevationChart: document.getElementById("setupElevationChart"),
        rideDashboardElevationChart: document.getElementById("rideDashboardElevationChart"),
        trainerPushGradeValue: document.getElementById("trainerPushGradeValue"),
        trainerPushGradeMeta: document.getElementById("trainerPushGradeMeta"),
        mapProviderSelect: document.getElementById("mapProviderSelect"),
        deviceControlsPanel: document.getElementById("deviceControlsPanel"),
        loadStreetViewBtn: document.getElementById("loadStreetViewBtn"),
        streetViewApiKey: document.getElementById("streetViewApiKey"),
        immersiveStreetViewBtn: document.getElementById("immersiveStreetViewBtn"),
        streetViewContainer: document.getElementById("streetViewContainer"),
        svPano1: document.getElementById("svPano1"),
        svPano2: document.getElementById("svPano2"),
        streetViewTrajectorySvg: document.getElementById("streetViewTrajectorySvg"),
        workoutTargetHudCard: document.getElementById("workoutTargetHudCard"),
        workoutTargetHudGrid: document.getElementById("workoutTargetHudGrid"),
        workoutTargetChart: document.getElementById("workoutTargetChart"),
        liveWorkoutTargetCard: document.getElementById("liveWorkoutTargetCard")
    };

    const layoutCoordinator = createLayoutCoordinator({ elements });

    elements.fitExportForm = document.getElementById("fitExportForm");
    elements.downloadSessionBtn = document.getElementById("downloadSessionBtn");
    elements.downloadFitBtn = document.getElementById("downloadFitBtn");
    elements.uploadFitBtn = document.getElementById("uploadFitBtn");

    let lastRenderedSettingsSignature = "";

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

    const dashboardRenderer = createDashboardRenderer({
        elements,
        mapController
    });
    dashboardRenderer.bindEvents(store);

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

    function bind(el, event, handler) {
        if (el) el.addEventListener(event, handler);
    }

    bind(elements.closeRideDashboardBtn, "click", onCloseRideDashboard);
    bind(elements.startRideDashboardBtn, "click", onStartRide);
    bind(elements.stopRideDashboardBtn, "click", onStopRide);
    elements.goHomeBtns.forEach((button) => bind(button, "click", () => onSetUiMode("home")));
    bind(elements.goToSimBtn, "click", onEnterSimulationMode);
    bind(elements.goToLiveBtn, "click", onEnterLiveMode);
    bind(elements.runSimulationBtn, "click", onRunSimulation);
    bind(elements.downloadSessionBtn, "click", onDownloadSession);
    bind(elements.downloadFitBtn, "click", onDownloadFit);
    bind(elements.uploadFitBtn, "click", onUploadFit);

    if (elements.personalSettingsForm) {
        elements.personalSettingsForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.personalSettingsForm));
        });
    }

    if (elements.simulationForm) {
        elements.simulationForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.simulationForm));
        });
    }

    elements.checkboxInputs.forEach((input) => {
        input.addEventListener("change", (event) => {
            onUpdatePipConfig(event.target.value, event.target.checked);
        });
    });

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
        renderPipControls(state);
    });

    function renderSettings(state) {
        const signature = JSON.stringify(state.settings);

        if (signature === lastRenderedSettingsSignature) {
            return;
        }

        Object.entries(state.settings).forEach(([key, value]) => {
            let field = null;
            if (elements.personalSettingsForm) field = elements.personalSettingsForm.elements.namedItem(key);
            if (!field && elements.simulationForm) field = elements.simulationForm.elements.namedItem(key);

            if (field && document.activeElement !== field) {
                field.value = value;
            }
        });

        lastRenderedSettingsSignature = signature;
    }

    function renderSession(state) {
        const session = state.uiMode === "live"
            ? (state.liveRide.session ?? state.session)
            : state.session;
        const summary = session?.summary;
        const records = session?.records ?? [];
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
        if (elements.uploadFitBtn) {
            elements.uploadFitBtn.disabled = !session || state.liveRide.isActive || !state.exportMetadata.uploadEndpoint;
        }
        if (elements.runSimulationBtn) elements.runSimulationBtn.disabled = state.liveRide.isActive;
        if (elements.exportCardContainer && state.uiMode === "live") {
            elements.exportCardContainer.hidden = state.liveRide.isActive || !session;
        }
        if (elements.liveElevationCard) {
            // Live 模式下，无论是否在骑行中，只要有路线就显示坡度图
            elements.liveElevationCard.hidden = !session?.route && !state.route;
        }

        renderRecords(records, metrics);
        renderChart(records);
        
        // 实时骑行中的预览使用 live session 路线+当前位置；非骑行状态使用当前选中的路线
        const previewRoute = state.liveRide.isActive
            ? (state.liveRide.session?.route ?? state.route)
            : state.route;
        const currentRecord = state.liveRide.isActive
            ? (state.liveRide.session?.records?.at(-1) ?? null)
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

    function renderPipControls(state) {
        if (!elements.pipBtn) return;
        const hasLiveData = state.ble.heartRate.value !== null || state.ble.powerMeter.power !== null;
        const hasRoute = state.route && state.route.segments.length > 0;
        elements.pipBtn.disabled = !pipController.isSupported || (!state.liveRide.isActive && !state.session && !hasLiveData && !hasRoute);

        pipController.render();
        pipController.sync();
    }
}

function readSettingsFromForm(form) {
    const formData = new FormData(form);
    const result = {};

    ["power", "mass", "ftp", "restingHr", "maxHr", "cda", "crr", "windSpeed"].forEach((key) => {
        if (form.elements.namedItem(key)) {
            result[key] = Number(formData.get(key));
        }
    });

    return result;
}
