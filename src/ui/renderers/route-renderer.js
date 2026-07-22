import { createRouteDetailsRenderer } from "./route-details-renderer.js";
import { createRouteElevationChartRenderer } from "./route-elevation-chart-renderer.js";
import { createRouteInputController } from "./route-input-controller.js";

export function createRouteRenderer({
    elements,
    rideVisuals,
    // Compatibility for focused renderer tests while callers move to rideVisuals.
    mapController,
    onAddSegment,
    onResetRoute,
    onImportGpx,
    onInvalidateMapRoute,
    onPlanMapRoute,
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
        onInvalidateMapRoute,
        onPlanMapRoute,
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

    routeInputController.bindEvents();
    routeDetailsRenderer.bindEvents();

    function render(state) {
        routeInputController.render(state);
        routeDetailsRenderer.render(state);
    }

    return {
        render,
        renderElevationChart: routeElevationChartRenderer.render
    };
}
