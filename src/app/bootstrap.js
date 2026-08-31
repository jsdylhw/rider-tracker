import { createStore } from "./store/app-store.js";
import { createInitialState } from "./store/initial-state.js";
import { loadPipPreferences } from "../adapters/storage/session-storage.js";
import { createMainView } from "../ui/renderers/main-view.js";
import { createPipController } from "../ui/pip/pip-controller.js";
import { formatDuration, formatNumber } from "../shared/format.js";
import { buildPipViewModel } from "./view-models/live-ride-view-model.js";
import { ensureLeaflet } from "../ui/map/leaflet-loader.js";

import { createUserService } from "./services/user-service.js";
import { createRouteService } from "./services/route-service.js";
import { createRideService } from "./services/ride-service.js";
import { createDeviceService } from "./services/device-service.js";
import { createExportService } from "./services/export-service.js";
import { createGoogleMapsConfigService } from "./services/google-maps-config-service.js";
import { createUiService } from "./services/ui-service.js";
import { createWorkoutService } from "./services/workout-service.js";
import { createAgentFloatingWindow } from "../ui/agent/agent-floating-window.js";
import { createAgentCapabilityService } from "./services/agent-capability-service.js";

// Leaflet is loaded from CDN with fallbacks. Do not prevent non-map features
// from starting if every external source is unavailable.
await ensureLeaflet();

// 1. 初始化状态与 Store
const pipPreferences = loadPipPreferences();
const store = createStore(createInitialState({ pipPreferences }));
const inferredInitialUiMode = inferInitialUiMode();

if (inferredInitialUiMode !== store.getState().uiMode) {
    store.setState((state) => ({
        ...state,
        uiMode: inferredInitialUiMode
    }));
}

// 2. 创建业务服务 (Services)
const googleMapsConfig = createGoogleMapsConfigService();
await googleMapsConfig.loadRuntimeConfig();
const userService = createUserService({ store });
const routeService = createRouteService({ store, googleMapsConfig });
const deviceService = createDeviceService({ store });
const exportService = createExportService({ store });
const rideService = createRideService({ store, deviceService, exportService, routeService });
const uiService = createUiService({ store });
const workoutService = createWorkoutService({ store, deviceService });
const agentFloatingWindow = createAgentFloatingWindow();
const agentCapabilityService = createAgentCapabilityService({ store });
const stopAgentVisibilitySync = store.subscribe((state, previousState) => {
    if (previousState === undefined || state.uiMode !== previousState.uiMode) {
        agentFloatingWindow.setVisible(state.uiMode === "home");
    }
    if (previousState === undefined || state.agentCapabilities !== previousState.agentCapabilities) {
        agentFloatingWindow.setCapabilities(state.agentCapabilities);
    }
});
const stopAgentCapabilityChecks = agentCapabilityService.start();

// 3. 创建控制器与视图
const pipController = createPipController({
    button: document.getElementById("pipBtn"),
    template: document.getElementById("pip-template"),
    getData: () => buildPipViewModel(store.getState())
});

