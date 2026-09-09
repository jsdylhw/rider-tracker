import {
    canExportRouteAsGpx,
    routeGpxFileName,
    serializeRouteToGpx
} from "../../src/domain/route/gpx-exporter.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "gpx-exporter",
    tests: [
        {
            name: "exports a selected AI preview without inventing elevation",
            run() {
                const route = coordinateRoute({
                    source: "agent-planned",
                    name: "海岸 & 山线",
                    isDraft: true,
                    hasElevationData: false
                });

                const xml = serializeRouteToGpx(route);

                assertEqual(canExportRouteAsGpx(route), true);
                assert(xml.includes("<name>海岸 &amp; 山线</name>"));
                assert(xml.includes('<trkpt lat="35.000000" lon="139.000000">'));
                assert(!xml.includes("<ele>"), "A route without elevation must omit GPX elevation elements.");
            }
        },
        {
            name: "exports reliable route elevation and a safe file name",
            run() {
                const route = coordinateRoute({
                    name: '富士/山:*?路线',
                    hasElevationData: true,
                    points: [
                        { latitude: 35, longitude: 139, elevationMeters: 42.26 },
                        { latitude: 35.1, longitude: 139.1, elevationMeters: 105.04 }
                    ]
                });

                const xml = serializeRouteToGpx(route);

                assert(xml.includes("<ele>42.3</ele>"));
                assert(xml.includes("<ele>105.0</ele>"));
                assertEqual(routeGpxFileName(route), "富士-山---路线.gpx");
            }
        },
        {
            name: "rejects loading and coordinate-less routes",
            run() {
                assertEqual(canExportRouteAsGpx(coordinateRoute({ isLoading: true })), false);
                assertEqual(canExportRouteAsGpx({
                    name: "Manual",
                    totalDistanceMeters: 1000,
                    points: []
                }), false);

                let message = "";
                try {
                    serializeRouteToGpx({ totalDistanceMeters: 1000, points: [] });
                } catch (error) {
                    message = error.message;
                }
                assertEqual(message, "当前路线没有可导出的坐标轨迹。");
            }
        }
    ]
};

function coordinateRoute(overrides = {}) {
    return {
        source: "map-drawn",
        name: "测试路线",
        totalDistanceMeters: 12000,
        hasElevationData: false,
        points: [
            { latitude: 35, longitude: 139, elevationMeters: 0 },
            { latitude: 35.1, longitude: 139.1, elevationMeters: 0 }
        ],
        ...overrides
    };
}
