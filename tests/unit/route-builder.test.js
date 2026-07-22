import {
    buildRoute,
    buildRouteFromTrackPoints,
    getForwardRouteSpeedLimitAhead,
    getMinimumCurveSpeedLimitAhead,
    getRouteSampleAtDistance,
    getSegmentAtDistance,
    sanitizeSegments
} from "../../src/domain/route/route-builder.js";
import {
    assert,
    assertApprox,
    assertEqual,
    assertGreaterThan
} from "../helpers/test-harness.js";

export const suite = {
    name: "route-builder",
    tests: [
        {
            name: "sanitizeSegments clamps invalid values and fills names",
            run() {
                const segments = sanitizeSegments([
                    { distanceKm: -2, gradePercent: 100 },
                    { name: "", distanceKm: 0.5, gradePercent: -20 }
                ]);

                assertEqual(segments.length, 2);
                assertEqual(segments[0].distanceKm, 0.1);
                assertEqual(segments[0].gradePercent, 20);
                assertEqual(segments[0].name, "路段 1");
                assertEqual(segments[1].gradePercent, -15);
            }
        },
        {
            name: "buildRoute aggregates distance and elevation",
            run() {
                const route = buildRoute([
                    { name: "A", distanceKm: 1, gradePercent: 2 },
                    { name: "B", distanceKm: 2, gradePercent: -1 }
                ]);

                assertApprox(route.totalDistanceMeters, 3000, 0.001);
                assertApprox(route.totalElevationGainMeters, 20, 0.001);
                assertApprox(route.totalDescentMeters, 20, 0.001);
                assertEqual(route.segments[1].startDistanceMeters, 1000);
                assertEqual(route.segments[1].endDistanceMeters, 3000);
            }
        },
        {
            name: "getSegmentAtDistance returns correct segment across boundaries",
            run() {
                const route = buildRoute([
                    { name: "Flat", distanceKm: 1, gradePercent: 0 },
                    { name: "Climb", distanceKm: 1, gradePercent: 6 }
                ]);

                assertEqual(getSegmentAtDistance(route, 100)?.name, "Flat");
                assertEqual(getSegmentAtDistance(route, 1500)?.name, "Climb");
                assertEqual(getSegmentAtDistance(route, 99999)?.name, "Climb");
            }
        },
        {
            name: "buildRouteFromTrackPoints preserves geo points and samples interpolated position",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Test GPX",
                    points: [
                        { latitude: 31, longitude: 121, elevationMeters: 10, distanceMeters: 0, gradePercent: 0 },
                        { latitude: 31.001, longitude: 121.001, elevationMeters: 30, distanceMeters: 1000, gradePercent: 2 }
                    ],
                    segments: [
                        { name: "GPX 全程", distanceMeters: 1000, gradePercent: 2, elevationDelta: 20, startDistanceMeters: 0, endDistanceMeters: 1000 }
                    ]
                });

                const sample = getRouteSampleAtDistance(route, 500);
                assertApprox(sample.latitude, 31.0005, 0.00001);
                assertApprox(sample.longitude, 121.0005, 0.00001);
                assertApprox(sample.elevationMeters, 20, 0.001);
                assertApprox(sample.gradePercent, 1, 1.1);
                assertGreaterThan(route.points.length, 1);
            }
        },
        {
            name: "buildRouteFromTrackPoints annotates tight GPX curve speed limits",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Curve Route",
                    points: [
                        buildGeoPoint({ x: 0, y: 0, distanceMeters: 0 }),
                        buildGeoPoint({ x: 30, y: 0, distanceMeters: 100 }),
                        buildGeoPoint({ x: 30, y: 30, distanceMeters: 130 }),
                        buildGeoPoint({ x: 30, y: 90, distanceMeters: 190 })
                    ],
                    segments: [
                        { name: "Curve", distanceMeters: 190, gradePercent: -4, elevationDelta: -8, startDistanceMeters: 0, endDistanceMeters: 190 }
                    ]
                });

                const limit = getMinimumCurveSpeedLimitAhead(route, 80, 80);
                assert(Number.isFinite(route.points[1].curveRadiusMeters), "紧弯应生成弯道半径");
                assert(Number.isFinite(route.points[1].curveSpeedLimitKph), "紧弯应生成限速");
                assertGreaterThan(route.points[1].curveSpeedLimitKph, 20);
                assert(limit < 40, "前方紧弯限速应低于高速下坡速度");
            }
        },
        {
            name: "GPX 起点采样使用前方坡度避免下坡起步卡死",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Downhill start",
                    points: [
                        { latitude: 31, longitude: 121, elevationMeters: 100, distanceMeters: 0, gradePercent: 0 },
                        { latitude: 31.001, longitude: 121.001, elevationMeters: 94, distanceMeters: 100, gradePercent: -6 }
                    ],
                    segments: [
                        { name: "Drop", distanceMeters: 100, gradePercent: -6, elevationDelta: -6, startDistanceMeters: 0, endDistanceMeters: 100 }
                    ]
                });

                const sample = getRouteSampleAtDistance(route, 0);

                assertEqual(sample.gradePercent, -6);
            }
        },
        {
            name: "前方路线限速会按下坡坡度限制速度",
            run() {
                const moderate = buildRoute([
                    { name: "Moderate descent", distanceKm: 1, gradePercent: -4 }
                ]);
                const steep = buildRoute([
                    { name: "Steep descent", distanceKm: 1, gradePercent: -10 }
                ]);

                const moderateLimit = getForwardRouteSpeedLimitAhead(moderate, 100, 50);
                const steepLimit = getForwardRouteSpeedLimitAhead(steep, 100, 50);

                assert(Number.isFinite(moderateLimit.gradeSpeedLimitKph), "缓下坡应生成坡度限速");
                assert(Number.isFinite(steepLimit.gradeSpeedLimitKph), "陡下坡应生成坡度限速");
                assertGreaterThan(moderateLimit.gradeSpeedLimitKph, steepLimit.gradeSpeedLimitKph);
                assertEqual(steepLimit.speedLimitKph, steepLimit.gradeSpeedLimitKph);
            }
        },
        {
            name: "manual route sampling falls back to segment grade without coordinates",
            run() {
                const route = buildRoute([
                    { name: "Only", distanceKm: 1, gradePercent: 4 }
                ]);

                const sample = getRouteSampleAtDistance(route, 500);
                assertEqual(sample.latitude, null);
                assertEqual(sample.longitude, null);
                assertApprox(sample.gradePercent, 4, 0.001);
            }
        },
        {
            name: "manual route includes the origin so the first segment renders and samples correctly",
            run() {
                const route = buildRoute([
                    { name: "Start climb", distanceKm: 1, gradePercent: 4 },
                    { name: "Descent", distanceKm: 1, gradePercent: -3 }
                ]);

                assertEqual(route.points[0].distanceMeters, 0);
                assertEqual(route.points[0].elevationMeters, 0);
                assertEqual(route.points[1].distanceMeters, 1000);
                assertApprox(getRouteSampleAtDistance(route, 100).gradePercent, 4, 0.001);
                assertApprox(getRouteSampleAtDistance(route, 1500).gradePercent, -3, 0.01);
            }
        }
    ]
};

function buildGeoPoint({ x, y, distanceMeters }) {
    const originLat = 31;
    const originLng = 121;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(originLat * Math.PI / 180);

    return {
        latitude: originLat + y / metersPerDegreeLat,
        longitude: originLng + x / metersPerDegreeLng,
        elevationMeters: -distanceMeters * 0.04,
        distanceMeters,
        gradePercent: -4
    };
}
