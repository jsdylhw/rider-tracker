import { createRouteDetailsRenderer } from "./route-details-renderer.js";
import { createRouteElevationChartRenderer } from "./route-elevation-chart-renderer.js";
import { createRouteInputController } from "./route-input-controller.js";
import { createAgentRoutePlanner } from "./agent-route-planner.js";
import { createRouteLibraryRenderer } from "./route-library-renderer.js";

export function createRouteRenderer({
    elements,
    rideVisuals,
    // Compatibility for focused renderer tests while callers move to rideVisuals.
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onListSavedRoutes,
    onLoadSavedRoute,
    onContinueSavedRoute,
    onSaveCurrentRoute,
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
        onLoadSavedRoute: (routeId) => loadLibraryRoute(onLoadSavedRoute, routeId),
        onContinueSavedRoute: (routeId) => loadLibraryRoute(onContinueSavedRoute, routeId),
        onSaveCurrentRoute,
        onDeleteSavedRoute
    });

    routeInputController.bindEvents();
    routeDetailsRenderer.bindEvents();
    agentRoutePlanner.bindEvents();
    routeLibraryRenderer.bindEvents();

    function render(state) {
        routeInputController.render(state);
        routeDetailsRenderer.render(state);
        agentRoutePlanner.render(state);
        routeLibraryRenderer.render(state);
    }

    async function loadLibraryRoute(loader, routeId) {
        const route = await loader?.(routeId);
        const mode = routeModeForSource(route?.source);
        if (mode) routeInputController.setInputMode(mode);
        return route;
    }

    return {
        render,
        renderElevationChart: routeElevationChartRenderer.render,
        destroy: agentRoutePlanner.destroy
    };
}

function routeModeForSource(source) {
    return {
        "agent-planned": "ai",
        gpx: "gpx",
        "map-drawn": "draw",
        "osm-exploration": "map",
        manual: "manual"
    }[source] ?? null;
}
