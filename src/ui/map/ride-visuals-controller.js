import { createMapController } from "./map-controller.js";
import {
    buildStreetViewTargetFromRoute,
    createStreetViewController,
    loadGoogleMapsForStreetView
} from "./street-view-controller.js";

export function createRideVisualsController({ elements }) {
    const mapController = createMapController({
        previewElement: elements.routeMapPreview,
        dashboardElement: elements.rideDashboardMap,
        initialProviderKey: elements.mapProviderSelect?.value
    });
    let streetViewController = null;

    async function enableStreetView({ apiKey, container1, container2 }) {
        await loadGoogleMapsForStreetView(apiKey);
        streetViewController?.destroy();
        streetViewController = createStreetViewController({ container1, container2 });
    }

    function hasStreetView() {
        return streetViewController !== null;
    }

    function syncRoute(route) {
        mapController.syncRoute(route);
    }

    function syncMap(route, currentRecord) {
        mapController.syncRide(route, currentRecord);
    }

    function syncStreetView(route, currentRecord) {
        const target = buildStreetViewTargetFromRoute(route, currentRecord);
        if (target) {
            streetViewController?.update(target);
        }
    }

    function setMapProvider(providerKey) {
        mapController.setMapProvider(providerKey);
    }

    function setPlannerClickHandler(handler) {
        mapController.setPlannerClickHandler(handler);
    }

    function setPlannerMode(mode) {
        mapController.setPlannerMode(mode);
    }

    function syncPlannerSelection(selection) {
        mapController.syncPlannerSelection(selection);
    }

    function invalidatePreviewSize() {
        mapController.invalidatePreviewSize();
    }

    function destroy() {
        streetViewController?.destroy();
        streetViewController = null;
    }

    return {
        enableStreetView,
        hasStreetView,
        syncRoute,
        syncMap,
        syncStreetView,
        setMapProvider,
        setPlannerClickHandler,
        setPlannerMode,
        syncPlannerSelection,
        invalidatePreviewSize,
        destroy
    };
}
