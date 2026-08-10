import { buildRouteFromTrackPoints } from "../../src/domain/route/route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "../../src/domain/route/track-route.js";
import { buildRouteContinuation, getRouteLibraryCompletionDistance } from "../../src/domain/route/route-continuation.js";
import { assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-continuation",
    tests: [
        {
            name: "starts a continued ride from the saved route distance while keeping ride distance relative",
            run() {
                const route = buildGpxRoute();
                const continued = buildRouteContinuation({ ...route, libraryRouteId: "saved-1" }, 400);

                assertEqual(continued.libraryRouteId, "saved-1");
                assertEqual(continued.continuation.startDistanceMeters, 400);
                assertApprox(continued.totalDistanceMeters, 600, 0.001);
                assertApprox(continued.points[0].distanceMeters, 0, 0.001);
                assertApprox(continued.points[0].latitude, 35.004, 0.000001);
                assertApprox(getRouteLibraryCompletionDistance(continued, 150), 550, 0.001);
            }
        }
    ]
};

function buildGpxRoute() {
    const points = [
        { latitude: 35, longitude: 135, distanceMeters: 0, elevationMeters: 10, gradePercent: 0 },
        { latitude: 35.004, longitude: 135.004, distanceMeters: 400, elevationMeters: 50, gradePercent: 10 },
        { latitude: 35.01, longitude: 135.01, distanceMeters: 1000, elevationMeters: 110, gradePercent: 10 }
    ];
    return buildRouteFromTrackPoints({
        source: "gpx",
        name: "Continue route",
        points,
        segments: buildSummarySegmentsFromTrackPoints(points, { hasElevationData: true }),
        hasElevationData: true
    });
}
