import { createAgentRoutePreviewService } from "../../src/app/services/agent-route-preview-service.js";
import { isRouteReadyForRide } from "../../src/domain/route/route-builder.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-route-service",
    tests: [
        {
            name: "continues after skill activation then previews and confirms deterministically",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const chatMessages = [];
                const commands = [];
                let chatCount = 0;
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    draftStorage: { load: () => null, save() {} },
                    agentClient: {
                        async chat(message) {
                            chatMessages.push(message);
                            chatCount += 1;
                            return chatCount === 1
                                ? { skill_id: "discover-routes", executions: [{ tool: "activate_skill" }], presentations: [] }
                                : routeResponse("awaiting_selection");
                        },
                        async routePlanCommand(operation) {
                            commands.push(operation);
                            return routeResponse(operation === "confirm" ? "confirmed" : "awaiting_selection");
                        }
                    }
                });

                const draft = await service.planAgentRoutes("从上海出发骑 50km");
                assertEqual(draft.candidates.length, 1);
                assertEqual(chatMessages.length, 2);
                assert(chatMessages[0].includes("不请求海拔"), "首次生成应明确无海拔约束");

                await service.previewAgentRoute("candidate-1");
                assertEqual(state.route.isDraft, true);
                assert(!isRouteReadyForRide(state.route), "预览路线不能直接开骑");

                await service.confirmAgentRoute("candidate-1");
                assertEqual(state.route.isDraft, false);
                assert(isRouteReadyForRide(state.route), "确认路线应允许开骑");
                assertEqual(commands.join(","), "select,confirm");
            }
        },
        {
            name: "refines the persisted plan and supports segment composition reverse and undo",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const chatMessages = [];
                const commands = [];
                const saved = [];
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    draftStorage: {
                        load: () => parsePersistedDraft(),
                        save(draft) { saved.push(draft); }
                    },
                    agentClient: {
                        async chat(message) {
                            chatMessages.push(message);
                            return routeResponse("awaiting_selection");
                        },
                        async routePlanCommand(operation, input) {
                            commands.push({ operation, input });
                            return routeResponse("awaiting_selection");
                        }
                    }
                });

                await service.planAgentRoutes("路线再靠江边一点");
                assert(chatMessages[0].includes("当前路线计划 plan-1"), "后续语义修改应绑定现有计划");
                assert(chatMessages[0].includes("增量修改"), "后续语义修改不应重新宽泛发现");

                await service.exploreAgentRouteSegments("candidate-1");
                await service.composeAgentRouteSegments([
                    { segment_id: 101, direction: "forward" },
                    { segment_id: 202, direction: "reverse" }
                ], { candidateName: "滨江 A+B", targetDistanceKm: 52 });
                await service.reverseAgentRoute();
                await service.undoAgentRoute();

                assertEqual(commands.map((item) => item.operation).join(","), "explore_segments,compose_segments,reverse,undo");
                assertEqual(commands[1].input.segments[0].segment_id, 101);
                assertEqual(commands[1].input.segments[1].direction, "reverse");
                assertEqual(commands[1].input.target_distance_km, 52);
                assert(saved.length >= 5, "每次生成或确定性修改后都应持久化草稿");
            }
        }
    ]
};

function createOperations(state) {
    let requestId = 0;
    return {
        ensureRouteEditingAllowed: () => true,
        invalidateRequests: () => ++requestId,
        isCurrent: (value) => value === requestId,
        beginRouteRequest(statusText) {
            const id = ++requestId;
            const route = { ...state.route, isLoading: true };
            state.route = route;
            state.statusText = statusText;
            return { requestId: id, route };
        },
        clearRouteLoading(statusText) {
            state.route = { ...state.route, isLoading: false };
            state.statusText = statusText;
        },
        discardAfterRideStart: () => false,
        commitRoute(route, statusText) {
            state.route = route;
            state.statusText = statusText;
        }
    };
}

function baseRoute() {
    return { source: "manual", points: [], segments: [], totalDistanceMeters: 0 };
}

function routeResponse(planningStatus) {
    return {
        answer: "路线已生成",
        status: "completed",
        presentations: [
            {
                type: "table",
                data: { rows: [{
                    candidate: "滨江路线",
                    distance_km: 50,
                    duration_min: 140,
                    provider: "AMap",
                    mode: "BICYCLE",
                    confirmed: planningStatus === "confirmed",
                }] }
            },
            {
                type: "route_map",
                data: {
                    plan_id: "plan-1",
                    country_code: "CN",
                    planning_status: planningStatus,
                    routes: [{
                        candidate_id: "candidate-1",
                        kind: "planned_route",
                        name: "滨江路线",
                        active: true,
                        geometry: { coordinates: [[121.4, 31.2], [121.5, 31.25], [121.4, 31.2]] }
                    }]
                }
            }
        ]
    };
}

function parsePersistedDraft() {
    return {
        planId: "plan-1",
        countryCode: "CN",
        answer: "",
        planningStatus: "awaiting_selection",
        candidates: [{
            candidateId: "candidate-1",
            name: "滨江路线",
            distanceKm: 50,
            durationMinutes: 140,
            provider: "AMap",
            travelMode: "BICYCLE",
            active: true,
            coordinates: [[121.4, 31.2], [121.5, 31.25], [121.4, 31.2]]
        }],
        segments: []
    };
}
