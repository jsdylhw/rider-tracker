import { createStore } from "./store/app-store.js";
import { createInitialState } from "./store/initial-state.js";
import { loadLastSession } from "../adapters/storage/session-storage.js";
import { createMainView } from "../ui/renderers/main-view.js";
import { createPipController } from "../ui/pip/pip-controller.js";
import { formatDuration, formatNumber } from "../shared/format.js";
import { getWorkoutModeLabel } from "../domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../domain/workout/trainer-command.js";

import { createUserService } from "./services/user-service.js";
import { createRouteService } from "./services/route-service.js";
import { createRideService } from "./services/ride-service.js";
import { createDeviceService } from "./services/device-service.js";
import { createExportService } from "./services/export-service.js";
import { createUiService } from "./services/ui-service.js";
import { createWorkoutService } from "./services/workout-service.js";

// 1. 初始化状态与 Store
const persistedSession = loadLastSession();
const store = createStore(createInitialState(persistedSession));

// 2. 创建业务服务 (Services)
const userService = createUserService({ store });
const routeService = createRouteService({ store });
const rideService = createRideService({ store });
const deviceService = createDeviceService({ store });
const exportService = createExportService({ store });
const uiService = createUiService({ store });
const workoutService = createWorkoutService({ store });

// 3. 创建控制器与视图
const pipController = createPipController({
    button: document.getElementById("pipBtn"),
    template: document.getElementById("pip-template"),
    getData: () => {
        const state = store.getState();
        const liveRecord = state.liveRide.session?.records.at(-1);
        const liveSummary = state.liveRide.session?.summary;
        const route = state.liveRide.session?.route ?? state.route;
        
        const liveHeartRate = state.ble.heartRate.value;
        const livePower = state.ble.powerMeter.power;
        const liveCadence = state.ble.powerMeter.cadence;
        const workoutRuntime = state.workout.runtime;
        const trainerTarget = resolvePipTrainerTarget(workoutRuntime);

        const totalDistanceKm = route ? route.totalDistanceMeters / 1000 : 0;
        const distanceKm = liveSummary?.distanceKm ?? 0;
        const remainingKm = Math.max(0, totalDistanceKm - distanceKm);

        return {
            distance: formatNumber(distanceKm, 2),
            remaining: formatNumber(remainingKm, 2),
            speed: liveSummary ? formatNumber(liveSummary.currentSpeedKph, 1) : "--",
            power: livePower !== null ? String(livePower) : "--",
            hr: liveHeartRate !== null ? String(liveHeartRate) : "--",
            cadence: liveCadence !== null ? String(liveCadence) : "--",
            modeLabel: getWorkoutModeLabel(state.workout.mode),
            currentGrade: formatNumber(workoutRuntime.currentGradePercent ?? liveSummary?.currentGradePercent ?? 0, 1),
            lookaheadGrade: formatNumber(workoutRuntime.lookaheadGradePercent ?? 0, 1),
            targetTrainerGrade: formatNumber(workoutRuntime.targetTrainerGradePercent ?? 0, 1),
            targetControlLabel: trainerTarget.label,
            targetControlValue: trainerTarget.value,
            targetControlUnit: trainerTarget.unit,
            controlStatus: workoutRuntime.controlStatus,
            route: route,
            currentRecord: liveRecord ?? null
        };
    }
});

createMainView({
    store,
    pipController,
    onSetUiMode: uiService.setUiMode,
    onEnterSimulationMode: uiService.enterSimulationMode,
    onEnterLiveMode: uiService.enterLiveMode,
    onUpdateWorkoutMode: workoutService.updateWorkoutMode,
    onUpdateGradeSimulationConfig: workoutService.updateGradeSimulationConfig,
    onAddSegment: routeService.addSegment,
    onResetRoute: routeService.resetRoute,
    onToggleHeartRate: deviceService.toggleHeartRate,
    onTogglePowerMeter: deviceService.togglePowerMeter,
    onOpenRideDashboard: rideService.openRideDashboard,
    onCloseRideDashboard: rideService.closeRideDashboard,
    onStartRide: rideService.startRide,
    onStopRide: rideService.stopRide,
    onRunSimulation: rideService.runSimulation,
    onDownloadSession: exportService.downloadSession,
    onDownloadFit: exportService.downloadFit,
    onUploadFit: exportService.uploadFit,
    onImportGpx: routeService.importGpx,
    onUpdateRouteSegment: routeService.updateRouteSegment,
    onRemoveRouteSegment: routeService.removeRouteSegment,
    onUpdateSettings: userService.updateSettings,
    onUpdateExportMetadata: exportService.updateExportMetadata,
    onUpdatePipConfig: uiService.updatePipConfig
});

// 4. 启动初始化流程
if (persistedSession) {
    store.setState((state) => ({
        ...state,
        statusText: `已恢复最近一次模拟：${formatDuration(persistedSession.summary.elapsedSeconds)} / ${formatNumber(persistedSession.summary.distanceKm, 2)} km`
    }));
}

userService.loadUserProfile();

function resolvePipTrainerTarget(runtime) {
    if (runtime.trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return {
            label: "目标阻力",
            value: formatNumber(runtime.targetResistanceLevel ?? 0, 0),
            unit: "%"
        };
    }

    if (runtime.trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return {
            label: "目标功率",
            value: formatNumber(runtime.targetErgPowerWatts ?? 0, 0),
            unit: "W"
        };
    }

    return {
        label: "目标坡度",
        value: formatNumber(runtime.targetTrainerGradePercent ?? 0, 1),
        unit: "%"
    };
}
