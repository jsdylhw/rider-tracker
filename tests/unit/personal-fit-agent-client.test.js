import { createPersonalFitAgentClient } from "../../src/server/personal-fit-agent-client.js";
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
        }
    ]
};

function fakeResponse(payload, { ok = true, status = 200 } = {}) {
    return { ok, status, async json() { return payload; } };
}
