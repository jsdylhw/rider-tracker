import { createAgentUnavailableError } from "../../src/server/agent-unavailable.js";
import {
    canonicalDetailToRiderActivity,
    createActivityLibraryHandlers,
    createRiderSessionArchiveHandler,
    routeLinkFromSession,
    sendActivityWriteError
} from "../../src/server/routes/activity-routes.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "activity-library-routes",
    tests: [
        {
            name: "preserves Python FIT ingestion status and retry metadata",
            run() {
                const busyError = new Error("Activity library is busy. Retry the operation.");
                busyError.statusCode = 503;
                busyError.code = "activity_store_busy";
                busyError.retryable = true;
                const busy = response();
                sendActivityWriteError(busy, busyError, { fallbackStatus: 400 });

                assertEqual(busy.statusCode, 503);
                assertEqual(busy.payload.code, "activity_store_busy");
                assertEqual(busy.payload.retryable, true);

                const missingError = new Error("Activity not found.");
                missingError.statusCode = 404;
                const missing = response();
                sendActivityWriteError(missing, missingError, { fallbackStatus: 500 });
                assertEqual(missing.statusCode, 404);
            }
        },
        {
            name: "maps compact Rider route progress into the Python ingestion contract",
            run() {
                const routeLink = routeLinkFromSession({
                    route: {
                        savedRouteId: "route-1",
                        continuation: { startDistanceMeters: 3200 }
                    },
                    summary: { metrics: { ride: { distanceKm: 12.34 } } }
                });

                assertEqual(routeLink.saved_route_id, "route-1");
                assertEqual(routeLink.start_distance_meters, 3200);
                assertEqual(routeLink.end_distance_meters, 15540);
                assertEqual(routeLinkFromSession({ route: { source: "exploration" } }), null);
            }
        },
        {
            name: "delegates Rider session archive to Python without a Node store",
            async run() {
                const calls = [];
                const archived = response();
                await createRiderSessionArchiveHandler({
                    agentClient: {
                        archiveRiderSession(request) {
                            calls.push(request);
                            return Promise.resolve({ activity: { id: "rt-1", savedRouteId: "route-1" } });
                        }
                    }
                })({
                    body: {
                        session: { id: "rt-1", route: { savedRouteId: "route-1" } },
                        name: "Morning Ride",
                        sportType: "Ride"
                    }
                }, archived);

                assertEqual(archived.statusCode, 200);
                assertEqual(archived.payload.ok, true);
                assertEqual(archived.payload.activity.savedRouteId, "route-1");
                assertEqual(calls[0].name, "Morning Ride");
                assertEqual(calls[0].sportType, "Ride");
            }
        },
        {
            name: "returns structured degradation when Rider session archive backend is unavailable",
            async run() {
                const archived = response();
                await createRiderSessionArchiveHandler({
                    agentClient: {
                        archiveRiderSession: async () => {
                            throw createAgentUnavailableError("无法连接本地 Training Agent。");
                        }
                    }
                })({ body: { session: {} } }, archived);

                assertEqual(archived.statusCode, 503);
                assertEqual(archived.payload.code, "agent_unavailable");
                assertEqual(archived.payload.capability, "activity_archive");
            }
        },
        {
            name: "preserves retryable archive errors from Python",
            async run() {
                const busyError = new Error("Activity library is busy. Retry the operation.");
                busyError.statusCode = 503;
                busyError.code = "activity_store_busy";
                busyError.retryable = true;
                const archived = response();

                await createRiderSessionArchiveHandler({
                    agentClient: {
                        archiveRiderSession: async () => { throw busyError; }
                    }
                })({ body: { session: {} } }, archived);

                assertEqual(archived.statusCode, 503);
                assertEqual(archived.payload.code, "activity_store_busy");
                assertEqual(archived.payload.retryable, true);
            }
        },
        {
            name: "delegates activity list, detail, rename and delete to Python",
            async run() {
                const calls = [];
                const agentClient = fakeAgentClient(calls);
                const handlers = createActivityLibraryHandlers({ agentClient });

                const listed = response();
                await handlers.list({ query: { limit: "20", offset: "5", sportType: "cycling", source: "fit-import" } }, listed);
                const detailed = response();
                await handlers.get(request("fit-1"), detailed);
                const renamed = response();
                await handlers.rename({ ...request("fit-1"), body: { name: "Renamed" } }, renamed);
                const removed = response();
                await handlers.remove(request("fit-1"), removed);

                assertEqual(listed.statusCode, 200);
                assertEqual(listed.payload.ok, true);
                assertEqual(listed.payload.page.total, 1);
                assertEqual(detailed.payload.activity.id, "fit-1");
                assertEqual(detailed.payload.activity.rawSession.records.length, 1);
                assertEqual(
                    detailed.payload.activity.rawSession.summary.metrics.energy.estimatedCaloriesKcal,
                    169
                );
                assertEqual(detailed.payload.activity.rawSession.summary.metrics.energy.mechanicalWorkKj, 95);
                assertEqual(renamed.payload.activity.name, "Renamed");
                assertEqual(removed.payload.activity.id, "fit-1");
                assertEqual(calls.map((item) => item.name).join(","), "list,get,detail,rename,remove");
                assertEqual(calls[0].value.sportType, "cycling");
                assertEqual(calls[0].value.offset, "5");
                assertEqual(calls[1].options.requestTimeoutMs, 2000);
                assertEqual(calls[2].options.requestTimeoutMs, 2000);
            }
        },
        {
            name: "preserves Rider-computed energy when FIT detail has no calorie fields",
            run() {
                const activity = canonicalDetailToRiderActivity({
                    activity: { activity_key: "ride-1", sport_type: "cycling" },
                    metrics: { scale: {}, power: {} },
                    series: { records: [] }
                }, {
                    id: "ride-1",
                    rawSession: {
                        summary: {
                            metrics: {
                                energy: {
                                    estimatedCaloriesKcal: 42,
                                    mechanicalWorkKj: 40,
                                    method: "power"
                                }
                            }
                        }
                    }
                });

                assertEqual(activity.rawSession.summary.metrics.energy.estimatedCaloriesKcal, 42);
                assertEqual(activity.rawSession.summary.metrics.energy.mechanicalWorkKj, 40);
                assertEqual(activity.rawSession.summary.metrics.energy.method, "power");
            }
        },
        {
            name: "returns structured activity-library degradation and preserves upstream status",
            async run() {
                const unavailable = response();
                await createActivityLibraryHandlers({
                    agentClient: {
                        listActivities: async () => {
                            throw createAgentUnavailableError("无法连接本地 Training Agent。");
                        }
                    }
                }).list({ query: {} }, unavailable);

                const missingError = new Error("Activity not found.");
                missingError.statusCode = 404;
                const missing = response();
                await createActivityLibraryHandlers({
                    agentClient: { getActivity: async () => { throw missingError; } }
                }).get(request("missing"), missing);

                assertEqual(unavailable.statusCode, 503);
                assertEqual(unavailable.payload.code, "agent_unavailable");
                assertEqual(unavailable.payload.capability, "activity_library");
                assertEqual(missing.statusCode, 404);
                assertEqual(missing.payload.error, "Activity not found.");

                const busyError = new Error("Activity library is busy. Retry the operation.");
                busyError.statusCode = 503;
                busyError.code = "activity_store_busy";
                busyError.retryable = true;
                const busy = response();
                await createActivityLibraryHandlers({
                    agentClient: { renameActivity: async () => { throw busyError; } }
                }).rename({ ...request("fit-1"), body: { name: "Renamed" } }, busy);

                assertEqual(busy.statusCode, 503);
                assertEqual(busy.payload.code, "activity_store_busy");
                assertEqual(busy.payload.retryable, true);
            }
        },
        {
            name: "shares one bounded deadline across catalogue and FIT detail reads",
            async run() {
                const calls = [];
                const ticks = [0, 0, 1500];
                const handlers = createActivityLibraryHandlers({
                    agentClient: fakeAgentClient(calls),
                    timeoutMs: 2000,
                    now: () => ticks.shift() ?? 1500
                });
                const detailed = response();

                await handlers.get(request("fit-1"), detailed);

                assertEqual(detailed.statusCode, 200);
                assertEqual(calls[0].options.requestTimeoutMs, 2000);
                assertEqual(calls[1].options.requestTimeoutMs, 500);
            }
        },
        {
            name: "does not start FIT detail after the activity-library deadline expires",
            async run() {
                const calls = [];
                const ticks = [0, 0, 2001];
                const handlers = createActivityLibraryHandlers({
                    agentClient: fakeAgentClient(calls),
                    timeoutMs: 2000,
                    now: () => ticks.shift() ?? 2001
                });
                const detailed = response();

                await handlers.get(request("fit-1"), detailed);

                assertEqual(detailed.statusCode, 503);
                assertEqual(detailed.payload.code, "agent_unavailable");
                assertEqual(calls.map((item) => item.name).join(","), "get");
            }
        }
    ]
};

