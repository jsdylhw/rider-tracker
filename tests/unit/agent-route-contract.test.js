import {
    buildRiderRouteFromAgentCandidate,
    isRouteActivationOnly,
    parseAgentRouteDraft
} from "../../src/domain/route/agent-route-contract.js";
import { isRouteReadyForRide } from "../../src/domain/route/route-builder.js";
import { assert, assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-route-contract",
    tests: [
        {
            name: "parses route_plan presentations and builds a no-elevation Rider route",
            run() {
                const draft = parseAgentRouteDraft(buildTurnResult());
                assertEqual(draft.planId, "route-1");
                assertEqual(draft.candidates.length, 2);
                assertEqual(draft.countryCode, "JP");
                assertEqual(draft.candidates[0].name, "鸭川路线");
                assertApprox(draft.candidates[0].distanceKm, 30.4, 0.001);
                assertApprox(draft.candidates[0].durationMinutes, 72.96, 0.001);
                assertEqual(draft.segments.length, 2);
                assertEqual(draft.segments[0].segmentId, 9876);
                assertEqual(draft.segments[0].name, "桂川景观段");
                assertEqual(draft.segments[0].coordinates.length, 2);

                const route = buildRiderRouteFromAgentCandidate(draft, "candidate-1");
                assertEqual(route.source, "agent-planned");
                assertEqual(route.routeProvider, "personal-fit-agent");
                assertEqual(route.hasElevationData, false);
                assertEqual(route.agentSegmentOverlays[0].segmentId, 9876);
                assertEqual(route.agentSegmentOverlays.length, 1);
                assertApprox(route.totalDistanceMeters, 30400, 1);
                assert(route.points.every((point) => point.gradePercent === 0), "AI 虚拟路线坡度应恒为 0");
                assert(!isRouteReadyForRide(route), "预览草稿在最终确认前不应开始骑行");
                const confirmed = buildRiderRouteFromAgentCandidate({ ...draft, planningStatus: "confirmed" }, "candidate-1");
                assert(isRouteReadyForRide(confirmed), "最终确认后的 AI 路线应可直接骑行");
            }
        },
        {
            name: "detects a route skill activation response without route geometry",
            run() {
                assertEqual(isRouteActivationOnly({
                    skill_id: "plan-routes",
                    executions: [{ tool: "activate_skill" }],
                    presentations: []
                }), true);
                assertEqual(isRouteActivationOnly(buildTurnResult()), false);
            }
        },
        {
            name: "rejects an answer without usable route candidates",
            run() {
                let error = null;
                try {
                    parseAgentRouteDraft({ answer: "请补充起点", presentations: [] });
                } catch (caught) {
                    error = caught;
                }
                assertEqual(error?.message, "请补充起点");
            }
        }
    ]
};

function buildTurnResult() {
    return {
        answer: "已生成两条路线。",
        status: "completed",
        presentations: [
            {
                type: "table",
                data: {
                    rows: [
                        { candidate: "鸭川路线", distance_km: 30.4, duration_min: 92, provider: "Google", mode: "BICYCLE", strava_segments: "" },
                        { candidate: "岚山路线", distance_km: 32.1, duration_min: 105, provider: "Google", mode: "BICYCLE", strava_segments: "桂川" }
                    ]
                }
            },
            {
                type: "table",
                data: {
                    rows: [{
                        segment_id: 9876,
                        segment_name: "桂川景观段",
                        distance_km: 6.4,
                        average_grade_percent: 0.4,
                        elevation_difference_m: 18,
                        distance_to_route_km: 0.3,
                        route_overlap_ratio: 0.72,
                        candidate_ids: ["candidate-1"]
                    }, {
                        segment_id: 9999,
                        segment_name: "岚山专属段",
                        distance_km: 4.2,
                        candidate_ids: ["candidate-2"]
                    }]
                }
            },
            {
                type: "route_map",
                data: {
                    plan_id: "route-1",
                    country_code: "JP",
                    planning_status: "awaiting_selection",
                    routes: [
                        { candidate_id: "candidate-1", kind: "planned_route", name: "鸭川路线", active: true, geometry: { coordinates: [[135.75, 35.0], [135.77, 35.03], [135.75, 35.0]] } },
                        { candidate_id: "candidate-2", kind: "planned_route", name: "岚山路线", active: false, geometry: { coordinates: [[135.75, 35.0], [135.67, 35.01], [135.75, 35.0]] } },
                        { kind: "strava_segment", segment_id: 9876, candidate_ids: ["candidate-1"], name: "桂川景观段", geometry: { coordinates: [[135.7, 35.0], [135.71, 35.01]] } },
                        { kind: "strava_segment", segment_id: 9999, candidate_ids: ["candidate-2"], name: "岚山专属段", geometry: { coordinates: [[135.67, 35.01], [135.68, 35.02]] } }
                    ]
                }
            }
        ]
    };
}
