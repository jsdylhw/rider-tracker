import { createStore } from "./store/app-store.js";
import { createInitialState } from "./store/initial-state.js";
import { loadLastSession } from "../adapters/storage/session-storage.js";
import { createMainView } from "../ui/renderers/main-view.js";
import { createPipController } from "../ui/pip/pip-controller.js";
import { formatDuration, formatNumber } from "../shared/format.js";
import { buildPipViewModel } from "./view-models/live-ride-view-model.js";

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
const inferredInitialUiMode = inferInitialUiMode();

if (inferredInitialUiMode !== store.getState().uiMode) {
    store.setState((state) => ({
        ...state,
        uiMode: inferredInitialUiMode
    }));
}

// 2. 创建业务服务 (Services)
const userService = createUserService({ store });
const routeService = createRouteService({ store });
const deviceService = createDeviceService({ store });
const exportService = createExportService({ store });
const rideService = createRideService({ store, deviceService, exportService });
const uiService = createUiService({ store });
const workoutService = createWorkoutService({ store, deviceService });

// 3. 创建控制器与视图
const pipController = createPipController({
    button: document.getElementById("pipBtn"),
    template: document.getElementById("pip-template"),
    getData: () => buildPipViewModel(store.getState())
});

createMainView({
    store,
    pipController,
    onSetUiMode: uiService.setUiMode,
    onEnterSimulationMode: uiService.enterSimulationMode,
    onEnterLiveMode: uiService.enterLiveMode,
    onUpdateWorkoutMode: workoutService.updateWorkoutMode,
    onUpdateGradeSimulationConfig: workoutService.updateGradeSimulationConfig,
    onUpdateErgTargetPower: workoutService.updateErgTargetPower,
    onUpdateErgConfirmationMode: workoutService.updateErgConfirmationMode,
    onUpdateResistanceLevel: workoutService.updateResistanceLevel,
    onUpdateCustomWorkoutTargetEnabled: workoutService.updateCustomWorkoutTargetEnabled,
    onAddCustomWorkoutTargetStep: workoutService.addCustomWorkoutTargetStep,
    onUpdateCustomWorkoutTargetStep: workoutService.updateCustomWorkoutTargetStep,
    onRemoveCustomWorkoutTargetStep: workoutService.removeCustomWorkoutTargetStep,
    onAddSegment: routeService.addSegment,
    onResetRoute: routeService.resetRoute,
    onToggleHeartRate: deviceService.toggleHeartRate,
    onTogglePowerMeter: deviceService.togglePowerMeter,
    onToggleTrainer: deviceService.toggleTrainer,
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
        statusText: `已恢复最近一次模拟：${formatDuration(persistedSession.summary.metrics?.ride?.elapsedSeconds ?? 0)} / ${formatNumber(persistedSession.summary.metrics?.ride?.distanceKm ?? 0, 2)} km`
    }));
}

userService.loadUserProfile();

function inferInitialUiMode() {
    const hasHomeView = Boolean(document.getElementById("view-home"));
    const hasSimulationView = Boolean(document.getElementById("view-simulation"));
    const hasLiveView = Boolean(document.getElementById("view-live"));

    // For standalone pages like live.html, auto-enter corresponding mode.
    if (!hasHomeView && hasLiveView && !hasSimulationView) {
        return "live";
    }
    if (!hasHomeView && hasSimulationView && !hasLiveView) {
        return "simulation";
    }

    return "home";
}
