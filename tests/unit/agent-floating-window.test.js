import {
    createAgentFloatingWindow,
    inferPromptKind,
    workflowConversationSummary
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
        },
        {
            name: "summarizes structured activity workflows in the conversation",
            run() {
                const answer = workflowConversationSummary({
                    presentations: [{
                        type: "activity_workflow",
                        data: {
                            summary: {
                                total: 3,
                                analysis_completed: 3,
                                strava_completed: 2,
                                strava_pending: 1,
                                strava_failed: 0
                            }
                        }
                    }]
                });

                assertEqual(answer, "已处理 3 条活动：分析 3/3，Strava 2 条完成，1 条等待确认。详细状态见右侧。");
            }
        },
        {
            name: "renders activity workflow cards instead of markdown fallback",
            async run() {
                const { root, elements } = createAgentTestDom();
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    agentClient: {
                        async chat() {
                            return {
                                answer: "处理部分完成：很长的原始工作流文本。",
                                presentations: [{
                                    type: "activity_workflow",
                                    title: "活动处理结果",
                                    data: {
                                        summary: {
                                            total: 1,
                                            analysis_completed: 1,
                                            strava_completed: 0,
                                            strava_pending: 1,
                                            strava_failed: 0
                                        },
                                        activities: [{
                                            title: "夜间轻松恢复骑",
                                            started_at: "2026-08-27T21:43:42",
                                            status: "pending",
                                            analysis: { status: "success", label: "分析完成", detail: "报告已生成" },
                                            strava: { status: "pending", label: "等待确认", detail: "FIT 已提交" }
                                        }]
                                    }
                                }]
                            };
                        }
                    }
                });

                await windowController.sendMessage("同步并上传");

                assertEqual(elements.agentWorkspaceTitle.textContent, "活动处理结果");
                assertEqual(elements.agentWorkspaceContent.children[0].classList.contains("agent-workflow-result"), true);
                const messageBody = elements.agentMessages.children.at(-1).children[1];
                const summaryText = messageBody.children[0].children[0].textContent;
                assertEqual(summaryText.includes("已处理 1 条活动"), true);
                assertEqual(summaryText.includes("很长的原始工作流文本"), false);
                windowController.destroy();
            }
        },
        {
            name: "disables only assistant controls when llm is not configured",
            async run() {
                const { root, elements } = createAgentTestDom();
                let calls = 0;
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    agentClient: { async chat() { calls += 1; } }
                });
                windowController.setCapabilities({
                    backend: "available",
                    llm: "not_configured",
                    capabilities: { activity_analysis: false }
                });

                await windowController.sendMessage("分析最后一个活动");

                assertEqual(elements.agentMessageInput.disabled, true);
                assertEqual(elements.agentSendBtn.disabled, true);
                assertEqual(calls, 0);
                assertEqual(elements.agentMessages.children.at(-1).children[1].textContent.includes("尚未配置"), true);
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
