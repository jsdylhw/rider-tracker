import { createMapController } from "./map-controller.js";
import {
    buildStreetViewTargetFromRoute,
    createStreetViewController,
    loadGoogleMapsForStreetView
} from "./street-view-controller.js";

export function createRideVisualsController({ elements, googleMapsConfig = null }) {
    const mapController = createMapController({
        previewElement: elements.routeMapPreview,
        dashboardElement: elements.rideDashboardMap
    });
    let streetViewController = null;

    async function enableStreetView({ apiKey, container1, container2 }) {
        await loadGoogleMapsForStreetView(apiKey);
        googleMapsConfig?.lockApiKey?.(apiKey);
        streetViewController?.destroy();
        streetViewController = createStreetViewController({ container1, container2 });
    }

    async function enableConfiguredStreetView({ container1, container2 }) {
        const apiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!apiKey) {
            return { enabled: false, reason: "missing-key" };
        }
        if (!streetViewController) {
            await enableStreetView({ apiKey, container1, container2 });
        }
        return { enabled: true };
    }

    function hasStreetView() {
        return streetViewController !== null;
    }

    function getGoogleMapsConfig() {
        return googleMapsConfig?.getConfig?.() ?? null;
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

    function invalidateDashboardSize() {
        mapController.invalidateDashboardSize();
    }

    function invalidateStreetViewSize() {
        streetViewController?.invalidateSize?.();
    }

    function destroy() {
        streetViewController?.destroy();
        streetViewController = null;
    }

    return {
        enableStreetView,
        enableConfiguredStreetView,
        hasStreetView,
        getGoogleMapsConfig,
        syncRoute,
        syncMap,
        syncStreetView,
        setPlannerClickHandler,
        setPlannerMode,
        syncPlannerSelection,
        invalidatePreviewSize,
        invalidateDashboardSize,
        invalidateStreetViewSize,
        destroy
    };
}
