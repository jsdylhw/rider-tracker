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
            name: "parses route_plan_view and builds a no-elevation Rider route",
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
            name: "prefers the versioned route plan view over presentation labels",
            run() {
                const input = buildTurnResult();
                input.route_plan = {
                    schema_version: "route_plan_view.v1",
                    plan_id: "route-contract",
                    revision: 4,
                    country_code: "FR",
                    planning_status: "awaiting_selection",
                    active_candidate_id: "candidate-stable",
                    confirmed_candidate_id: null,
                    candidates: [{
                        candidate_id: "candidate-stable",
                        name: "勃朗峰山谷",
                        distance_m: 42_000,
                        provider_duration_s: 7_200,
                        provider: "google_routes",
                        travel_mode: "BICYCLE",
                        geometry: { coordinates: [[6.8, 45.9], [6.9, 46.0]] },
                        waypoints: [],
                        segment_sequence: [{ segment_id: 77 }]
                    }],
                    segments: [{
                        segment_id: 77,
                        name: "山谷路段",
                        distance_m: 5_000,
                        candidate_ids: ["candidate-stable"],
                        geometry: { coordinates: [[6.82, 45.92], [6.85, 45.95]] }
                    }]
                };

                const draft = parseAgentRouteDraft(input);

                assertEqual(draft.planId, "route-contract");
                assertEqual(draft.revision, 4);
                assertEqual(draft.candidates[0].candidateId, "candidate-stable");
                assertEqual(draft.candidates[0].name, "勃朗峰山谷");
                assertEqual(draft.segments[0].segmentId, 77);
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
        },
        {
            name: "does not reconstruct route state from presentation blocks",
            run() {
                let error = null;
                try {
                    parseAgentRouteDraft({
                        answer: "旧展示数据不能作为路线协议。",
                        presentations: [{
                            type: "route_map",
                            data: { plan_id: "legacy", routes: [{ candidate_id: "candidate-1" }] }
                        }]
                    });
                } catch (caught) {
                    error = caught;
                }
                assertEqual(error?.message, "旧展示数据不能作为路线协议。");
            }
        }
    ]
};

function buildTurnResult() {
    return {
        answer: "已生成两条路线。",
        status: "completed",
        route_plan: {
            schema_version: "route_plan_view.v1",
            plan_id: "route-1",
            revision: 3,
            country_code: "JP",
            planning_status: "awaiting_selection",
            active_candidate_id: "candidate-1",
            confirmed_candidate_id: null,
            candidates: [{
                candidate_id: "candidate-1",
                name: "鸭川路线",
                distance_m: 30_400,
                provider_duration_s: 5_520,
                provider: "Google",
                travel_mode: "BICYCLE",
                geometry: { coordinates: [[135.75, 35.0], [135.77, 35.03], [135.75, 35.0]] },
                waypoints: [],
                segment_sequence: [{ segment_id: 9876 }]
            }, {
                candidate_id: "candidate-2",
                name: "岚山路线",
                distance_m: 32_100,
                provider_duration_s: 6_300,
                provider: "Google",
                travel_mode: "BICYCLE",
                geometry: { coordinates: [[135.75, 35.0], [135.67, 35.01], [135.75, 35.0]] },
                waypoints: [],
                segment_sequence: [{ segment_id: 9999 }]
            }],
            segments: [{
                segment_id: 9876,
                name: "桂川景观段",
                distance_m: 6_400,
                average_grade_percent: 0.4,
                elevation_difference_m: 18,
                distance_to_route_m: 300,
                route_overlap_ratio: 0.72,
                candidate_ids: ["candidate-1"],
                geometry: { coordinates: [[135.7, 35.0], [135.71, 35.01]] }
            }, {
                segment_id: 9999,
                name: "岚山专属段",
                distance_m: 4_200,
                candidate_ids: ["candidate-2"],
                geometry: { coordinates: [[135.67, 35.01], [135.68, 35.02]] }
            }]
        }
    };
}
