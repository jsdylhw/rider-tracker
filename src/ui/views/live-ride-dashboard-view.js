import { collectElements, collectNamedElements } from "./view-elements.js";

const DASHBOARD_ELEMENT_IDS = [
    "rideDashboard", "rideDashboardTitle", "rideDashboardMap", "rideRouteContext",
    "startRideDashboardBtn",
    "closeRideDashboardBtn", "immersiveBackBtn", "immersiveUiToggleBtn", "stopRideDashboardBtn",
    "dashboardMetricsGrid", "immersiveMetricsGrid", "customizeMetricsBtn", "pipLayoutSelect",
    "metricsCustomizer", "metricAddSelect", "addMetricBtn", "selectedMetricsList",
    "liveElevationCard", "rideElevationChartTitle",
    "rideDashboardElevationChart", "immersiveMovingStreetViewBtn", "immersiveStableStreetViewBtn",
    "loadStreetViewBtn", "requestRouteElevationBtn", "explorationTurnControls",
    "explorationTurnStatus", "explorationTurnLeftBtn", "explorationTurnStraightBtn",
    "explorationTurnRightBtn", "streetViewContainer", "svPano1", "svPano2",
    "workoutTargetHudCard", "workoutTargetHudGrid", "workoutTargetChart", "liveWorkoutTargetCard"
];

export function createLiveRideDashboard({ onClose, onStart, onStop } = {}) {
    const elements = {
        ...collectElements(DASHBOARD_ELEMENT_IDS),
        pipMetricInputs: collectNamedElements("pipMetric"),
        pipChartInputs: collectNamedElements("pipChart")
    };
    bind(elements.closeRideDashboardBtn, "click", onClose);
    bind(elements.startRideDashboardBtn, "click", onStart);
    bind(elements.stopRideDashboardBtn, "click", onStop);
    return { elements };
}

function bind(element, event, handler) {
    if (handler) element?.addEventListener(event, handler);
}
