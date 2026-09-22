import { createAgentSessionControls } from "../../src/ui/agent/agent-session-controls.js";
import { createAgentRoutePlanner } from "../../src/ui/renderers/agent-route-planner.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeClassList } from "../helpers/fake-dom.js";

export const suite = {
    name: "agent-route-planner",
    tests: [
        {
            name: "previous daily route is labeled separately and cannot be confirmed",
            run() {
                const {elements}=createPlannerDom();
                const draft=buildDraft(); draft.dailyItinerary=true;
                Object.assign(draft.candidates[0],{day:1,dayStatus:"failed",previousRoute:true,
                    previousPointNames:["A","B"],pointNames:["A","C"],confirmed:false});
                const planner=createAgentRoutePlanner({elements});
                planner.render({agentRouteDraft:draft,route:{},liveRide:{isActive:false}});
                const card=elements.aiRouteCandidates.children[0];
                assert(card.children[0].children[1].textContent.includes("上次成功路线"));
                assert(card.children[0].children[2].textContent.includes("A → B"));
                assertEqual(card.children[1].children[0].textContent,"预览上次路线");
                assertEqual(card.children[1].children[1].disabled,true);
                planner.destroy();
            }
        },
        {
            name: "daily itinerary displays draft states and generates a day without confirming it",
            async run() {
                const {elements}=createPlannerDom();
                const draft=buildDraft(); draft.dailyItinerary=true;
                Object.assign(draft.candidates[0],{day:1,dayStatus:"pending",pointNames:["A","B"],coordinates:[],distanceRangeKm:[50,100]});
                const calls=[];
                const planner=createAgentRoutePlanner({elements,onPreviewAgentRoute:async(id,options)=>{calls.push({id,options});return draft;}});
                planner.render({agentRouteDraft:draft,route:{},liveRide:{isActive:false}});
                const card=elements.aiRouteCandidates.children[0];
                assert(card.children[0].children[1].textContent.includes("待生成"));
                assertEqual(card.children[1].children[1].disabled,true);
                card.children[1].children[2].dispatch("click");
                await flushPromises();
                assertEqual(calls[0].options.generate,true);
                planner.destroy();
            }
        },
        {
            name: "failed empty session can be deleted without persisting another empty session",
            async run() {
                const { documentRef } = createPlannerDom();
                const toolbar = createElement({ ownerDocument: documentRef });
                let stored = [{ session_id: "empty", title: "新规划", turns: [] }];
                let created = 0;
                const deleted = [];
                const client = { sessionId: "empty", selectSession(id) { this.sessionId = id; },
                    async getSession() { return stored[0]; },
                    async listSessions() { return { sessions: stored }; },
                    async deleteSession(id) { deleted.push(id); stored = []; },
                    async createSession() { created++; throw new Error("must not persist an empty replacement"); },
                    createDraftSession() { return { session_id: "local", title: "新规划", turns: [], local_draft: true }; }
                };
                const controls = createAgentSessionControls({ container: toolbar, client, kind: "route_plan",
                    onLoad(detail) { if (detail.session_id === "empty") throw new Error("草稿恢复失败"); } });
                await controls.restore();
                assertEqual(toolbar.children[2].disabled, false);
                toolbar.children[2].dispatch("click");
                toolbar.children[5].children[2].children[1].dispatch("click");
                await flushPromises();
                assertEqual(deleted[0], "empty");
                assertEqual(stored.length, 0);
                assertEqual(created, 0);
                assertEqual(client.sessionId, "local");
                controls.destroy();
            }
        },
        {
            name: "route session restores clickable candidates and confirmed deletion opens another session",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                const toolbar = createElement({ ownerDocument: documentRef });
                documentRef.getElementById = (id) => id === "aiRouteSessions" ? toolbar : null;
                const details = {
                    one: { session_id: "one", title: "京都", turns: [{ message: "原问题", response: { answer: "原路线" } }] },
                    two: { session_id: "two", title: "杭州", turns: [{ message: "杭州环线", response: { answer: "杭州路线" } }] },
                    fresh: { session_id: "fresh", title: "新会话", turns: [] }
                };
                const deleted = [];
                const client = { sessionId: "one", selectSession(id) { this.sessionId = id; },
                    async getSession(id = this.sessionId) { return details[id]; },
                    async listSessions() { return { sessions: Object.values(details) }; },
                    async deleteSession(id) { deleted.push(id); delete details[id]; },
                    async createSession() { return details.fresh; }
                };
                const planner = createAgentRoutePlanner({ elements, agentSessionClient: client,
                    onRestoreAgentRouteSession: async (detail) => detail.session_id === "fresh" ? null : buildDraft() });
                planner.render({ route: {}, liveRide: { isActive: false } });
                await flushPromises();
                assertEqual(elements.aiRouteMessages.children[0].messageBody.textContent, "原问题");
                toolbar.children[0].value = "two";
                toolbar.children[0].dispatch("change");
                await flushPromises();
                assertEqual(client.sessionId, "two");
                assertEqual(elements.aiRouteMessages.children[0].messageBody.textContent, "杭州环线");
                const previewButton = elements.aiRouteCandidates.children[0].children[1].children[0];
                assertEqual(previewButton.disabled, false);
                toolbar.children[2].dispatch("click");
                assertEqual(deleted.length, 0);
                toolbar.children[5].children[2].children[0].dispatch("click");
                assertEqual(deleted.length, 0);
                toolbar.children[2].dispatch("click");
                toolbar.children[5].children[2].children[1].dispatch("click");
                await flushPromises();
                assertEqual(deleted[0], "two");
                assertEqual(client.sessionId, "one");
                assert(elements.aiRouteCandidates.children.length > 0);
                assertEqual(elements.aiRouteProgress.hidden, true);
                planner.destroy();
            }
        },
        {
            name: "keeps completed progress after a route failure and ignores late events",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                let onProgress;
                const planner = createAgentRoutePlanner({ elements, onPlanAgentRoutes: async (_, options) => {
                    onProgress = options.onProgress;
                    onProgress({ stage: "search_cycling_routes", status: "completed" });
                    onProgress({ stage: "map_retry", status: "running" });
                    assertEqual(elements.aiRouteProgressStatus.textContent, "地图服务繁忙，正在等待重试");
                    onProgress({ stage: "map_retry", status: "completed" });
                    assertEqual(elements.aiRouteProgressStatus.textContent, "正在重新请求地图服务");
                    onProgress({ stage: "prepare_route_materials", status: "failed" });
                    throw new Error("地图连接失败");
                } });
                elements.aiRoutePanel.ownerDocument = documentRef;
                planner.render({ route: {}, liveRide: { isActive: false } });
                await planner.sendMessage("京都30km");
                assertEqual(elements.aiRouteMessages.children.length, 3);
                assert(elements.aiRouteProgressSteps.children[0].textContent.includes("已完成"));
                assert(elements.aiRouteProgressSteps.children[1].textContent.includes("未完成"));
                assertEqual(elements.aiRouteProgressStatus.textContent, "本次处理未完成");
                const before = elements.aiRouteProgressStatus.textContent;
                onProgress({ stage: "create_route_plan", status: "completed" });
                assertEqual(elements.aiRouteProgressStatus.textContent, before);
                planner.destroy();
            }
        },
        {
            name: "conversation displays provider warnings instead of only the success summary",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                elements.aiRoutePanel.ownerDocument = documentRef;
                const draft = { ...buildDraft(), researchSources: [{ title: "隐藏参考", url: "https://example.org" }] };
                draft.candidates[0].description = "从京都站出发，经鸭川返回。";
                const planner = createAgentRoutePlanner({ elements, onPlanAgentRoutes: async () => draft });
                planner.bindEvents();
                planner.render({ route: {}, liveRide: { isActive: false } });
                await planner.sendMessage("京都市内风景好的 30 km 环线");
                const text = elements.aiRouteMessages.children.at(-1).messageBody.textContent;
                assert(text.includes("路线提示：距离偏离目标"));
                assert(text.includes("无效候选（地点没有结果）"));
                const copy = elements.aiRouteCandidates.children[0].children[0];
                assert(copy.children.some((node) => node.textContent.includes("从京都站出发")));
                assert(!copy.children.some((node) => node.textContent.includes("参考资料")));
                planner.destroy();
            }
        },
        {
            name: "shows route clarification as a normal answer without creating candidates",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                elements.aiRoutePanel.ownerDocument = documentRef;
                const planner = createAgentRoutePlanner({
                    elements, onPlanAgentRoutes: async () => ({
                        clarificationRequired: true, answer: "从哪个城市出发？"
                    })
                });
                planner.bindEvents();
                planner.render({ route: {}, liveRide: { isActive: false } });
                await planner.sendMessage("骑一圈");
                assertEqual(elements.aiRouteMessages.children.at(-1).messageBody.textContent, "从哪个城市出发？");
                assertEqual(elements.aiRouteCandidates.children.length, 0);
                planner.destroy();
            }
        },
        {
            name: "renders candidate confirmation and ordered clickable Strava segments",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                const composed = [];
                const confirmed = [];
                const draft = buildDraft();
                const planner = createAgentRoutePlanner({
                    elements,
                    onPlanAgentRoutes: async () => draft,
                    onPreviewAgentRoute: async () => draft,
                    onConfirmAgentRoute: async (candidateId) => {
                        confirmed.push(candidateId);
                        return {
                            draft: {
                                ...draft,
                                planningStatus: "confirmed",
                                candidates: draft.candidates.map((item) => ({ ...item, confirmed: true }))
                            }
                        };
                    },
                    onExploreAgentRouteSegments: async () => draft,
                    onComposeAgentRouteSegments: async (segments) => {
                        composed.push(segments);
                        return draft;
                    },
                    onReverseAgentRoute: async () => draft,
                    onUndoAgentRoute: async () => draft,
                });
                elements.aiRoutePanel.ownerDocument = documentRef;
                planner.bindEvents();
                planner.render({ route: {}, liveRide: { isActive: false } });

                await planner.sendMessage("从世博园出发沿江骑 50km");
                const answer = elements.aiRouteMessages.children.at(-1).messageBody.textContent;
                assert(answer.includes("已生成 1 条路线候选。"));
                assert(answer.includes("另有 1 条未能生成：无效候选（地点没有结果）"));
                assert(answer.includes("\n\n当前预览：滨江路线"));
                assertEqual(elements.aiRouteCandidates.children.length, 1);
                assert(elements.aiRouteCandidates.children[0].children[0].children[3].textContent.includes("距离偏离目标"));
                assertEqual(elements.aiRouteSegmentPanel.hidden, false);
                assertEqual(elements.aiRouteSegmentList.children.length, 2);
                const generatedActions = elements.aiRouteCandidates.children[0].children[1];
                assertEqual(generatedActions.children[0].disabled, false, "生成结束后预览按钮必须解除 disabled");
                assertEqual(generatedActions.children[1].disabled, false, "生成结束后确认按钮必须解除 disabled");

                elements.aiRouteSegmentList.children[0].dispatch("click");
                elements.aiRouteSegmentList.children[1].dispatch("click");
                assert(elements.aiRouteSegmentSelection.textContent.includes("滨江 A → 滨江 B"));
                elements.aiRouteComposeSegmentsBtn.dispatch("click");
                await flushPromises();
                assertEqual(composed[0].map((item) => item.segment_id).join(","), "101,202");

                const candidateActions = elements.aiRouteCandidates.children[0].children[1];
                candidateActions.children[1].dispatch("click");
                await flushPromises();
                assertEqual(confirmed[0], "candidate-1");
                assert(elements.aiRouteResultStatus.textContent.includes("已确认"));
                planner.destroy();
            }
        },
        {
            name: "updates the pending chat message while route providers are still working",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                let resolvePlan;
                let now = 0;
                let tick = null;
                let onProgress;
                const planner = createAgentRoutePlanner({
                    elements,
                    onPlanAgentRoutes: (_, options) => new Promise((resolve) => { resolvePlan = resolve; onProgress = options.onProgress; }),
                    progressClock: {
                        now: () => now,
                        setInterval(callback) { tick = callback; return 1; },
                        clearInterval() { tick = null; },
                    },
                });
                elements.aiRoutePanel.ownerDocument = documentRef;
                planner.render({ route: {}, liveRide: { isActive: false } });

                const pendingPlan = planner.sendMessage("马来西亚沿海 30km");
                now = 40_000;
                tick();
                assertEqual(elements.aiRouteMessages.children.length, 2, "进度不能加入聊天气泡");
                assertEqual(elements.aiRouteProgress.hidden, false);
                onProgress({ stage: "search_cycling_routes", status: "completed" });
                onProgress({ stage: "prepare_route_materials", status: "failed" });
                onProgress({ stage: "prepare_route_materials", status: "running" });
                assert(elements.aiRouteProgressStatus.textContent.includes("正在处理：定位"));
                assertEqual(elements.aiRouteProgressElapsed.textContent, "40 秒");
                onProgress({ stage: "prepare_route_materials", status: "completed" });
                assertEqual(elements.aiRouteProgressSteps.children.length, 2);
                assert(elements.aiRouteProgressSteps.children[1].textContent.includes("已完成"));
                assert(!elements.aiRouteProgressSteps.children[1].textContent.includes("未完成"));
                resolvePlan(buildDraft());
                await pendingPlan;
                assertEqual(tick, null, "路线完成后必须停止进展计时器");
                assertEqual(elements.aiRouteProgressStatus.textContent, "处理完成");
                planner.destroy();
            }
        },
        {
            name: "disables AI route controls without blocking other route modes",
            async run() {
                const { documentRef, elements } = createPlannerDom();
                let calls = 0;
                const planner = createAgentRoutePlanner({
                    elements,
                    onPlanAgentRoutes: async () => { calls += 1; return buildDraft(); }
                });
                elements.aiRoutePanel.ownerDocument = documentRef;
                planner.render({
                    route: {}, liveRide: { isActive: false },
                    agentCapabilities: {
                        backend: "available", llm: "not_configured",
                        capabilities: { ai_route_planning: false }
                    }
                });

                await planner.sendMessage("生成 30km 路线");

                assertEqual(elements.aiRouteSendBtn.disabled, true);
                assertEqual(elements.aiRouteResultStatus.textContent.includes("尚未配置"), true);
                assertEqual(calls, 0);
                planner.destroy();
            }
        }
    ]
};

