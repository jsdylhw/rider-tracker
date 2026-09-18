import { normalizeChatRequest, normalizeCommandRequest } from "../../src/server/routes/agent-routes.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-routes",
    tests: [
        {
            name: "forwards optional get revision and rejects malformed revisions",
            run() {
                const base = { session_id: "session", request_id: "open", operation: "get", plan_id: "plan" };
                assertEqual(normalizeCommandRequest({ ...base, expected_revision: 3 }).expected_revision, 3);
                assertEqual(normalizeCommandRequest(base).expected_revision, undefined);
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
                    route_options: { include_elevation: false }
                });
                assertEqual(request.request_mode, "route_plan");
                assertEqual(request.route_action, "create");

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
