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
                const chatOptions = [];
                const commands = [];
                let chatCount = 0;
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    agentClient: {
                        async chat(message, options) {
                            chatMessages.push(message);
                            chatOptions.push(options);
                            chatCount += 1;
                            return chatCount === 1
                                ? { skill_id: "plan-routes", executions: [{ tool: "activate_skill" }], presentations: [] }
                                : routeResponse("awaiting_selection");
                        },
                        async routePlanCommand(operation, input) {
                            commands.push({ operation, input });
                            const response = routeResponse(
                                operation === "confirm" ? "confirmed" : "awaiting_selection",
                                commands.length + 1
                            );
                            if (operation === "confirm") {
                                response.saved_route = {
                                    id: "saved-agent-route",
                                    resumeDistanceMeters: 0,
                                    route: { agentMetadata: { planningStatus: "confirmed", revision: 3 } }
                                };
                            }
                            return response;
                        }
                    }
                });

                const draft = await service.planAgentRoutes("从上海出发骑 50km");
                assertEqual(draft.candidates.length, 1);
                assertEqual(chatMessages.length, 2);
                assert(chatMessages[0].includes("不请求海拔"), "首次生成应明确无海拔约束");
                assertEqual(chatOptions[0].routeOptions.include_elevation, false);
                assertEqual(chatOptions[1].routeOptions.include_elevation, false);
                assertEqual(state.route.agentCandidateId, "candidate-1");
                assertEqual(state.route.isDraft, true);
                assertEqual(state.route.mapGeometry.length, 3, "生成完成后应立即把首条候选送入地图路线状态");

                await service.previewAgentRoute("candidate-1");
                assertEqual(state.route.isDraft, true);
                assert(!isRouteReadyForRide(state.route), "预览路线不能直接开骑");

                await service.confirmAgentRoute("candidate-1");
                assertEqual(state.route.isDraft, false);
                assert(isRouteReadyForRide(state.route), "确认路线应允许开骑");
                assertEqual(commands.map((item) => item.operation).join(","), "select,confirm");
                assertEqual(commands[1].input.saved_route.agentPlanId, "plan-1");
                assertEqual(commands[1].input.saved_route.agentCandidateId, "candidate-1");
                assertEqual(commands[1].input.saved_route.route.mapGeometry.length, 3);
                assertEqual(state.route.savedRouteId, "saved-agent-route");
                assertEqual(state.route.agentMetadata.planningStatus, "confirmed");
                assertEqual(state.route.agentMetadata.revision, 3);
            }
        },
        {
            name: "refines the in-memory plan and supports segment composition reverse and undo",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const chatMessages = [];
                const commands = [];
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    agentClient: {
                        async chat(message) {
                            chatMessages.push(message);
                            return routeResponse("awaiting_selection");
                        },
                        async routePlanCommand(operation, input) {
                            commands.push({ operation, input });
                            return routeResponse("awaiting_selection", commands.length + 1);
                        }
                    }
                });

                await service.planAgentRoutes("从世博园出发生成滨江路线");
                await service.planAgentRoutes("路线再靠江边一点");
                assert(chatMessages[1].includes("当前路线计划 plan-1"), "后续语义修改应绑定当前页面内计划");
                assert(chatMessages[1].includes("增量修改"), "后续语义修改不应重新宽泛发现");

                await service.exploreAgentRouteSegments("candidate-1");
                await service.composeAgentRouteSegments([
                    { segment_id: 101, direction: "forward" },
                    { segment_id: 202, direction: "reverse" }
                ], { candidateName: "滨江 A+B", targetDistanceKm: 52 });
                await service.reverseAgentRoute();
                await service.undoAgentRoute();

                assertEqual(commands.map((item) => item.operation).join(","), "explore_segments,compose_segments,reverse,undo");
                assertEqual(chatMessages.length, 2, "右侧反转和撤销按钮不得额外调用大模型对话");
                assertEqual(commands[1].input.segments[0].segment_id, 101);
                assertEqual(commands[1].input.segments[1].direction, "reverse");
                assertEqual(commands[1].input.target_distance_km, 52);
                assertEqual(state.route.agentCandidateId, "candidate-1");
            }
        },
        {
            name: "discards a late route command after another route operation wins",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                let resolveCommand;
                const operations = createOperations(state);
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations,
                    invalidateExploration() {},
                    agentClient: {
                        async chat() { return routeResponse("awaiting_selection"); },
                        routePlanCommand() {
                            return new Promise((resolve) => { resolveCommand = resolve; });
                        }
                    }
                });
                await service.planAgentRoutes("生成路线");
                const before = state.route;
                const pending = service.reverseAgentRoute();
                operations.invalidateRequests();
                resolveCommand(routeResponse("awaiting_selection", 2));

                assertEqual(await pending, null);
                assertEqual(state.route, before);
            }
        },
        {
            name: "fails closed when confirmation does not identify the requested candidate",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    agentClient: {
                        async chat() { return routeResponse("awaiting_selection"); },
                        async routePlanCommand() {
                            const response = routeResponse("confirmed", 2);
                            response.route_plan.confirmed_candidate_id = "candidate-other";
                            return response;
                        }
                    }
                });
                await service.planAgentRoutes("生成路线");
                let error = null;
                try {
                    await service.confirmAgentRoute("candidate-1");
                } catch (caught) {
                    error = caught;
                }

                assert(error?.message.includes("确认或保存响应与当前候选不一致"));
                assertEqual(state.route.isDraft, true);
            }
        },
        {
            name: "discards a route command that finishes after the ride starts",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                let resolveCommand;
                const operations = createOperations(state);
                operations.discardAfterRideStart = () => state.liveRide.isActive;
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations,
                    invalidateExploration() {},
                    agentClient: {
                        async chat() { return routeResponse("awaiting_selection"); },
                        routePlanCommand() {
                            return new Promise((resolve) => { resolveCommand = resolve; });
                        }
                    }
                });
                await service.planAgentRoutes("生成路线");
                const before = state.route;
                const pending = service.reverseAgentRoute();
                state.liveRide.isActive = true;
                resolveCommand(routeResponse("awaiting_selection", 2));

                assertEqual(await pending, null);
                assertEqual(state.route, before);
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

function routeResponse(planningStatus, revision = 1) {
    return {
        answer: "路线已生成",
        status: "completed",
        route_plan: {
            schema_version: "route_plan_view.v1",
            plan_id: "plan-1",
            revision,
            country_code: "CN",
            planning_status: planningStatus,
            active_candidate_id: "candidate-1",
            confirmed_candidate_id: planningStatus === "confirmed" ? "candidate-1" : null,
            candidates: [{
                candidate_id: "candidate-1",
                name: "滨江路线",
                distance_m: 50_000,
                provider_duration_s: 8_400,
                provider: "AMap",
                travel_mode: "BICYCLE",
                geometry: { coordinates: [[121.4, 31.2], [121.5, 31.25], [121.4, 31.2]] },
                waypoints: [],
                segment_sequence: []
            }],
            segments: []
        },
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
