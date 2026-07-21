import { createStore } from "../../src/app/store/app-store.js";
import { createRouteService } from "../../src/app/services/route-service.js";
import { buildRouteFromTrackPoints } from "../../src/domain/route/route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "../../src/domain/route/track-route.js";
import { buildSyntheticGridRoadNetwork } from "../../src/domain/route/osm-road-network.js";
import { assert, assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

function createCoordinateRoute() {
    const points = [
        { latitude: 31.1, longitude: 121.1, distanceMeters: 0, elevationMeters: 0, gradePercent: 0 },
        { latitude: 31.101, longitude: 121.101, distanceMeters: 500, elevationMeters: 0, gradePercent: 0 },
        { latitude: 31.102, longitude: 121.102, distanceMeters: 1000, elevationMeters: 0, gradePercent: 0 }
    ];
    return buildRouteFromTrackPoints({
        source: "gpx",
        name: "无海拔 GPX",
        points,
        segments: buildSummarySegmentsFromTrackPoints(points, { hasElevationData: false }),
        hasElevationData: false
    });
}

export const suite = {
    name: "route-service-elevation",
    tests: [
        {
            name: "enriches the current coordinate route on demand before a ride starts",
            async run() {
                const route = createCoordinateRoute();
                const store = createStore({
                    route,
                    routeSegments: route.segments,
                    liveRide: { isActive: false }
                });
                let loadedKey = "";
                let lockedKey = "";
                const service = createRouteService({
                    store,
                    googleMapsConfig: {
                        getApiKey: () => "test-key",
                        lockApiKey: (key) => { lockedKey = key; }
                    },
                    loadGoogleMaps: async (key) => { loadedKey = key; },
                    enrichElevation: async (points) => ({
                        points: points.map((point, index) => ({
                            ...point,
                            elevationMeters: 20 + index * 8,
                            gradePercent: index === 0 ? 0 : 1.6,
                            elevationLoaded: true
                        })),
                        hasElevationData: true,
                        summary: { requests: 1, requestedPoints: 3, cacheHits: 0, skippedByQuota: false }
                    })
                });

                const result = await service.requestCurrentRouteElevation();
                const updatedRoute = store.getState().route;

                assertEqual(result.updated, true);
                assertEqual(loadedKey, "test-key");
                assertEqual(lockedKey, "test-key");
                assertEqual(updatedRoute.name, "无海拔 GPX");
                assertEqual(updatedRoute.hasElevationData, true);
                assertEqual(updatedRoute.points[2].elevationMeters, 36);
                assertEqual(updatedRoute.segments[0].gradePercent, 1.6);
            }
        },
        {
            name: "falls back to the synthetic grid when Overpass returns an unroutable response",
            async run() {
                const store = createStore({
                    route: null,
                    routeSegments: [],
                    liveRide: { isActive: false, session: null }
                });
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: async () => ({ elements: [] })
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });

                const route = store.getState().route;
                assertEqual(route.networkSource, "synthetic");
                assertGreaterThan(route.points.length, 2);
                assert(store.getState().statusText.includes("备用网格探索路线"));
            }
        },
        {
            name: "consumes a queued exploration turn when the current segment reaches its end",
            async run() {
                const store = createStore({
                    route: null,
                    routeSegments: [],
                    liveRide: { isActive: false, session: null }
                });
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: async (bounds) => buildSyntheticGridRoadNetwork(bounds, { lineCount: 5 })
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });
                const initialRoute = store.getState().route;
                service.queueExplorationTurn("straight");
                assertEqual(store.getState().route.exploration.pendingIntent, "straight");

                service.ensureExplorationRouteAhead({ distanceMeters: initialRoute.totalDistanceMeters });
                const extendedRoute = store.getState().route;

                assertGreaterThan(extendedRoute.totalDistanceMeters, initialRoute.totalDistanceMeters);
                assertEqual(extendedRoute.exploration.pendingIntent, null);
            }
        }
    ]
};
