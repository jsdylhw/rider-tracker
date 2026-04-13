import {
    buildRoute,
    buildRouteFromTrackPoints,
    getRouteSampleAtDistance,
    getSegmentAtDistance,
    sanitizeSegments
} from "../../src/domain/course/route-builder.js";
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
        }
    ]
};
