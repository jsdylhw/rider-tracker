import { createRouteDetailsRenderer } from "./route-details-renderer.js";
import { createRouteElevationChartRenderer } from "./route-elevation-chart-renderer.js";
import { createRouteInputController } from "./route-input-controller.js";
import { createAgentRoutePlanner } from "./agent-route-planner.js";
import { createRouteLibraryRenderer } from "./route-library-renderer.js";
import { createStravaRouteImportRenderer } from "./strava-route-import-renderer.js";
import { createRouteLibrarySourceController } from "./route-library-source-controller.js";

export function createRouteRenderer({
    elements,
    rideVisuals,
    // Compatibility for focused renderer tests while callers move to rideVisuals.
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onListStravaRoutes,
    onRefreshStravaRoutes,
    onImportStravaRoute,
    onListSavedRoutes,
    onLoadSavedRoute,
    onContinueSavedRoute,
    onSaveCurrentRoute,
    onExportCurrentRouteGpx,
    onDeleteSavedRoute,
    onCreateMapDrawRoute,
    onPlanAgentRoutes,
    onPreviewAgentRoute,
    onConfirmAgentRoute,
    onExploreAgentRouteSegments,
    onComposeAgentRouteSegments,
    onReverseAgentRoute,
    onUndoAgentRoute,
    onInvalidateMapRoute,
    onPlanMapRoute,
    onRequestRouteElevation,
    requestGoogleMapsApiKey,
    onUpdateRouteSegment,
    onRemoveRouteSegment
}) {
    const visuals = rideVisuals ?? {
        syncRoute: (route) => mapController?.syncRoute?.(route),
        setPlannerClickHandler: (handler) => mapController?.setPlannerClickHandler?.(handler),
        setPlannerMode: (mode) => mapController?.setPlannerMode?.(mode),
        syncPlannerSelection: (selection) => mapController?.syncPlannerSelection?.(selection),
        invalidatePreviewSize: () => mapController?.invalidatePreviewSize?.()
    };
    const hasRouteModeControls = Boolean(elements.routeModeMapBtn || elements.mapRoutePanel);
    let routeDetailsRenderer;
    let routeLibrarySourceController;
    const routeInputController = createRouteInputController({
        elements,
        visuals,
        onCreateMapDrawRoute,
        onInvalidateMapRoute,
        onPlanMapRoute,
        onRequestRouteElevation,
        requestGoogleMapsApiKey,
        onInputModeChange: (state) => {
            routeDetailsRenderer?.render(state);
            if (routeInputController.getInputMode() === "library") {
                activateCurrentLibrarySource();
            }
        }
    });
    routeDetailsRenderer = createRouteDetailsRenderer({
        elements,
        hasRouteModeControls,
        onAddSegment,
        onResetRoute,
        onImportGpx,
        onUpdateRouteSegment,
        onRemoveRouteSegment,
        getInputMode: routeInputController.getInputMode
    });
    const routeElevationChartRenderer = createRouteElevationChartRenderer({ elements });
    const stravaRouteImportRenderer = createStravaRouteImportRenderer({
        elements,
        onListStravaRoutes,
        onRefreshStravaRoutes,
        onImportStravaRoute
    });
    const agentRoutePlanner = createAgentRoutePlanner({
        elements,
        onPlanAgentRoutes,
        onPreviewAgentRoute,
        onConfirmAgentRoute,
        onExploreAgentRouteSegments,
        onComposeAgentRouteSegments,
        onReverseAgentRoute,
        onUndoAgentRoute,
    });
    const routeLibraryRenderer = createRouteLibraryRenderer({
        elements,
        onListSavedRoutes,
        onLoadSavedRoute,
        onContinueSavedRoute,
        onSaveCurrentRoute,
        onExportCurrentRouteGpx,
        onDeleteSavedRoute
    });
    routeLibrarySourceController = createRouteLibrarySourceController({
        elements,
        onShowLocalRoutes: () => routeLibraryRenderer.ensureLoaded(),
        onShowStravaRoutes: () => stravaRouteImportRenderer.ensureLoaded()
    });

    routeInputController.bindEvents();
    routeDetailsRenderer.bindEvents();
    stravaRouteImportRenderer.bindEvents();
    agentRoutePlanner.bindEvents();
    routeLibraryRenderer.bindEvents();
    routeLibrarySourceController.bindEvents();

    function render(state) {
        routeInputController.render(state);
        routeDetailsRenderer.render(state);
        stravaRouteImportRenderer.render(state);
        agentRoutePlanner.render(state);
        routeLibraryRenderer.render(state);
    }

    function activateCurrentLibrarySource() {
        const source = routeLibrarySourceController?.getSource();
        if (source === "local") void routeLibraryRenderer.ensureLoaded();
        if (source === "strava") void stravaRouteImportRenderer.ensureLoaded();
    }

    return {
        render,
        renderElevationChart: routeElevationChartRenderer.render,
        destroy: agentRoutePlanner.destroy
    };
}
