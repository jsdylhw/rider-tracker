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
    let streetViewMode = "moving";
    let streetViewGeneration = 0;

    async function enableStreetView({ apiKey, container1, container2, mode = streetViewMode }) {
        const generation = ++streetViewGeneration;
        await loadGoogleMapsForStreetView(apiKey);
        if (generation !== streetViewGeneration) {
            return { enabled: false, reason: "stale-request" };
        }
        googleMapsConfig?.lockApiKey?.(apiKey);
        streetViewController?.destroy();
        streetViewMode = mode;
        streetViewController = createStreetViewController({ container1, container2, mode });
        return { enabled: true };
    }

    async function enableConfiguredStreetView({ container1, container2 }) {
        const apiKey = googleMapsConfig?.getApiKey?.() ?? "";
        if (!apiKey) {
            return { enabled: false, reason: "missing-key" };
        }
        if (!streetViewController) {
            return enableStreetView({ apiKey, container1, container2 });
        }
        return { enabled: true };
    }

    function setStreetViewMode(mode, { container1, container2 } = {}) {
        if (!["moving", "stable"].includes(mode) || !container1) return false;
        if (streetViewMode === mode && streetViewController) return true;
        streetViewController?.destroy();
        streetViewMode = mode;
        streetViewController = createStreetViewController({ container1, container2, mode });
        return true;
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

    function resetStreetView() {
        streetViewGeneration += 1;
        streetViewController?.destroy();
        streetViewController = null;
        streetViewMode = "moving";
    }

    function destroy() {
        resetStreetView();
    }

    return {
        enableStreetView,
        enableConfiguredStreetView,
        setStreetViewMode,
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
        resetStreetView,
        destroy
    };
}
