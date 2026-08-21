import { createRouteDetailsRenderer } from "./route-details-renderer.js";
import { createRouteElevationChartRenderer } from "./route-elevation-chart-renderer.js";
import { createRouteInputController } from "./route-input-controller.js";
import { createAgentRoutePlanner } from "./agent-route-planner.js";

export function createRouteRenderer({
    elements,
    rideVisuals,
    // Compatibility for focused renderer tests while callers move to rideVisuals.
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onCreateMapDrawRoute,
    onPlanAgentRoutes,
    onRestoreAgentRouteDraft,
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
    const routeInputController = createRouteInputController({
        elements,
        visuals,
        onCreateMapDrawRoute,
        onInvalidateMapRoute,
        onPlanMapRoute,
        onRequestRouteElevation,
        requestGoogleMapsApiKey,
        onInputModeChange: (state) => routeDetailsRenderer?.render(state)
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
    const agentRoutePlanner = createAgentRoutePlanner({
        elements,
        onPlanAgentRoutes,
        onRestoreAgentRouteDraft,
        onPreviewAgentRoute,
        onConfirmAgentRoute,
        onExploreAgentRouteSegments,
        onComposeAgentRouteSegments,
        onReverseAgentRoute,
        onUndoAgentRoute,
    });

    routeInputController.bindEvents();
    routeDetailsRenderer.bindEvents();
    agentRoutePlanner.bindEvents();

    function render(state) {
        routeInputController.render(state);
        routeDetailsRenderer.render(state);
        agentRoutePlanner.render(state);
    }

    return {
        render,
        renderElevationChart: routeElevationChartRenderer.render,
        destroy: agentRoutePlanner.destroy
    };
}
