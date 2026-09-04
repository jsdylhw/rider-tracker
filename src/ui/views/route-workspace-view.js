import { collectElements } from "./view-elements.js";

const ROUTE_ELEMENT_IDS = [
    "routeCardContainer", "routeTableBody", "routeTableShell",
    "addSegmentBtn", "resetRouteBtn", "routeModeLibraryBtn", "routeModeManualBtn",
    "routeModeAiBtn", "routeModeDrawBtn", "routeModeMapBtn", "exportCurrentRouteGpxBtn",
    "routeLibraryPanel", "savedRouteLibraryStatus", "savedRouteSelect", "refreshSavedRoutesBtn",
    "loadSavedRouteBtn", "continueSavedRouteBtn", "saveCurrentRouteBtn", "deleteSavedRouteBtn",
    "routeLibraryLocalTabBtn", "routeLibraryStravaTabBtn", "routeLibraryGpxTabBtn",
    "routeLibraryLocalPanel", "routeLibraryStravaPanel", "routeLibraryGpxPanel",
    "aiRoutePanel", "aiRouteMessages", "aiRouteComposer", "aiRouteMessageInput", "aiRouteSendBtn",
    "aiRouteCandidates", "aiRouteResultTitle", "aiRouteResultStatus", "aiRouteReverseBtn",
    "aiRouteUndoBtn", "aiRouteExploreSegmentsBtn", "aiRouteSegmentPanel", "aiRouteSegmentList",
    "aiRouteSegmentSelection", "aiRouteComposeSegmentsBtn", "aiRouteClearSegmentsBtn",
    "manualRoutePanel", "mapDrawRoutePanel", "mapRoutePanel", "gpxFileInput",
    "refreshStravaRoutesBtn", "stravaRouteSelect", "importStravaRouteBtn", "stravaRouteImportStatus",
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
