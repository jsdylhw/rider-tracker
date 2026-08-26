import {
    createAgentFloatingWindow,
    inferPromptKind
} from "../../src/ui/agent/agent-floating-window.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeClassList } from "../helpers/fake-dom.js";

export const suite = {
    name: "agent-floating-window",
    tests: [
        {
            name: "classifies route, activity and live-ride mock prompts",
            run() {
                assertEqual(inferPromptKind("规划京都 30km 路线"), "route");
                assertEqual(inferPromptKind("分析一下这条路线的爬坡"), "route");
                assertEqual(inferPromptKind("分析最近一次活动为什么掉速"), "activity");
                assertEqual(inferPromptKind("我现在的实时强度怎么样"), "live");
                assertEqual(inferPromptKind("你好"), "general");
            }
        },
        {
            name: "opens, expands and closes without discarding window state",
            run() {
                const { root, elements } = createAgentTestDom();
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    schedule: (callback) => callback()
                });

                elements.agentLauncher.dispatch("click");
                assertEqual(windowController.getState().open, true);
                assertEqual(elements.agentWindow.attributes["aria-hidden"], "false");
                assertEqual(elements.agentLauncher.attributes["aria-expanded"], "true");

                elements.agentExpandBtn.dispatch("click");
                assertEqual(windowController.getState().expanded, true);
                assertEqual(elements.agentExpandBtn.textContent, "收起");

                elements.agentMinimizeBtn.dispatch("click");
                assertEqual(windowController.getState().open, false);
                assertEqual(windowController.getState().expanded, true);

                elements.agentLauncher.dispatch("click");
                assertEqual(windowController.getState().open, true);
                assertEqual(windowController.getState().expanded, true);

                elements.agentCloseBtn.dispatch("click");
                assertEqual(windowController.getState().open, false);
                windowController.destroy();
            }
        },
        {
            name: "clears context independently from closing the window",
            run() {
                const { root, elements } = createAgentTestDom();
                const windowController = createAgentFloatingWindow({ root, seedConversation: false });

                elements.agentClearContextBtn.dispatch("click");

                assertEqual(windowController.getState().contextCleared, true);
                assertEqual(elements.contextBar.hidden, true);
                assertEqual(elements.agentMessages.children.length, 1);
                windowController.destroy();
            }
        },
        {
            name: "hides and closes the assistant outside the home view",
            run() {
                const { root, elements } = createAgentTestDom();
                const windowController = createAgentFloatingWindow({ root, seedConversation: false });

                windowController.open();
                windowController.setVisible(false);
                assertEqual(elements.agentLauncher.hidden, true);
                assertEqual(windowController.getState().open, false);
                assertEqual(windowController.getState().visible, false);

                windowController.open();
                assertEqual(windowController.getState().open, false);

                windowController.setVisible(true);
                assertEqual(elements.agentLauncher.hidden, false);
                assertEqual(windowController.getState().open, false);
                windowController.destroy();
            }
        },
        {
            name: "sends activity questions to the real agent client and renders presentations",
            async run() {
                const { root, elements } = createAgentTestDom();
                const messages = [];
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    agentClient: {
                        async chat(message) {
                            messages.push(message);
                            return {
                                answer: "最近一次骑行负荷适中。",
                                intent: "analyze_single",
                                skill_id: "analyze-activity",
                                presentations: [{
                                    type: "metric_cards",
                                    title: "活动概览",
                                    data: { items: [{ metric: "distance_km", value: 42.1, unit: "km" }] }
                                }]
                            };
                        }
                    }
                });

                const result = await windowController.sendMessage("分析最近一次活动");

                assertEqual(messages[0], "分析最近一次活动");
                assertEqual(result.intent, "analyze_single");
                assertEqual(elements.agentWorkspaceTitle.textContent, "活动概览");
                assertEqual(elements.agentWorkspaceContent.children.length, 1);
                assertEqual(windowController.getState().busy, false);
                windowController.destroy();
            }
        },
        {
            name: "offers Garmin sync through the Rider agent instead of a second web dashboard",
            async run() {
                const { root, elements } = createAgentTestDom();
                const syncButton = createElement({ dataset: { agentPrompt: "sync" } });
                elements.agentQuickPrompts.querySelectorAll = () => [syncButton];
                const messages = [];
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    agentClient: {
                        async chat(message) {
                            messages.push(message);
                            return { answer: "同步完成。", presentations: [] };
                        }
                    }
                });

                syncButton.dispatch("click");
                await Promise.resolve();
                await Promise.resolve();

                assertEqual(messages[0], "同步 Garmin 最新一个活动并分析，不要上传 Strava");
                windowController.destroy();
            }
        }
    ]
};

function createAgentTestDom() {
    const contextBar = createElement();
    const elements = {
        agentLauncher: createElement(),
        agentLauncherBadge: createElement(),
        agentWindow: createElement({ hidden: true }),
        agentExpandBtn: createElement(),
        agentMinimizeBtn: createElement(),
        agentCloseBtn: createElement(),
        agentContextLabel: createElement(),
        agentClearContextBtn: createElement(),
        agentMessages: createElement(),
        agentQuickPrompts: createElement(),
        agentComposer: createElement(),
        agentMessageInput: createElement(),
        agentSendBtn: createElement(),
        agentWorkspaceTitle: createElement(),
        agentWorkspaceContent: createElement(),
        contextBar
    };
    elements.agentWindow.querySelector = (selector) => selector === ".agent-context-bar" ? contextBar : null;
    const root = {
        getElementById(id) { return elements[id] ?? null; },
        createElement() { return createElement(); }
    };
    return { root, elements };
}

function createElement(initial = {}) {
    const listeners = new Map();
    const element = {
        hidden: false,
        disabled: false,
        textContent: "",
        innerHTML: "",
        value: "",
        dataset: {},
        style: {},
        attributes: {},
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
        setAttribute(name, value) { element.attributes[name] = String(value); },
        append(...children) {
            element.children.push(...children);
            element.scrollHeight = element.children.length;
        },
        replaceChildren(...children) { element.children = [...children]; },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        focus() {},
        remove() {},
        dispatch(type, payload = {}) {
            for (const handler of listeners.get(type) ?? []) {
                handler({ target: element, preventDefault() {}, ...payload });
            }
        }
    };
    return Object.assign(element, initial);
}
