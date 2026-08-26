import { buildRouteNarrationRequest } from "../../src/adapters/narration/route-narration-client.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createRoute(totalDistanceMeters, durationMinutes = 120) {
    return {
        name: "test route",
        totalDistanceMeters,
        durationMinutes,
        points: [
            { distanceMeters: 0, latitude: 35, longitude: 135 },
            { distanceMeters: totalDistanceMeters, latitude: 35.4, longitude: 135.4 }
        ],
        segments: []
    };
}

export const suite = {
    name: "route-narration-client",
    tests: [{
        name: "samples a two-hour route densely enough for 20-30 cards",
        run() {
            const request = buildRouteNarrationRequest(createRoute(48000), "route_1234abcd");
            assertEqual(request.samples.length, 31);
            assertEqual(request.samples.at(-1).estimated_elapsed_s, 7200);
            assert(request.samples.every((sample, index) => (
                index === 0 || sample.route_distance_m > request.samples[index - 1].route_distance_m
            )));
        }
    }, {
        name: "keeps the final rounded sample within a fractional route distance",
        run() {
            const request = buildRouteNarrationRequest(createRoute(10399.6, 30), "route_1234abcd");
            assertEqual(request.total_distance_m, 10399.6);
            assertEqual(request.samples.at(-1).route_distance_m, 10399.6);
            assert(request.samples.every((sample) => sample.route_distance_m <= request.total_distance_m));
        }
    }]
};
