import { createMapController } from "./map-controller.js";
import {
    buildStreetViewTargetFromRoute,
    createStreetViewController,
    loadGoogleMapsForStreetView
} from "./street-view-controller.js";
import { createStreetViewRuntimeTrace } from "./street-view-runtime-trace.js";
import { downloadJson } from "../../shared/format.js";

export function createRideVisualsController({ elements, googleMapsConfig = null }) {
    const mapController = createMapController({
        previewElement: elements.routeMapPreview,
        dashboardElement: elements.rideDashboardMap
    });
    let streetViewController = null;
    const streetViewTrace = createStreetViewRuntimeTrace();

    async function enableStreetView({ apiKey, container1, container2 }) {
        await loadGoogleMapsForStreetView(apiKey);
        googleMapsConfig?.lockApiKey?.(apiKey);
        streetViewController?.destroy();
        streetViewTrace.clear();
        streetViewTrace.record({
            event: "street-view-enable",
            message: "街景服务初始化完成，准备创建 controller",
            hasConfiguredApiKey: Boolean(apiKey)
        });
        streetViewController = createStreetViewController({
            container1,
            container2,
            onTrace: streetViewTrace.record
        });
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

    function downloadStreetViewTrace() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(`rider-tracker-street-view-trace-${timestamp}.json`, streetViewTrace.snapshot());
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
        downloadStreetViewTrace,
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