function fakeAgentClient(calls) {
    return {
        listActivities(value) {
            calls.push({ name: "list", value });
            return Promise.resolve({
                activities: [{ id: "fit-1" }],
                summary: { activityCount: 1 },
                page: { total: 1, offset: 5, limit: 20, hasMore: false }
            });
        },
        getActivity(value, options = {}) {
            calls.push({ name: "get", value, options });
            return Promise.resolve({
                activity: { id: value, name: "Ride", fitFilePath: "data/files/fit/fit-1.fit" }
            });
        },
        activityDetail(value, options = {}) {
            calls.push({ name: "detail", value, options });
            return Promise.resolve({
                activity: { activity_key: value, name: "Ride", sport_type: "cycling" },
                metrics: {
                    scale: { duration_s: 60, distance_km: 1, calories: 169 },
                    power: { total_work_kj: 95 }
                },
                series: { records: [{ elapsed_seconds: 0, distance_km: 0 }] },
                report: null
            });
        },
        renameActivity(id, name) {
            calls.push({ name: "rename", value: { id, name } });
            return Promise.resolve({ activity: { id, name } });
        },
        deleteActivity(id) {
            calls.push({ name: "remove", value: id });
            return Promise.resolve({ activity: { id } });
        }
    };
}

function request(activityId) {
    return { params: { activityId } };
}

function response() {
    return {
        statusCode: 0,
        payload: null,
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.payload = value;
            return this;
        }
    };
}
