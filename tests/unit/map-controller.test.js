import {
    buildRouteGeometryKey,
    collectRouteMapLatLngs,
    createMapController,
    shouldFitPlannerSelection
} from "../../src/ui/map/map-controller.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "map-controller",
    tests: [
        {
            name: "uses route geometry rather than metadata to detect a new path",
            run() {
                const route = {
                    source: "osm-map",
                    name: "OSM 地图规划路线",
                    totalDistanceMeters: 1000
                };
                const firstPath = [[31.2, 121.4], [31.21, 121.41]];
                const secondPath = [[31.2, 121.4], [31.19, 121.39]];

                const firstKey = buildRouteGeometryKey(route, firstPath);
                const secondKey = buildRouteGeometryKey(route, secondPath);

                assert(firstKey !== secondKey);
                assertEqual(firstKey, buildRouteGeometryKey({ ...route, totalDistanceMeters: 1000.1 }, firstPath));
            }
        },
        {
            name: "keeps a distinct key when an OSM route has additional road-turn geometry",
            run() {
                const route = { source: "osm-map" };
                const sampledPath = [[31.2, 121.4], [31.21, 121.41]];
                const roadGeometry = [[31.2, 121.4], [31.2, 121.41], [31.21, 121.41]];

                assert(buildRouteGeometryKey(route, sampledPath) !== buildRouteGeometryKey(route, roadGeometry));
            }
        },
        {
            name: "preserves the generated route view after both planner points are selected",
            run() {
                assertEqual(shouldFitPlannerSelection({ hasVisibleRoute: false }, 2), true);
                assertEqual(shouldFitPlannerSelection({ hasVisibleRoute: true }, 2), false);
            }
        },
        {
            name: "draws OSM road geometry even when it uses lat/lng keys",
            run() {
                const route = {
                    mapGeometry: [
                        { lat: 31.2304, lng: 121.4737 },
                        { lat: 31.2312, lng: 121.4748 },
                        { lat: 31.2321, lng: 121.4761 }
                    ],
                    points: [
                        { latitude: 0, longitude: 0 },
                        { latitude: 1, longitude: 1 }
                    ]
                };

                const points = collectRouteMapLatLngs(route);
                assertEqual(points.length, 3);
                assertEqual(points[1][0], 31.2312);
                assertEqual(points[1][1], 121.4748);
            }
        },
        {
            name: "falls back to sampled route points when map geometry has invalid coordinates",
            run() {
                const route = {
                    mapGeometry: [
                        { latitude: null, longitude: null },
                        { latitude: undefined, longitude: undefined }
                    ],
                    points: [
                        { latitude: 31.2304, longitude: 121.4737 },
                        { latitude: 31.2312, longitude: 121.4748 }
                    ]
                };

                const points = collectRouteMapLatLngs(route);
                assertEqual(points.length, 2);
                assertEqual(points[0][0], 31.2304);
                assertEqual(points[1][1], 121.4748);
            }
        },
        {
            name: "keeps a GPX route visible after its preview map becomes measurable",
            run() {
                const originalWindow = globalThis.window;
                const originalAnimationFrame = globalThis.requestAnimationFrame;
                const polylineCalls = [];
                const circleMarkerCalls = [];
                let fitBoundsCount = 0;
                let invalidateSizeCount = 0;
                let lastBounds = null;
                const map = {
                    attributionControl: { removeAttribution() {}, addAttribution() {} },
                    on() {},
                    setView() {},
                    invalidateSize() { invalidateSizeCount += 1; },
                    fitBounds(bounds) { fitBoundsCount += 1; lastBounds = bounds; },
                    panTo() {}
                };
                const makeLayer = (points, options) => ({
                    points,
                    options,
                    addTo() { return this; },
                    bindTooltip() {},
                    setLatLng() { return this; },
                    setLatLngs(points) {
                        this.points = points;
                        this.setLatLngsCount = (this.setLatLngsCount ?? 0) + 1;
                        return this;
                    },
                    setStyle(style) { this.lastStyle = style; return this; },
                    bringToFront() {
                        this.bringToFrontCount = (this.bringToFrontCount ?? 0) + 1;
                        return this;
                    },
                    closeTooltip() {},
                    openTooltip() {},
                    remove() {}
                });
                globalThis.window = {
                    L: {
                        map: () => map,
                        tileLayer: () => makeLayer([], {}),
                        polyline(points, options) {
                            const layer = makeLayer(points, options);
                            polylineCalls.push(layer);
                            return layer;
                        },
                        circleMarker(point, options) {
                            const layer = makeLayer([point], options);
                            circleMarkerCalls.push(layer);
                            return layer;
                        },
                        latLngBounds: (points) => ({ points })
                    }
                };
                globalThis.requestAnimationFrame = (callback) => callback();

                try {
                    const controller = createMapController({ previewElement: {}, dashboardElement: {} });
                    controller.syncRoute({
                        source: "gpx",
                        points: [
                            { latitude: 31.2, longitude: 121.4 },
                            { latitude: 31.21, longitude: 121.41 },
                            { latitude: 31.22, longitude: 121.42 }
                        ]
                    });
                    const routeLayer = polylineCalls.find((layer) => layer.options.color === "#0ea5e9");

                    assert(routeLayer, "GPX should use the persistent route polyline");
                    assertEqual(routeLayer.options.pane, undefined);
                    assertEqual(routeLayer.points[2][0], 31.22);
                    assertEqual(routeLayer.points[2][1], 121.42);

                    const routeLayerRenderCount = routeLayer.setLatLngsCount;
                    const initialInvalidateSizeCount = invalidateSizeCount;
                    controller.syncRoute({
                        source: "gpx",
                        exploration: { pendingIntent: "left" },
                        points: [
                            { latitude: 31.2, longitude: 121.4 },
                            { latitude: 31.21, longitude: 121.41 },
                            { latitude: 31.22, longitude: 121.42 }
                        ]
                    });
                    assertEqual(routeLayer.setLatLngsCount, routeLayerRenderCount);
                    assertEqual(invalidateSizeCount, initialInvalidateSizeCount);

                    controller.invalidatePreviewSize();
                    assert(fitBoundsCount >= 3, "preview refresh should refit the GPX route after it becomes visible");

                    const dashboardOnlyRoute = {
                        source: "gpx",
                        points: [
                            { latitude: 35.1, longitude: 139.1 },
                            { latitude: 35.2, longitude: 139.2 }
                        ]
                    };
                    controller.syncRide(dashboardOnlyRoute, {
                        positionLat: 35.15,
                        positionLong: 139.15,
                        distanceKm: 0.5
                    });
                    controller.invalidateDashboardSize();

                    assert(polylineCalls.some((layer) => layer.points[0]?.[0] === 35.1),
                        "dashboard-only route updates should populate the dashboard route layer");
                    assertEqual(lastBounds.points[0][0], 35.1);
                    const currentMarker = circleMarkerCalls
                        .filter((layer) => layer.options.fillColor === "#3742fa")
                        .at(-1);
                    assert(currentMarker?.bringToFrontCount > 0, "current-position marker should remain above the route line");
                    assertEqual(currentMarker?.lastStyle?.opacity, 1);

                    controller.syncRoute({
                        source: "map-drawn",
                        mapGeometry: [{ lat: 31.2, lng: 121.4 }, { lat: 31.21, lng: 121.41 }],
                        waypointSnaps: [{
                            index: 1,
                            requested: { lat: 31.199, lng: 121.399 },
                            snapped: { lat: 31.2, lng: 121.4 },
                            offsetMeters: 150
                        }]
                    });
                    assert(circleMarkerCalls.some((layer) => layer.options.color === "#f59e0b"),
                        "map-drawn routes should retain an original-waypoint marker when Google snaps it to a road");
                    assert(polylineCalls.some((layer) => layer.options.color === "#f59e0b" && layer.options.dashArray === "5 7"),
                        "map-drawn routes should show a dashed connector to the snapped road point");
                } finally {
                    globalThis.window = originalWindow;
                    globalThis.requestAnimationFrame = originalAnimationFrame;
                }
            }
        }
    ]
};
