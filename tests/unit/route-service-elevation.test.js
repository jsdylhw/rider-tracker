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
            name: "loads a saved GPX route without requesting elevation again",
            async run() {
                const savedRoute = createCoordinateRoute();
                const store = createStore({ route: null, liveRide: { isActive: false, session: null } });
                const service = createRouteService({
                    store,
                    routeLibrary: {
                        async loadSavedRoute(id) {
                            return { id, importFileName: "saved-climb", route: savedRoute };
                        },
                        async listSavedGpxRoutes() { return []; },
                        async saveGpxRoute() { return null; },
                        async deleteSavedRoute() { return null; }
                    }
                });

                await service.loadSavedGpxRoute("route-123");

                assertEqual(store.getState().route.libraryRouteId, "route-123");
                assertEqual(store.getState().route.importFileName, "saved-climb");
                assertEqual(store.getState().route.hasElevationData, false);
                assert(store.getState().statusText.includes("已从起点加载"));
            }
        },
        {
            name: "continues a saved GPX route from its recorded position",
            async run() {
                const savedRoute = createCoordinateRoute();
                const store = createStore({ route: null, liveRide: { isActive: false, session: null } });
                const service = createRouteService({
                    store,
                    routeLibrary: {
                        async loadSavedRoute(id) {
                            return { id, importFileName: "saved-climb", resumeDistanceMeters: 500, route: savedRoute };
                        },
                        async listSavedGpxRoutes() { return []; },
                        async saveGpxRoute() { return null; },
                        async deleteSavedRoute() { return null; },
                        async updateSavedRouteResumeDistance() { return null; }
                    }
                });

                await service.continueSavedGpxRoute("route-123");

                assertEqual(store.getState().route.continuation.startDistanceMeters, 500);
                assertEqual(store.getState().route.libraryRouteId, "route-123");
                assertEqual(store.getState().route.totalDistanceMeters, 500);
                assert(store.getState().statusText.includes("已从 0.50 km 继续"));
            }
        },
        {
            name: "stores unfinished GPX progress in the route library",
            async run() {
                const updates = [];
                const store = createStore({ route: null, liveRide: { isActive: false, session: null } });
                const service = createRouteService({
                    store,
                    routeLibrary: {
                        async saveGpxRoute() { return null; },
                        async listSavedGpxRoutes() { return []; },
                        async loadSavedRoute() { return null; },
                        async deleteSavedRoute() { return null; },
                        async updateSavedRouteResumeDistance(id, distanceMeters) {
                            updates.push({ id, distanceMeters });
                        }
                    }
                });
                const route = {
                    ...createCoordinateRoute(),
                    libraryRouteId: "route-123",
                    routeLibraryResumeDistanceMeters: 0
                };

                await service.updateSavedGpxRouteProgress({ route, sessionDistanceMeters: 300 });

                assertEqual(updates.length, 1);
                assertEqual(updates[0].id, "route-123");
                assertEqual(updates[0].distanceMeters, 300);
            }
        },
        {
            name: "clears an old resume position when a restarted GPX route is completed",
            async run() {
                const updates = [];
                const store = createStore({ route: null, liveRide: { isActive: false, session: null } });
                const service = createRouteService({
                    store,
                    routeLibrary: {
                        async saveGpxRoute() { return null; },
                        async listSavedGpxRoutes() { return []; },
                        async loadSavedRoute() { return null; },
                        async deleteSavedRoute() { return null; },
                        async updateSavedRouteResumeDistance(id, distanceMeters) {
                            updates.push({ id, distanceMeters });
                        }
                    }
                });
                const route = {
                    ...createCoordinateRoute(),
                    libraryRouteId: "route-123",
                    routeLibraryResumeDistanceMeters: 500
                };

                await service.updateSavedGpxRouteProgress({ route, sessionDistanceMeters: 1000 });

                assertEqual(updates.length, 1);
                assertEqual(updates[0].distanceMeters, 0);
            }
        },
        {
            name: "keeps a GPX usable when route library saving fails",
            async run() {
                const store = createStore({ route: null, liveRide: { isActive: false, session: null } });
                const service = createRouteService({
                    store,
                    routeLibrary: {
                        async saveGpxRoute() { throw new Error("database unavailable"); },
                        async listSavedGpxRoutes() { return []; },
                        async loadSavedRoute() { return null; },
                        async deleteSavedRoute() { return null; }
                    }
                });
                const file = {
                    name: "fallback.gpx",
                    async text() {
                        return `<?xml version="1.0"?><gpx><trk><name>Fallback</name><trkseg>
                            <trkpt lat="35.0" lon="135.0"><ele>10</ele></trkpt>
                            <trkpt lat="35.001" lon="135.001"><ele>20</ele></trkpt>
                        </trkseg></trk></gpx>`;
                    }
                };

                await service.importGpx(file);

                assertEqual(store.getState().route.source, "gpx");
                assertEqual(store.getState().route.libraryRouteId, undefined);
                assert(store.getState().statusText.includes("路线库保存失败"));
            }
        },
        {
            name: "falls back to the synthetic grid when Overpass returns an unroutable response",
            async run() {
                const store = createStore({
                    route: null,
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
            name: "keeps initial exploration elevation opt-in while retaining dense samples",
            async run() {
                const store = createStore({
                    route: null,
                    liveRide: { isActive: false, session: null }
                });
                let loadedKey = "";
                let elevationRequestPoints = [];
                const service = createRouteService({
                    store,
                    googleMapsConfig: {
                        getApiKey: () => "test-key",
                        lockApiKey() {}
                    },
                    fetchRoadNetwork: async (bounds) => buildSyntheticGridRoadNetwork(bounds, { lineCount: 5 }),
                    loadGoogleMaps: async (key) => { loadedKey = key; },
                    enrichElevation: async (points) => {
                        elevationRequestPoints = points;
                        return {
                            points: points.map((point, index) => ({
                                ...point,
                                elevationMeters: 30 + index,
                                gradePercent: index === 0 ? 0 : 1.2,
                                elevationLoaded: true
                            })),
                            hasElevationData: true,
                            summary: { requests: 1, requestedPoints: points.length, cacheHits: 0, skippedByQuota: false }
                        };
                    }
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });
                const initialRoute = store.getState().route;

                assertEqual(loadedKey, "");
                assertEqual(initialRoute.hasElevationData, false);
                assert(initialRoute.points[1].distanceMeters <= 20, "探索海拔采样应使用 20m 间隔");

                await service.requestCurrentRouteElevation();
                const route = store.getState().route;
                assertEqual(loadedKey, "test-key");
                assertEqual(route.hasElevationData, true);
                assertGreaterThan(elevationRequestPoints.length, 2);
                assert(store.getState().statusText.includes("路线海拔已更新"));
            }
        },
        {
            name: "重选路线会清空当前路线并复用范围内已加载的 OSM 路网",
            async run() {
                const store = createStore({
                    route: null,
                    liveRide: { isActive: false, session: null }
                });
                let fetchCount = 0;
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: async (bounds) => {
                        fetchCount += 1;
                        const fallback = buildSyntheticGridRoadNetwork(bounds, { lineCount: 5 });
                        return { elements: fallback.elements };
                    }
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });
                assertEqual(fetchCount, 1);

                service.invalidatePendingMapRoute();
                assertEqual(store.getState().route.source, "manual");
                assertEqual(store.getState().route.totalDistanceMeters, 0);

                await service.planMapRoute({
                    start: { lat: 37.002, lng: -122.001 },
                    destination: { lat: 37.003, lng: -121.998 }
                });

                assertEqual(fetchCount, 1);
                assertEqual(store.getState().route.source, "osm-exploration");
                assert(store.getState().statusText.includes("已复用已加载的 OSM 路网"));
            }
        },
        {
            name: "复用路网不会将缓存范围扩大到新请求边界",
            async run() {
                const store = createStore({
                    route: null,
                    liveRide: { isActive: false, session: null }
                });
                let fetchCount = 0;
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: async (bounds) => {
                        fetchCount += 1;
                        const grid = buildSyntheticGridRoadNetwork(bounds, { lineCount: 13 });
                        return { elements: grid.elements };
                    }
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });
                await service.planMapRoute({
                    start: { lat: 37.04, lng: -122.0 },
                    destination: { lat: 37.041, lng: -121.999 }
                });
                assertEqual(fetchCount, 1);

                await service.planMapRoute({
                    start: { lat: 37.07, lng: -122.0 },
                    destination: { lat: 37.071, lng: -121.999 }
                });

                assertEqual(fetchCount, 2);
            }
        },
        {
            name: "consumes a queued exploration turn when the current segment reaches its end",
            async run() {
                const store = createStore({
                    route: null,
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
        },
        {
            name: "does not replace the active ride route while planning a map route",
            async run() {
                const route = createCoordinateRoute();
                const session = { route };
                const store = createStore({
                    route,
                    liveRide: { isActive: true, session }
                });
                const initialRoute = store.getState().route;
                const initialSession = store.getState().liveRide.session;
                let fetchCount = 0;
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: async () => {
                        fetchCount += 1;
                        return { elements: [] };
                    }
                });

                await service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });

                assertEqual(fetchCount, 0);
                assertEqual(store.getState().route, initialRoute);
                assertEqual(store.getState().liveRide.session, initialSession);
                assert(store.getState().statusText.includes("路线已锁定"));
            }
        },
        {
            name: "地图路线请求在骑行开始后返回时不会覆盖会话路线",
            async run() {
                const route = createCoordinateRoute();
                let resolveNetwork;
                const networkPromise = new Promise((resolve) => { resolveNetwork = resolve; });
                const session = { route };
                const store = createStore({
                    route,
                    liveRide: { isActive: false, session: null }
                });
                const service = createRouteService({
                    store,
                    fetchRoadNetwork: () => networkPromise
                });

                const planning = service.planMapRoute({
                    start: { lat: 37.0, lng: -122.0 },
                    destination: { lat: 37.001, lng: -121.999 }
                });
                assertEqual(store.getState().route.isLoading, true);
                store.setState((state) => ({
                    ...state,
                    liveRide: { ...state.liveRide, isActive: true, session }
                }));
                resolveNetwork(buildSyntheticGridRoadNetwork({
                    minLat: 36.999,
                    maxLat: 37.002,
                    minLng: -122.001,
                    maxLng: -121.998
                }));
                await planning;

                assertEqual(store.getState().route.source, "gpx");
                assertEqual(store.getState().route.isLoading, false);
                assertEqual(store.getState().liveRide.session.route, route);
                assert(store.getState().statusText.includes("已忽略未完成的地图路线"));
            }
        },
        {
            name: "海拔请求在骑行开始后返回时不会替换路线",
            async run() {
                const route = createCoordinateRoute();
                let resolveElevation;
                const elevationPromise = new Promise((resolve) => { resolveElevation = resolve; });
                const session = { route };
                const store = createStore({
                    route,
                    liveRide: { isActive: false, session: null }
                });
                const service = createRouteService({
                    store,
                    googleMapsConfig: {
                        getApiKey: () => "test-key",
                        lockApiKey() {}
                    },
                    loadGoogleMaps: async () => {},
                    enrichElevation: () => elevationPromise
                });

                const updating = service.requestCurrentRouteElevation();
                assertEqual(store.getState().route.isLoading, true);
                store.setState((state) => ({
                    ...state,
                    liveRide: { ...state.liveRide, isActive: true, session }
                }));
                resolveElevation({
                    points: route.points.map((point) => ({ ...point, elevationMeters: 50, elevationLoaded: true })),
                    hasElevationData: true,
                    summary: { requests: 1, requestedPoints: route.points.length, cacheHits: 0, skippedByQuota: false }
                });
                const result = await updating;

                assertEqual(result.updated, false);
                assertEqual(result.reason, "ride-active");
                assertEqual(store.getState().route.hasElevationData, false);
                assertEqual(store.getState().route.isLoading, false);
                assertEqual(store.getState().liveRide.session.route, route);
                assert(store.getState().statusText.includes("已忽略未完成的路线海拔请求"));
            }
        }
    ]
};
