import { buildRouteGeometryKey, collectRouteMapLatLngs, shouldFitPlannerSelection } from "../../src/ui/map/map-controller.js";
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
        }
    ]
};
