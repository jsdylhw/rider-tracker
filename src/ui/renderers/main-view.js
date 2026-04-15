import { formatDuration, formatNumber } from "../../shared/format.js";
import { createMapController } from "../map/map-controller.js";
import { createRouteRenderer } from "./route-renderer.js";
import { createDashboardRenderer } from "./dashboard-renderer.js";
import { createExportRenderer } from "./export-renderer.js";
import { createDeviceRenderer } from "./device-renderer.js";
import { createLayoutCoordinator } from "./layout-coordinator.js";
import { createWorkoutRenderer } from "./workout-renderer.js";

export function createMainView({
    store,
    onSetUiMode,
    onEnterSimulationMode,
    onEnterLiveMode,
    onUpdateWorkoutMode,
    onUpdateGradeSimulationConfig,
    onUpdateErgTargetPower,
    onAddSegment,
    onResetRoute,
    onToggleHeartRate,
    onTogglePowerMeter,
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
        routeSourceLabel: document.getElementById("routeSourceLabel"),
        routeMapPreview: document.getElementById("routeMapPreview"),
        routeSummary: document.getElementById("routeSummary"),
        routeDistanceChip: document.getElementById("routeDistanceChip"),
        routeElevationChip: document.getElementById("routeElevationChip"),
        savedSessionChip: document.getElementById("savedSessionChip"),
        simulationForm: document.getElementById("simulationForm"),
        connectHrBtn: document.getElementById("connectHrBtn"),
        connectPowerBtn: document.getElementById("connectPowerBtn"),
        workoutModeForm: document.getElementById("workoutModeForm"),
        workoutModeSelect: document.getElementById("workoutModeSelect"),
        workoutModeRadios: [...document.querySelectorAll('input[name="workoutMode"]')],
        gradeDifficultyInput: document.getElementById("gradeDifficultyInput"),
        gradeLookaheadInput: document.getElementById("gradeLookaheadInput"),
        maxUphillInput: document.getElementById("maxUphillInput"),
        maxDownhillInput: document.getElementById("maxDownhillInput"),
        gradeSmoothingInput: document.getElementById("gradeSmoothingInput"),
        ergTargetPowerInput: document.getElementById("ergTargetPowerInput"),
        workoutModeLabel: document.getElementById("workoutModeLabel"),
        trainerTargetLabel: document.getElementById("trainerTargetLabel"),
        targetTrainerGradeValue: document.getElementById("targetTrainerGradeValue"),
        workoutControlStatus: document.getElementById("workoutControlStatus"),
        openRideDashboardBtn: document.getElementById("openRideDashboardBtn"),
        hrDeviceStatus: document.getElementById("hrDeviceStatus"),
        hrDeviceName: document.getElementById("hrDeviceName"),
        powerDeviceStatus: document.getElementById("powerDeviceStatus"),
        powerDeviceName: document.getElementById("powerDeviceName"),
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
        customizeMetricsBtn: document.getElementById("customizeMetricsBtn"),
        metricsCustomizer: document.getElementById("metricsCustomizer"),
        elevationChart: document.getElementById("elevationChart"),
        liveElevationCard: document.getElementById("liveElevationCard"),
        setupElevationChart: document.getElementById("setupElevationChart"),
        mapProviderSelect: document.getElementById("mapProviderSelect")
    };

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
        onOpenRideDashboard,
        onStartRide,
        onStopRide
    });
    const workoutRenderer = createWorkoutRenderer({
        elements,
        onUpdateWorkoutMode,
        onUpdateGradeSimulationConfig,
        onUpdateErgTargetPower
    });

    const layoutCoordinator = createLayoutCoordinator({ elements });

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

        if (elements.avgSpeedDisplay) elements.avgSpeedDisplay.innerHTML = `${formatNumber(summary?.averageSpeedKph ?? 0, 1)} <span class="unit">km/h</span>`;
        if (elements.distanceDisplay) elements.distanceDisplay.innerHTML = `${formatNumber(summary?.distanceKm ?? 0, 2)} <span class="unit">km</span>`;
        if (elements.heartRateDisplay) elements.heartRateDisplay.innerHTML = `${Math.round(summary?.averageHeartRate ?? 0)} <span class="unit">bpm</span>`;
        if (elements.elevationDisplay) elements.elevationDisplay.innerHTML = `${Math.round(summary?.ascentMeters ?? 0)} <span class="unit">m</span>`;
        if (elements.elapsedTimeValue) elements.elapsedTimeValue.textContent = formatDuration(summary?.elapsedSeconds ?? 0);
        if (elements.routeProgressValue) elements.routeProgressValue.textContent = `${Math.round((summary?.routeProgress ?? 0) * 100)}%`;
        if (elements.currentGradeValue) elements.currentGradeValue.textContent = `${formatNumber(summary?.currentGradePercent ?? 0, 1)}%`;
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

        renderRecords(records);
        renderChart(records);
        
        // Ensure route chart on dashboard gets the current record pointer
        const currentRecord = session?.records?.at(-1) ?? null;
        routeRenderer.renderElevationChart(session?.route ?? state.route, currentRecord);
    }

    function renderRecords(records) {
        if (!elements.recordsTableBody) return;
        
        if (records.length === 0) {
            elements.recordsTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">运行模拟后将在这里显示记录。</td></tr>`;
            return;
        }

        const startRecord = records[0];
        const endRecord = records[records.length - 1];
        
        const durationSeconds = endRecord.elapsedSeconds - startRecord.elapsedSeconds + 1;
        const distanceKm = endRecord.distanceKm - startRecord.distanceKm;
        const avgSpeedKph = durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0;
        const avgPower = Math.round(records.reduce((sum, r) => sum + (r.power || 0), 0) / records.length);
        const avgHr = Math.round(records.reduce((sum, r) => sum + (r.heartRate || 0), 0) / records.length);

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

        if (records.length === 0) {
            elements.distanceChart.innerHTML = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    运行模拟后将显示图像
                </text>
            `;
            return;
        }

        const width = 640;
        const height = 280;
        const padding = 40;

        const maxTime = records[records.length - 1].elapsedSeconds;
        const maxDist = records[records.length - 1].distanceKm;

        const points = records.map((r) => {
            const x = padding + (r.elapsedSeconds / maxTime) * (width - padding * 2);
            const y = height - padding - (r.distanceKm / maxDist) * (height - padding * 2);
            return `${x},${y}`;
        }).join(" ");

        elements.distanceChart.innerHTML = `
            <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
            
            <!-- X 轴 (时间) -->
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
            <text x="${padding}" y="${height - padding + 20}" fill="#64748b" font-size="12">0s</text>
            <text x="${width - padding}" y="${height - padding + 20}" fill="#64748b" font-size="12" text-anchor="end">${formatDuration(maxTime)}</text>
            
            <!-- Y 轴 (距离) -->
            <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
            <text x="${padding - 10}" y="${height - padding}" fill="#64748b" font-size="12" text-anchor="end">0 km</text>
            <text x="${padding - 10}" y="${padding}" fill="#64748b" font-size="12" text-anchor="end">${formatNumber(maxDist, 1)} km</text>
        `;
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
