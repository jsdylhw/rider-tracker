import { fetchOverpassRoadNetwork } from "../../adapters/osm/overpass-client.js";
import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";
import { enrichTrackPointsWithGoogleElevation } from "../../adapters/maps/google-elevation-client.js";
import { defaultRouteSegments } from "../store/initial-state.js";
import { createExplorationRouteService } from "./exploration-route-service.js";
import { createRouteEditorService } from "./route-editor-service.js";
import { createRouteElevationService } from "./route-elevation-service.js";
import { createRouteOperationCoordinator } from "./route-operation-coordinator.js";

export function createRouteService({
    store,
    googleMapsConfig = null,
    fetchRoadNetwork = fetchOverpassRoadNetwork,
    loadGoogleMaps = loadGoogleMapsApi,
    enrichElevation = enrichTrackPointsWithGoogleElevation
}) {
    const operations = createRouteOperationCoordinator({ store });
    let elevationService;
    const explorationService = createExplorationRouteService({
        store,
        operations,
        fetchRoadNetwork,
        enrichRoute: (route) => elevationService.enrichRoute(route)
    });
    elevationService = createRouteElevationService({
        store,
        operations,
        googleMapsConfig,
        loadGoogleMaps,
        enrichElevation,
        onExplorationElevationRequested: explorationService.markElevationRequested
    });
    const editorService = createRouteEditorService({
        store,
        operations,
        defaultRouteSegments,
        invalidateExploration: explorationService.clearActiveExploration
    });

    return {
        ...editorService,
        ...explorationService,
        requestCurrentRouteElevation: elevationService.requestCurrentRouteElevation
    };
}
