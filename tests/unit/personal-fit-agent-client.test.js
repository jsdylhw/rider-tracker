import { createPersonalFitAgentClient } from "../../src/server/personal-fit-agent-client.js";
import { createAgentApiClient } from "../../src/adapters/agent/personal-fit-agent-client.js";
import { canonicalDetailToRiderActivity } from "../../src/server/routes/activity-routes.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "personal-fit-agent-client",
    tests: [
        {
            name: "checks embedded agent health through the server-side client",
            async run() {
                let request = null;
                const client = createPersonalFitAgentClient({
                    baseUrl: "http://127.0.0.1:8000/",
                    apiToken: "server-only-token",
                    fetchImpl: async (url, options) => {
                        request = { url, options };
                        return fakeResponse({ status: "ok" });
                    }
                });
                const result = await client.health();
                assertEqual(result.status, "ok");
                assertEqual(request.url, "http://127.0.0.1:8000/health");
                assertEqual(request.options.headers["X-API-Token"], "server-only-token");
                assertEqual(request.options.body, undefined);
            }
        },
        {
            name: "forwards chat through the server with token kept out of the browser",
            async run() {
                let request = null;
                const client = createPersonalFitAgentClient({
                    baseUrl: "http://127.0.0.1:8000/",
                    apiToken: "server-only-token",
                    fetchImpl: async (url, options) => {
                        request = { url, options };
                        return fakeResponse({ answer: "ok" });
                    }
                });
                const result = await client.chat({ session_id: "s1", request_id: "r1", message: "规划路线" });
                assertEqual(result.answer, "ok");
                assertEqual(request.url, "http://127.0.0.1:8000/api/chat");
                assertEqual(request.options.headers["X-API-Token"], "server-only-token");
                assertEqual(JSON.parse(request.options.body).message, "规划路线");
            }
        },
        {
            name: "forwards deterministic FIT ingestion and activity detail requests",
            async run() {
                const requests = [];
                const client = createPersonalFitAgentClient({
                    baseUrl: "http://127.0.0.1:8000",
                    apiToken: "server-only-token",
                    fetchImpl: async (url, options) => {
                        requests.push({ url, options });
                        return fakeResponse({ schema_version: "activity_detail.v1" });
                    }
                });

                await client.ingestFit({ path: "data/files/fit/fit-a.fit", activity_id: "fit-a" });
                await client.activityDetail("fit-a", { maxPoints: 500 });

                assertEqual(requests[0].url, "http://127.0.0.1:8000/api/activities/ingest-fit");
                assertEqual(JSON.parse(requests[0].options.body).activity_id, "fit-a");
                assertEqual(requests[1].url, "http://127.0.0.1:8000/api/activities/fit-a/detail?max_points=500");
                assertEqual(requests[1].options.headers["X-API-Token"], "server-only-token");
            }
        },
        {
            name: "adapts the canonical Python FIT detail contract for Rider views",
            run() {
                const activity = canonicalDetailToRiderActivity({
                    activity: {
                        activity_key: "fit-a",
                        name: "Morning Run",
                        sport_type: "running",
                        start_time_local: "2026-08-24T08:00:00",
                        fit_path: "data/files/fit/fit-a.fit"
                    },
                    metrics: {
                        scale: { duration_s: 1800, distance_km: 5, total_ascent_m: 42 },
                        power: { avg_power_w: 210, normalized_power_w: 225 },
                        heart_rate: { avg_hr_bpm: 145, max_hr_bpm: 170 },
                        load: { power_stress: { tss: null } }
                    },
                    settings: { resting_hr: 50, max_hr: 190 },
                    report: {
                        schema_version: "llm_fit_file_analysis.v2",
                        revision: 2,
                        markdown_report: "# Morning Run\n\n保持恢复。"
                    },
                    series: {
                        records: [
                            { elapsed_seconds: 0, distance_km: 0, elevation_m: 10, latitude: 31, longitude: 121 },
                            { elapsed_seconds: 60, distance_km: 0.2, elevation_m: 15, latitude: 31.001, longitude: 121.001 },
                            { elapsed_seconds: 120, distance_km: 0.4, elevation_m: 13, latitude: 31.002, longitude: 121.002 }
                        ]
                    }
                });

                assertEqual(activity.id, "fit-a");
                assertEqual(activity.sportType, "running");
                assertEqual(activity.rawSession.records.at(-1).ascentMeters, 5);
                assertEqual(activity.rawSession.summary.metrics.ride.ascentMeters, 42);
                assertEqual(activity.rawSession.route.points.length, 3);
                assertEqual(activity.analysisReport.revision, 2);
                assertEqual(activity.analysisReport.markdown_report, "# Morning Run\n\n保持恢复。");
            }
        },
        {
            name: "clears a stale Rider report when the canonical backend reports none",
            run() {
                const activity = canonicalDetailToRiderActivity(
                    { activity: { activity_key: "fit-a" }, report: null },
                    { id: "fit-a", analysisReport: { markdown_report: "# 旧报告" } }
                );

                assertEqual(activity.analysisReport, null);
            }
        },
        {
            name: "forwards deterministic route commands to the agent command endpoint",
            async run() {
                let request = null;
                const client = createPersonalFitAgentClient({
                    baseUrl: "http://127.0.0.1:8000/",
                    apiToken: "server-only-token",
                    fetchImpl: async (url, options) => {
                        request = { url, options };
                        return fakeResponse({ answer: "已确认" });
                    }
                });
                const result = await client.routePlanCommand({
                    session_id: "s1",
                    plan_id: "plan-1",
                    operation: "compose_segments",
                    segments: [
                        { segment_id: 101, direction: "forward" },
                        { segment_id: 202, direction: "reverse" }
                    ]
                });
                const body = JSON.parse(request.options.body);
                assertEqual(result.answer, "已确认");
                assertEqual(request.url, "http://127.0.0.1:8000/api/route-plans/command");
                assertEqual(body.operation, "compose_segments");
                assertEqual(body.segments[1].segment_id, 202);
            }
        },
        {
            name: "forwards athlete profile and Strava ownership requests",
            async run() {
                const requests = [];
                const client = createPersonalFitAgentClient({
                    baseUrl: "http://127.0.0.1:8000",
                    apiToken: "server-only-token",
                    fetchImpl: async (url, options) => {
                        requests.push({ url, options });
                        return fakeResponse({ configured: true });
                    }
                });

                await client.athleteProfile();
                await client.updateAthleteProfile({ ftp: 275 });
                await client.stravaAuthorizeUrl({ redirect_uri: "http://localhost/callback", state: "s1" });
                await client.stravaUploadActivity({ activity_key: "a1" });
                await client.stravaUploadStatus("upload-1");

                assertEqual(requests[0].url, "http://127.0.0.1:8000/api/athlete-profile");
                assertEqual(requests[1].options.method, "PUT");
                assertEqual(JSON.parse(requests[1].options.body).profile.ftp, 275);
                assertEqual(requests[2].url, "http://127.0.0.1:8000/api/strava/auth-url");
                assertEqual(requests[3].url, "http://127.0.0.1:8000/api/strava/upload-activity");
                assertEqual(requests[4].url, "http://127.0.0.1:8000/api/strava/upload-status/upload-1");
            }
        },
        {
            name: "can rotate a scoped browser chat session without affecting other surfaces",
            async run() {
                const values = new Map([["home-session", "rider-existing"]]);
                const storage = {
                    getItem(key) { return values.get(key) ?? null; },
                    setItem(key, value) { values.set(key, value); }
                };
                let requestBody = null;
                const client = createAgentApiClient({
                    storage,
                    sessionStorageKey: "home-session",
                    fetchImpl: async (_url, options) => {
                        requestBody = JSON.parse(options.body);
                        return fakeResponse({ ok: true, result: { answer: "ok" } });
                    }
                });

                const previousSession = client.sessionId;
                const nextSession = client.resetSession();
                await client.chat("分析活动");

                assertEqual(previousSession, "rider-existing");
                assertEqual(nextSession === previousSession, false);
                assertEqual(values.get("home-session"), nextSession);
                assertEqual(requestBody.session_id, nextSession);
            }
        }
    ]
};

function fakeResponse(payload, { ok = true, status = 200 } = {}) {
    return { ok, status, async json() { return payload; } };
}
