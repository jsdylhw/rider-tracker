import express from "express";
import { createPersonalFitAgentClient } from "../../src/server/personal-fit-agent-client.js";
import { createAgentApiClient } from "../../src/adapters/agent/personal-fit-agent-client.js";
import { createAgentRoutes, normalizeChatRequest, normalizeCommandRequest } from "../../src/server/routes/agent-routes.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-routes",
    tests: [
        {
            name: "session CRUD passes through BFF and preserves the selected ID until explicitly selected",
            async run() {
                const calls = [];
                const upstream = createPersonalFitAgentClient({ fetchImpl: async (url, options = {}) => {
                    calls.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
                    const body = url.includes("?kind=") ? { sessions: [{ session_id: "created", title: "京都" }] }
                        : options.method === "DELETE" ? { deleted: true }
                        : { session_id: "created", kind: "route_plan", turns: [] };
                    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
                } });
                const app = express(); app.use(express.json()); app.use(createAgentRoutes({ agentClient: upstream }));
                const server = app.listen(0, "127.0.0.1");
                await new Promise((resolve) => server.once("listening", resolve));
                try {
                    const browser = createAgentApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, storage: null });
                    const old = browser.sessionId;
                    const created = await browser.createSession("route_plan", "created");
                    assertEqual(browser.sessionId, old);
                    browser.selectSession(created.session_id);
                    assertEqual((await browser.getSession()).session_id, "created");
                    assertEqual((await browser.listSessions("route_plan")).sessions.length, 1);
                    assertEqual((await browser.deleteSession()).deleted, true);
                    assertEqual(calls[0].body.kind, "route_plan");
                    assertEqual(calls[2].url.endsWith("/api/chat-sessions?kind=route_plan"), true);
                    assertEqual(calls[3].method, "DELETE");
                } finally { await new Promise((resolve) => server.close(resolve)); }
            }
        },
        {
            name: "BFF forwards live route progress and the final result through both clients",
            async run() {
                let release;
                const gate = new Promise((resolve) => { release = resolve; });
                const upstream = createPersonalFitAgentClient({ fetchImpl: async (_, options) => {
                    assertEqual(options.headers.Accept, "application/x-ndjson");
                    return new Response(new ReadableStream({ async start(controller) {
                        const emit = (event) => controller.enqueue(new TextEncoder().encode(JSON.stringify({ schema_version: "route_stream.v1", ...event }) + "\n"));
                        emit({ type: "progress", stage: "create_route_plan", status: "running" });
                        await gate;
                        emit({ type: "result", result: { status: "completed" } });
                        controller.close();
                    } }), { headers: { "Content-Type": "application/x-ndjson" } });
                } });
                const app = express();
                app.use(express.json());
                app.use(createAgentRoutes({ agentClient: upstream }));
                const server = app.listen(0, "127.0.0.1");
                await new Promise((resolve) => server.once("listening", resolve));
                try {
                    const browser = createAgentApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, storage: null });
                    const result = await browser.chat("京都", { requestMode: "route_plan", routeAction: "create", onProgress(event) {
                        assertEqual(event.stage, "create_route_plan");
                        release();
                    } });
                    assertEqual(result.status, "completed");
                } finally {
                    release();
                    await new Promise((resolve) => server.close(resolve));
                }
            }
        },
        {
            name: "BFF forwards live main chat progress and the final result through both clients",
            async run() {
                let release;
                const gate = new Promise((resolve) => { release = resolve; });
                const upstream = createPersonalFitAgentClient({ fetchImpl: async (_, options) => {
                    assertEqual(options.headers.Accept, "application/x-ndjson");
                    return new Response(new ReadableStream({ async start(controller) {
                        const emit = (event) => controller.enqueue(new TextEncoder().encode(JSON.stringify({ schema_version: "agent_stream.v1", ...event }) + "\n"));
                        emit({ type: "progress", stage: "resolve_activities", status: "running" });
                        await gate;
                        emit({ type: "result", result: { status: "completed" } });
                        controller.close();
                    } }), { headers: { "Content-Type": "application/x-ndjson" } });
                } });
                const app = express();
                app.use(express.json());
                app.use(createAgentRoutes({ agentClient: upstream }));
                const server = app.listen(0, "127.0.0.1");
                await new Promise((resolve) => server.once("listening", resolve));
                try {
                    const browser = createAgentApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, storage: null });
                    const result = await browser.chat("查看活动", { requestMode: "chat", onProgress(event) {
                        assertEqual(event.stage, "resolve_activities");
                        release();
                    } });
                    assertEqual(result.status, "completed");
                } finally {
                    release();
                    await new Promise((resolve) => server.close(resolve));
                }
            }
        },
        {
            name: "forwards optional get revision and rejects malformed revisions",
            run() {
                const base = { session_id: "session", request_id: "open", operation: "get", plan_id: "plan" };
                assertEqual(normalizeCommandRequest({ ...base, expected_revision: 3 }).expected_revision, 3);
                assertEqual(normalizeCommandRequest(base).expected_revision, undefined);
                assertEqual(normalizeCommandRequest({ ...base, operation: "generate_day", candidate_id: "day_2", expected_revision: 3 }).operation, "generate_day");
                let rejected = false;
                try { normalizeCommandRequest({ ...base, expected_revision: 0 }); } catch { rejected = true; }
                assertEqual(rejected, true);
            }
        },
        {
            name: "requires an explicit route action for route-plan requests",
            run() {
                const request = normalizeChatRequest({
                    session_id: "session-1",
                    request_id: "request-1",
                    message: "生成京都路线",
                    request_mode: "route_plan",
                    route_action: "create",
                    route_options: { include_elevation: false, include_ascent: true }
                });
                assertEqual(request.request_mode, "route_plan");
                assertEqual(request.route_action, "create");
                assertEqual(request.route_options.include_ascent, true);

                let error = null;
                try {
                    normalizeChatRequest({
                        session_id: "session-1",
                        request_id: "request-2",
                        message: "生成京都路线",
                        request_mode: "route_plan"
                    });
                } catch (caught) {
                    error = caught;
                }
                assert(error, "route_plan 缺少动作时必须拒绝");

                const refinement = normalizeChatRequest({
                    session_id: "session-1",
                    request_id: "request-3",
                    message: "把路线改到法国安纳西",
                    request_mode: "route_plan",
                    route_action: "refine",
                    route_reference: { plan_id: "plan-1", revision: 3, workspace_id: "untrusted" }
                });
                assertEqual(refinement.route_action, "refine");
                assertEqual(refinement.route_reference.plan_id, "plan-1");
                assertEqual(refinement.route_reference.revision, 3);
                assertEqual(refinement.route_reference.workspace_id, undefined);
            }
        },
        {
            name: "preserves the saved route snapshot for atomic confirmation",
            run() {
                const savedRoute = {
                    source: "agent",
                    agentPlanId: "plan-1",
                    agentCandidateId: "candidate-1",
                    route: {
                        name: "Scenic loop",
                        mapGeometry: [{ lat: 31, lng: 121 }, { lat: 31.1, lng: 121.1 }]
                    }
                };
                const request = normalizeCommandRequest({
                    session_id: "session-1",
                    request_id: "request-1",
                    plan_id: "plan-1",
                    candidate_id: "candidate-1",
                    operation: "confirm",
                    expected_revision: 2,
                    saved_route: savedRoute
                });

                assertEqual(request.operation, "confirm");
                assertEqual(request.expected_revision, 2);
                assertEqual(request.saved_route, savedRoute);
            }
        },
        {
            name: "rejects confirmation without a saved route snapshot",
            run() {
                let error = null;
                try {
                    normalizeCommandRequest({
                        session_id: "session-1",
                        request_id: "request-1",
                        plan_id: "plan-1",
                        candidate_id: "candidate-1",
                        operation: "confirm",
                        expected_revision: 2
                    });
                } catch (caught) {
                    error = caught;
                }

                assert(error, "缺少 saved_route 时必须拒绝确认请求");
                assertEqual(error.message, "saved_route 格式无效。");
            }
        }
    ]
};