function buildDraft() {
    return {
        planId: "plan-1",
        countryCode: "CN",
        answer: "已生成候选",
        planningStatus: "awaiting_selection",
        candidates: [{
            candidateId: "candidate-1",
            name: "滨江路线",
            distanceKm: 50,
            durationMinutes: 120,
            provider: "AMap",
            stravaSegments: "",
            warnings: ["距离偏离目标"],
            active: true,
            confirmed: false,
        }],
        rejectedCandidates: [{ name: "无效候选", reason: "地点没有结果" }],
        segments: [
            { segmentId: 101, name: "滨江 A", distanceKm: 6, averageGradePercent: 0, distanceToRouteKm: 0.2, candidateIds: ["candidate-1"] },
            { segmentId: 202, name: "滨江 B", distanceKm: 8, averageGradePercent: 0.2, distanceToRouteKm: 0.4, candidateIds: ["candidate-1"] },
        ]
    };
}

function createPlannerDom() {
    const documentRef = { createElement: () => createElement() };
    const elements = {
        aiRoutePanel: createElement({ ownerDocument: documentRef }),
        aiRouteMessages: createElement(),
        aiRouteProgress: createElement({ hidden: true }),
        aiRouteProgressStatus: createElement(),
        aiRouteProgressElapsed: createElement(),
        aiRouteProgressSteps: createElement(),
        aiRouteComposer: createElement(),
        aiRouteMessageInput: createElement(),
        aiRouteSendBtn: createElement(),
        aiRouteCandidates: createElement(),
        aiRouteResultTitle: createElement(),
        aiRouteResultStatus: createElement(),
        aiRouteReverseBtn: createElement(),
        aiRouteUndoBtn: createElement(),
        aiRouteExploreSegmentsBtn: createElement(),
        aiRouteSegmentPanel: createElement({ hidden: true }),
        aiRouteSegmentList: createElement(),
        aiRouteSegmentSelection: createElement(),
        aiRouteComposeSegmentsBtn: createElement(),
        aiRouteClearSegmentsBtn: createElement(),
        aiRoutePromptButtons: [],
    };
    return { documentRef, elements };
}

function createElement(initial = {}) {
    const listeners = new Map();
    const element = {
        hidden: false,
        disabled: false,
        textContent: "",
        value: "",
        title: "",
        dataset: {},
        children: [],
        scrollHeight: 0,
        scrollTop: 0,
        className: "",
        classList: createFakeClassList(),
        setAttribute() {},
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler));
        },
        append(...children) {
            element.children.push(...children);
            element.scrollHeight = element.children.length;
        },
        replaceChildren(...children) { element.children = [...children]; },
        querySelectorAll() { return []; },
        remove() {},
        dispatch(type, payload = {}) {
            for (const handler of listeners.get(type) ?? []) {
                handler({ target: element, preventDefault() {}, ...payload });
            }
        }
    };
    return Object.assign(element, initial);
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}
