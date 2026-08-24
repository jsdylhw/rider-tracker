import { fetchOverpassRoadNetwork } from "../../adapters/osm/overpass-client.js";
import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";
import { enrichTrackPointsWithGoogleElevation } from "../../adapters/maps/google-elevation-client.js";
import { fetchGoogleBicycleRoute } from "../../adapters/maps/google-routes-client.js";
import { defaultRouteSegments } from "../store/initial-state.js";
import { createExplorationRouteService } from "./exploration-route-service.js";
import { createRouteEditorService } from "./route-editor-service.js";
import { createRouteElevationService } from "./route-elevation-service.js";
import { createMapDrawRouteService } from "./map-draw-route-service.js";
import { createAgentRoutePreviewService } from "./agent-route-preview-service.js";
import { createRouteOperationCoordinator } from "./route-operation-coordinator.js";
import {
    clearRouteProgress,
    deleteSavedRoute,
    listSavedRoutes,
    loadSavedRoute,
    renameSavedRoute,
    saveRoute,
    saveRouteProgress
} from "../../adapters/storage/route-library-client.js";

export function createRouteService({
    store,
    googleMapsConfig = null,
    fetchRoadNetwork = fetchOverpassRoadNetwork,
    fetchGoogleRoute = fetchGoogleBicycleRoute,
    loadGoogleMaps = loadGoogleMapsApi,
    enrichElevation = enrichTrackPointsWithGoogleElevation,
    routeLibrary = {
        saveRoute,
        listSavedRoutes,
        loadSavedRoute,
        renameSavedRoute,
        deleteSavedRoute,
        saveRouteProgress,
        clearRouteProgress
    }
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
        invalidateExploration: explorationService.clearActiveExploration,
        routeLibrary
    });
    const mapDrawRouteService = createMapDrawRouteService({
        store,
        operations,
        googleMapsConfig,
        fetchGoogleRoute,
        invalidateExploration: explorationService.clearActiveExploration
    });
    const agentRoutePreviewService = createAgentRoutePreviewService({
        store,
        operations,
        invalidateExploration: explorationService.clearActiveExploration,
        routeLibrary
    });

    return {
        ...editorService,
        ...mapDrawRouteService,
        ...agentRoutePreviewService,
        ...explorationService,
        releaseRouteAfterRide: () => {
            explorationService.clearActiveExploration();
            operations.invalidateRequests();
        },
        requestCurrentRouteElevation: elevationService.requestCurrentRouteElevation
    };
}