const mainView = createMainView({
    store,
    pipController,
    actions: {
        navigation: {
            setUiMode: uiService.setUiMode,
            openActivityDetail: uiService.openActivityDetail,
            enterLiveMode: uiService.enterLiveMode
        },
        user: { updateSettings: userService.updateSettings },
        googleMaps: googleMapsConfig,
        route: {
            addSegment: routeService.addSegment,
            resetRoute: routeService.resetRoute,
            importGpx: routeService.importGpx,
            listSavedRoutes: routeService.listSavedRoutes,
            loadSavedRoute: routeService.loadSavedRoute,
            continueSavedRoute: routeService.continueSavedRoute,
            saveCurrentRoute: routeService.saveCurrentRoute,
            deleteSavedRoute: routeService.deleteSavedRoute,
            createMapDrawRoute: routeService.createMapDrawRoute,
            planAgentRoutes: routeService.planAgentRoutes,
            previewAgentRoute: routeService.previewAgentRoute,
            confirmAgentRoute: routeService.confirmAgentRoute,
            exploreAgentRouteSegments: routeService.exploreAgentRouteSegments,
            composeAgentRouteSegments: routeService.composeAgentRouteSegments,
            reverseAgentRoute: routeService.reverseAgentRoute,
            undoAgentRoute: routeService.undoAgentRoute,
            invalidatePendingMapRoute: routeService.invalidatePendingMapRoute,
            planMapRoute: routeService.planMapRoute,
            queueExplorationTurn: routeService.queueExplorationTurn,
            requestCurrentRouteElevation: routeService.requestCurrentRouteElevation,
            updateSegment: routeService.updateRouteSegment,
            removeSegment: routeService.removeRouteSegment
        },
        ride: {
            openRideDashboard: rideService.openRideDashboard,
            closeRideDashboard: rideService.closeRideDashboard,
            startRide: rideService.startRide,
            stopRide: rideService.stopRide,
            updateRideInput: rideService.updateRideInput
        },
        device: {
            toggleHeartRate: deviceService.toggleHeartRate,
            togglePowerMeter: deviceService.togglePowerMeter,
            toggleTrainer: deviceService.toggleTrainer
        },
        workout: {
            updateMode: workoutService.updateWorkoutMode,
            updateGradeSimulationConfig: workoutService.updateGradeSimulationConfig,
            updateErgTargetPower: workoutService.updateErgTargetPower,
            updateErgConfirmationMode: workoutService.updateErgConfirmationMode,
            updateResistanceLevel: workoutService.updateResistanceLevel,
            updateCustomTargetEnabled: workoutService.updateCustomWorkoutTargetEnabled,
            addCustomTargetStep: workoutService.addCustomWorkoutTargetStep,
            editCustomTarget: workoutService.editCustomWorkoutTarget,
            applyCustomTargetPreset: workoutService.applyCustomWorkoutTargetPreset,
            updateCustomTargetStep: workoutService.updateCustomWorkoutTargetStep,
            removeCustomTargetStep: workoutService.removeCustomWorkoutTargetStep
        },
        export: {
            downloadSession: exportService.downloadSession,
            downloadFit: exportService.downloadFit,
            importFit: exportService.importFit,
            connectStrava: exportService.connectStrava,
            uploadFit: exportService.uploadFit,
            uploadActivityFit: exportService.uploadActivityFit,
            downloadActivitySession: exportService.downloadActivitySession,
            downloadActivityFit: exportService.downloadActivityFit,
            updateExportMetadata: exportService.updateExportMetadata
        },
        pip: {
            updateConfig: uiService.updatePipConfig,
            updateChartConfig: uiService.updatePipChartConfig,
            updateLayout: uiService.updatePipLayout
        }
    }
});

// 4. 注册页面关闭时的清理逻辑（同步收尾 + 尝试 sendBeacon 发送 FIT）
window.addEventListener("beforeunload", () => {
    mainView.destroy();
    stopAgentVisibilitySync();
    stopAgentCapabilityChecks();
    agentFloatingWindow.destroy();
    if (store.getState().liveRide.isActive) {
        rideService.finalizeRideSync({ sendBeacon: true });
    }
});

// 5. 启动初始化流程
if (persistedSession) {
    store.setState((state) => ({
        ...state,
        statusText: `已恢复最近一次骑行：${formatDuration(persistedSession.summary.metrics?.ride?.elapsedSeconds ?? 0)} / ${formatNumber(persistedSession.summary.metrics?.ride?.distanceKm ?? 0, 2)} km`
    }));
}

userService.loadUserProfile();

function inferInitialUiMode() {
    const hasHomeView = Boolean(document.getElementById("view-home"));
    const hasLiveView = Boolean(document.getElementById("view-live"));

    // For standalone pages like live.html, auto-enter corresponding mode.
    if (!hasHomeView && hasLiveView) {
        return "live";
    }

    return "home";
}
