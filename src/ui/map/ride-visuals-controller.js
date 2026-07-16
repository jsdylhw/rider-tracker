import { createMapController } from "./map-controller.js";
import { createStreetViewController, loadGoogleMapsForStreetView } from "./street-view-controller.js";

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
        streetViewController?.update(route, currentRecord);
    }

    function setMapProvider(providerKey) {
        mapController.setMapProvider(providerKey);
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
        destroy
    };
}
