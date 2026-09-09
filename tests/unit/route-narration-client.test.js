import {
    createRouteNarrationClient,
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

function response(payload, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => payload
    };
}

export const suite = {
    name: "route-narration-client",
    tests: [{
        name: "submits a short request and polls the durable narration job",
        async run() {
            const calls = [];
            const replies = [
                response({ ok: true, result: { job_id: "job-1", status: "queued" } }, { status: 202 }),
                response({ ok: true, result: { job_id: "job-1", status: "running" } }),
                response({
                    ok: true,
                    result: {
                        job_id: "job-1",
                        status: "succeeded",
                        route_fingerprint: "route_1234abcd",
                        plan: {
                            schema_version: "route_narration_plan.v1",
                            route_fingerprint: "route_1234abcd"
                        }
                    }
                })
            ];
            const client = createRouteNarrationClient({
                fetchImpl: async (url, options) => {
                    calls.push({ url, options });
                    return replies.shift();
                },
                pollIntervalMs: 1,
                sleepImpl: async () => {}
            });

            const plan = await client.prepare(createRoute(10_000, 40), {
                routeFingerprint: "route_1234abcd"
            });

            assertEqual(plan.route_fingerprint, "route_1234abcd");
            assertEqual(calls.length, 3);
            assert(calls[0].url.endsWith("/api/route-narrations/prepare"));
            assert(calls[1].url.endsWith("/api/route-narrations/jobs/job-1"));
            assertEqual(calls[1].options, undefined);
        }
    }, {
        name: "marks an explicit narration retry as a forced new job",
        async run() {
            let submitted;
            const client = createRouteNarrationClient({
                fetchImpl: async (_url, options) => {
                    submitted = JSON.parse(options.body);
                    return response({
                        ok: true,
                        result: {
                            job_id: "job-retry",
                            status: "succeeded",
                            route_fingerprint: "route_1234abcd",
                            plan: {
                                schema_version: "route_narration_plan.v1",
                                route_fingerprint: "route_1234abcd"
                            }
                        }
                    }, { status: 202 });
                }
            });

            await client.prepare(createRoute(10_000, 40), {
                routeFingerprint: "route_1234abcd",
                force: true
            });

            assertEqual(submitted.force, true);
        }
    }, {
        name: "rejects a completed job for a stale route fingerprint",
        async run() {
            const client = createRouteNarrationClient({
                fetchImpl: async () => response({
                    ok: true,
                    result: {
                        job_id: "job-stale",
                        status: "succeeded",
                        route_fingerprint: "route_deadbeef",
                        plan: {
                            schema_version: "route_narration_plan.v1",
                            route_fingerprint: "route_deadbeef"
                        }
                    }
                }, { status: 202 })
            });
            let message = "";

            try {
                await client.prepare(createRoute(10_000, 40), {
                    routeFingerprint: "route_1234abcd"
                });
            } catch (error) {
                message = error.message;
            }

            assert(message.includes("路线已经变化"));
        }
    }, {
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
