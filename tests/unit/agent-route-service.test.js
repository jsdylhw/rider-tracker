import { createAgentRoutePreviewService } from "../../src/app/services/agent-route-preview-service.js";
import { parseAgentRouteDraft } from "../../src/domain/route/agent-route-contract.js";
import { isRouteReadyForRide } from "../../src/domain/route/route-builder.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "agent-route-service",
    tests: [
        {
            name: "failed daily regeneration restores previous route as preview only",
            async run() {
                const state={route:baseRoute(),liveRide:{isActive:false}};
                const r=routeResponse("awaiting_selection",5);
                Object.assign(r.route_plan,{schedule_type:"multi_day",itinerary_schema_version:"cycling_itinerary.v1"});
                const day=r.route_plan.candidates[0];
                const previous={...day,waypoint_queries:["A","B"]};
                Object.assign(day,{day:1,day_status:"failed",confirmed:false,geometry:null,distance_m:null,
                    provider_duration_s:null,waypoint_queries:["A","C"],previous_route:previous});
                const service=createAgentRoutePreviewService({
                    store:{getState:()=>state,setState:fn=>Object.assign(state,fn(state))},
                    operations:createOperations(state),agentClient:{routePlanCommand:async()=>r}});
                const draft=await service.restoreAgentRouteSession({session_id:"daily",route_reference:{plan_id:"plan-1",revision:4}});
                assertEqual(draft.candidates[0].previousRoute,true);
                assertEqual(draft.candidates[0].pointNames[1],"C");
                assertEqual(draft.candidates[0].previousPointNames[1],"B");
                assert(state.route.points.length>0,"previous geometry should remain previewable");
                assertEqual(state.route.isDraft,true);
                assertEqual(isRouteReadyForRide(state.route),false);
                assert(state.statusText.includes("上次成功路线"));
            }
        },
        {
            name: "persisted daily failure retains revision, confirmation and actual travel mode",
            run() {
                const r=routeResponse("awaiting_selection",3);
                Object.assign(r.route_plan,{schedule_type:"multi_day",itinerary_schema_version:"cycling_itinerary.v1"});
                Object.assign(r.route_plan.candidates[0],{day:1,day_status:"ready",confirmed:true,travel_mode:"DRIVE",provider_duration_s:1800});
                r.route_plan.candidates.push({...r.route_plan.candidates[0],candidate_id:"day_2",day:2,day_status:"failed",confirmed:false,geometry:null});
                r.error={code:"rate_limit",provider:"amap",stage:"route",retryable:true,message:"地图繁忙"};
                r.route_operation={schema_version:"route_operation.v1",status:"failed",plan_id:r.route_plan.plan_id,
                    revision:3,candidate_id:r.route_plan.candidates[1].candidate_id};
                const draft=parseAgentRouteDraft(r);
                assertEqual(draft.revision,3);
                assertEqual(draft.operationError.code,"rate_limit");
                assertEqual(draft.candidates[0].confirmed,true);
                assertEqual(draft.candidates[0].durationMinutes,30);
                assertEqual(draft.candidates[0].durationLabel,"地图驾车时间（虚拟观景路径）");
                let rejected=false;
                try {parseAgentRouteDraft({...r,route_operation:{...r.route_operation,revision:2}});} catch {rejected=true;}
                assert(rejected,"stale failure artifact must not be accepted");
            }
        },
        {
            name: "daily draft restores without a map and generate day routes only the selected day",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false } };
                const calls=[];
                let failGeneration=false;
                function response(ready, revision) {
                    const r=routeResponse("awaiting_selection",revision);
                    Object.assign(r.route_plan,{schedule_type:"multi_day",itinerary_schema_version:"cycling_itinerary.v1"});
                    Object.assign(r.route_plan.candidates[0],{day:1,day_status:ready?"ready":"pending",waypoint_queries:["A","B"]});
                    if(!ready) r.route_plan.candidates[0].geometry=null;
                    if(failGeneration) {
                        r.route_plan.revision=4;
                        r.route_plan.candidates[0].day_status="failed";
                        r.route_plan.candidates[0].geometry=null;
                        r.status="failed";
                        r.error={code:"rate_limit",message:"地图繁忙"};
                        r.route_operation={schema_version:"route_operation.v1",status:"failed",plan_id:r.route_plan.plan_id,
                            revision:4,candidate_id:r.route_plan.candidates[0].candidate_id};
                    }
                    return r;
                }
                const service=createAgentRoutePreviewService({store:{getState:()=>state,setState:fn=>Object.assign(state,fn(state))},
                    operations:createOperations(state),agentClient:{async routePlanCommand(op,args){calls.push({op,args});return response(op==="generate_day",op==="generate_day"?3:1);}}});
                await service.restoreAgentRouteSession({session_id:"days",route_reference:{plan_id:"plan-1",revision:1}});
                assertEqual(state.agentRouteDraft.dailyItinerary,true);
                assertEqual(state.route.points.length,0);
                await service.previewAgentRoute("candidate-1",{generate:true});
                assertEqual(calls[1].op,"generate_day");
                assertEqual(calls[1].args.expected_revision,1);
                assertEqual(state.agentRouteDraft.candidates[0].dayStatus,"ready");
                assertEqual(state.route.agentCandidateId,"candidate-1");
                failGeneration=true;
                const failed=await service.previewAgentRoute("candidate-1",{generate:true});
                assertEqual(failed.operationError.code,"rate_limit");
                assertEqual(state.agentRouteDraft.revision,4);
                assertEqual(state.agentRouteDraft.candidates[0].dayStatus,"failed");
                assertEqual(state.route.points.length,0);
            }
        },
        {
            name: "switching route sessions restores the plan and new context cannot refine the old draft",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false } };
                const calls = [];
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state, setState: (fn) => Object.assign(state, fn(state)) },
                    operations: createOperations(state),
                    agentClient: {
                        routePlanCommand: async () => routeResponse("awaiting_selection"),
                        chat: async (message, options) => { calls.push(options); return routeResponse("awaiting_selection"); }
                    }
                });
                await service.restoreAgentRouteSession({ session_id: "old", route_reference: { plan_id: "plan-1", revision: 1 } });
                assertEqual(state.agentRouteDraft.planId, "plan-1");
                await service.restoreAgentRouteSession({ session_id: "new", route_reference: null });
                assertEqual(state.agentRouteDraft, null);
                assertEqual(Boolean(state.route.agentPlanId), false);
                await service.planAgentRoutes("京都");
                assertEqual(calls[0].sessionId, "new");
                assertEqual(calls[0].routeAction, "create");
                assertEqual(calls[0].routeReference, null);
            }
        },
        {
            name: "opens the exact chat draft and keeps its owner for edits without recreating",
            async run() {
                let state = { route: baseRoute(), liveRide: { isActive: false } };
                const commands = [], chats = [];
                const operations = createOperations(state);
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state, setState: (fn) => { Object.assign(state, fn(state)); } },
                    operations,
                    agentClient: {
                        async routePlanCommand(operation, input) { commands.push({ operation, input }); return routeResponse("awaiting_selection"); },
                        async chat(message, options) { chats.push(options); return routeResponse("awaiting_selection", 2); }
                    }
                });
                await service.openAgentRoute({ planId: "plan-1", revision: 1, sessionId: "home-session" });
                assertEqual(commands.length, 1);
                assertEqual(commands[0].operation, "get");
                assertEqual(commands[0].input.expected_revision, 1);
                assertEqual(commands[0].input.session_id, "home-session");
                assertEqual(chats.length, 0);
                assertEqual(state.agentRouteDraft.planId, "plan-1");
                assertEqual(state.route.isDraft, true);
                await service.planAgentRoutes("少左转");
                assertEqual(chats[0].sessionId, "home-session");
                assertEqual(chats[0].routeReference.revision, 1);
                await service.previewAgentRoute("candidate-1");
                assertEqual(commands[1].input.session_id, "home-session");
            }
        },
        {
            name: "stale or late draft loads cannot replace the route",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false } };
                const before = state.route;
                const operations = createOperations(state);
                let resolve;
                const service = createAgentRoutePreviewService({ store: { getState: () => state }, operations,
                    agentClient: { routePlanCommand: () => new Promise((done) => { resolve = done; }) }
                });
                const stale = service.openAgentRoute({ planId: "plan-1", revision: 1, sessionId: "owner" });
                resolve(routeResponse("awaiting_selection", 2));
                let rejected = false;
                try { await stale; } catch { rejected = true; }
                assertEqual(rejected, true);
                assertEqual(state.route, before);
                const late = service.openAgentRoute({ planId: "plan-1", revision: 1, sessionId: "owner" });
                operations.invalidateRequests();
                resolve(routeResponse("awaiting_selection"));
                assertEqual(await late, null);
                assertEqual(state.route, before);
            }
        },
        {
            name: "returns clarification normally without replacing the existing draft",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const options = [];
                let count = 0;
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state }, operations: createOperations(state),
                    agentClient: { async chat(message, input) {
                        options.push(input);
                        return ++count === 1 ? routeResponse("awaiting_selection")
                            : { status: "clarification_required", answer: "改到哪个城市？" };
                    } }
                });
                await service.planAgentRoutes("生成路线");
                const result = await service.planAgentRoutes("换个地方");
                assertEqual(result.clarificationRequired, true);
                assertEqual(result.answer, "改到哪个城市？");
                assertEqual(options[1].routeReference.plan_id, "plan-1");
                assertEqual(options[1].routeReference.revision, 1);
            }
        },
        {
            name: "previews and confirms one deterministic route response",
            async run() {
                const state = { route: baseRoute(), liveRide: { isActive: false }, statusText: "" };
                const chatMessages = [];
                const chatOptions = [];
                const commands = [];
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    agentClient: {
                        async chat(message, options) {
                            chatMessages.push(message);
                            chatOptions.push(options);
                            return routeResponse("awaiting_selection");
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
                assertEqual(chatMessages.length, 1);
                assert(chatMessages[0].includes("3 条有实质区别"), "开放式首次生成应明确要求三个候选");
                assert(chatMessages[0].includes("模拟坡度按 0"), "首次生成应明确平坡模拟约束");
                assertEqual(chatOptions[0].routeOptions.include_ascent, true);
                assertEqual(chatOptions[0].routeOptions.include_elevation, false);
                assertEqual(chatOptions[0].requestMode, "route_plan");
                assertEqual(chatOptions[0].routeAction, "create");
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
                const chatOptions = [];
                const commands = [];
                const service = createAgentRoutePreviewService({
                    store: { getState: () => state },
                    operations: createOperations(state),
                    invalidateExploration() {},
                    agentClient: {
                        async chat(message, options) {
                            chatMessages.push(message);
                            chatOptions.push(options);
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
                assertEqual(chatOptions[0].routeAction, "create");
                assertEqual(chatOptions[1].routeAction, "refine");
                assert(chatMessages[1].includes("当前路线计划 plan-1"), "后续语义修改应绑定当前页面内计划");
                assert(chatMessages[1].includes("重新准备并生成三条"));
                assert(chatMessages[1].includes("跨区域"), "后续请求应允许跨区域时重建计划");

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
