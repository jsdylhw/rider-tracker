import { buildMapDrawRoute } from "../../src/domain/route/map-draw-route.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "map-draw-route",
    tests: [
        {
            name: "builds a road route from every selected map waypoint",
            run() {
                const route = buildMapDrawRoute({
                    waypoints: [
                        { lat: 31.199, lng: 121.399 },
                        { lat: 31.2, lng: 121.41 },
                        { lat: 31.21, lng: 121.41 }
                    ],
                    routePath: [
                        { lat: 31.2, lng: 121.4 },
                        { lat: 31.2005, lng: 121.405 },
                        { lat: 31.2, lng: 121.41 },
                        { lat: 31.21, lng: 121.41 }
                    ],
                    totalDistanceMeters: 2400
                });

                assertEqual(route.source, "map-drawn");
                assertEqual(route.hasElevationData, false);
                assertEqual(route.waypoints.length, 3);
                assertEqual(route.mapGeometry.length, 4);
                assert(route.waypointSnaps[0].offsetMeters > 0, "应记录原始选点到道路路线的吸附距离");
                assertEqual(route.waypointSnaps[0].snapped.lat, 31.2);
                assertEqual(route.points[0].distanceMeters, 0);
                assertEqual(route.totalDistanceMeters, 2400);
                assertEqual(route.points.at(-1).distanceMeters, route.totalDistanceMeters);
                assert(route.points.some((point) => point.latitude === 31.2 && point.longitude === 121.41), "途经点应保留在采样路线中");
                assert(route.points.every((point) => point.gradePercent === 0), "未请求海拔时坡度应为 0");
            }
        },
        {
            name: "removes consecutive duplicate waypoints and rejects a single distinct point",
            run() {
                const route = buildMapDrawRoute({
                    waypoints: [
                        { lat: 31.2, lng: 121.4 },
                        { lat: 31.2, lng: 121.4 },
                        { lat: 31.201, lng: 121.401 }
                    ],
                    routePath: [
                        { lat: 31.2, lng: 121.4 },
                        { lat: 31.201, lng: 121.401 }
                    ]
                });
                assertEqual(route.waypoints.length, 2);

                let error = null;
                try {
                    buildMapDrawRoute({
                        waypoints: [{ lat: 31.2, lng: 121.4 }],
                        routePath: [{ lat: 31.2, lng: 121.4 }]
                    });
                } catch (caught) {
                    error = caught;
                }
                assert(Boolean(error), "单个选点不能生成路线");
            }
        }
    ]
};
