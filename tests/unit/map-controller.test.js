import { buildRouteGeometryKey } from "../../src/ui/map/map-controller.js";
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
        }
    ]
};
