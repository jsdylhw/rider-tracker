import {
    buildRouteNarrationRequest,
    estimateRouteNarrationDuration
} from "../../src/adapters/narration/route-narration-client.js";
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
    }, {
        name: "estimates a sustained climb from 60 percent FTP instead of flat-road speed",
        run() {
            const route = {
                ...createRoute(10368.5, undefined),
                durationMinutes: undefined,
                hasElevationData: true,
                segments: [{ distanceMeters: 10368.5, gradePercent: 5.71 }]
            };
            const settings = { ftp: 260, mass: 80, crr: 0.004, cda: 0.35, windSpeed: 0 };

            const estimate = estimateRouteNarrationDuration(route, settings);
            const request = buildRouteNarrationRequest(route, "route_yabitsu", settings);

            assertEqual(estimate.method, "route_profile_at_60pct_ftp");
            assertEqual(estimate.targetPowerWatts, 156);
            assert(estimate.minutes >= 50 && estimate.minutes <= 65);
            assert(request.samples.length >= 14);
            assertEqual(request.duration_estimation.method, "route_profile_at_60pct_ftp");
        }
    }, {
        name: "falls back to explicit duration when ride settings are unavailable",
        run() {
            const estimate = estimateRouteNarrationDuration(createRoute(48000, 120));

            assertEqual(estimate.minutes, 120);
            assertEqual(estimate.method, "route_duration");
        }
    }, {
        name: "does not estimate from a route profile that covers only part of the route",
        run() {
            const route = {
                ...createRoute(10000, 50),
                hasElevationData: true,
                segments: [{ distanceMeters: 1000, gradePercent: 8 }]
            };
            const settings = { ftp: 260, mass: 80, crr: 0.004, cda: 0.35, windSpeed: 0 };

            const estimate = estimateRouteNarrationDuration(route, settings);

            assertEqual(estimate.minutes, 50);
            assertEqual(estimate.method, "route_duration");
        }
    }]
};
