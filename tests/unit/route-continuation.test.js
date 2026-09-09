import { buildRouteFromTrackPoints } from "../../src/domain/route/route-builder.js";
import { buildRouteContinuation, getSavedRouteCompletionDistance } from "../../src/domain/route/route-continuation.js";
import { assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-continuation",
    tests: [
        {
            name: "continues every saved route source from relative distance zero",
            run() {
                const route = buildTestRoute();
                const continued = buildRouteContinuation(route, 400);

                assertEqual(continued.source, "agent");
                assertEqual(continued.savedRouteId, "route-1");
                assertEqual(continued.points[0].distanceMeters, 0);
                assertApprox(continued.totalDistanceMeters, 600, 0.001);
                assertEqual(continued.continuation.startDistanceMeters, 400);
                assertEqual(getSavedRouteCompletionDistance(continued, 250), 650);
            }
        },
        {
            name: "keeps an untouched route when no resume position exists",
            run() {
                const route = buildTestRoute();
                const continued = buildRouteContinuation(route, 0);
                assertEqual(continued.totalDistanceMeters, 1000);
                assertEqual(continued.continuation, null);
            }
        }
    ]
};

function buildTestRoute() {
    return {
        ...buildRouteFromTrackPoints({
            source: "agent",
            name: "Agent route",
            hasElevationData: false,
            points: [
                { latitude: 31, longitude: 121, distanceMeters: 0, elevationMeters: 0, gradePercent: 0 },
                { latitude: 31.01, longitude: 121.01, distanceMeters: 500, elevationMeters: 0, gradePercent: 0 },
                { latitude: 31.02, longitude: 121.02, distanceMeters: 1000, elevationMeters: 0, gradePercent: 0 }
            ],
            segments: [{ name: "Route", distanceMeters: 1000, gradePercent: 0, elevationDelta: 0, startDistanceMeters: 0, endDistanceMeters: 1000 }]
        }),
        savedRouteId: "route-1"
    };
}
