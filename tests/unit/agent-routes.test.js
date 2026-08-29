import { normalizeCommandRequest } from "../../src/server/routes/agent-routes.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-routes",
    tests: [
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
