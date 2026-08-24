import { collectElements } from "./view-elements.js";

const ROUTE_ELEMENT_IDS = [
    "routeCardContainer", "routeTableBody", "routeTableShell",
    "addSegmentBtn", "resetRouteBtn", "routeModeGpxBtn", "routeModeManualBtn",
    "routeModeAiBtn", "routeModeDrawBtn", "routeModeMapBtn", "routeLibraryToggleBtn",
    "routeLibraryPanel", "savedRouteLibraryStatus", "savedRouteSelect", "refreshSavedRoutesBtn",
    "loadSavedRouteBtn", "continueSavedRouteBtn", "saveCurrentRouteBtn", "deleteSavedRouteBtn",
    "aiRoutePanel", "aiRouteMessages", "aiRouteComposer", "aiRouteMessageInput", "aiRouteSendBtn",
    "aiRouteCandidates", "aiRouteResultTitle", "aiRouteResultStatus", "aiRouteReverseBtn",
    "aiRouteUndoBtn", "aiRouteExploreSegmentsBtn", "aiRouteSegmentPanel", "aiRouteSegmentList",
    "aiRouteSegmentSelection", "aiRouteComposeSegmentsBtn", "aiRouteClearSegmentsBtn",
    "gpxRoutePanel", "manualRoutePanel", "mapDrawRoutePanel", "mapRoutePanel", "gpxFileInput",
    "routeCurrentSourceRow", "routeSourceLabel", "routeMapPreview", "routeSummary", "routeMapShell",
    "setupElevationChartShell", "setupElevationChart", "undoMapDrawWaypointBtn",
    "clearMapDrawRouteBtn", "createMapDrawRouteBtn", "requestMapDrawElevationBtn",
    "mapDrawRouteStatus", "mapDrawWaypointSummary", "mapDrawRoutePlanStatus",
    "clearMapRouteSelectionBtn", "planMapRouteBtn", "mapRouteSelectionStatus",
    "mapRouteStartText", "mapRouteDestinationText", "mapRoutePlanStatus",
    "googleMapsServiceOverlay", "googleMapsServiceTitle", "googleMapsServiceDescription",
    "googleMapsServiceApiKeyInput", "googleMapsServiceStatus", "confirmGoogleMapsServiceBtn",
    "cancelGoogleMapsServiceBtn", "closeGoogleMapsServiceBtn"
];

export function createRouteWorkspaceView() {
    return {
        elements: {
            ...collectElements(ROUTE_ELEMENT_IDS),
            aiRoutePromptButtons: [...document.querySelectorAll("[data-ai-route-prompt]")]
        }
    };
}
