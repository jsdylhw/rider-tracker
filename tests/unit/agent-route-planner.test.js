import { createAgentRoutePlanner } from "../../src/ui/renderers/agent-route-planner.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeClassList } from "../helpers/fake-dom.js";

export const suite = {
    name: "agent-route-planner",
    tests: [
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
                    onRestoreAgentRouteDraft: async () => null,
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
                assertEqual(elements.aiRouteCandidates.children.length, 1);
                assertEqual(elements.aiRouteSegmentPanel.hidden, false);
                assertEqual(elements.aiRouteSegmentList.children.length, 2);

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
            active: true,
            confirmed: false,
        }],
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
