import { createAgentProgress } from "../../src/ui/agent/agent-progress.js";
import {
    createAgentFloatingWindow,
    isBlockingActivityWorkflowPrompt,
    workflowConversationSummary
} from "../../src/ui/agent/agent-floating-window.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeClassList } from "../helpers/fake-dom.js";

export const suite = {
    name: "agent-floating-window",
    tests: [
        {
            name: "progress keeps queued work pending and ignores late events after finish",
            run() {
                const { root } = createAgentTestDom();
                const container = createElement();
                const timers = new Set();
                const clock = { now: () => 3000, setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } };
                const progress = createAgentProgress({ root, container, clock });
                progress.start();
                progress.update({ stage: "job", label: "生成报告", status: "queued", index: 1 });
                progress.finish({ status: "completed", executions: [{ status: "queued" }] });
                assertEqual(container.children[0].children[0].textContent, "请求已提交，等待任务结果");
                progress.update({ stage: "job", label: "生成报告", status: "completed", index: 1 });
                assertEqual(container.children[1].children[1].children[0].textContent, "生成报告 · 已排队");
                assertEqual(timers.size, 0);
                progress.clear();
                assertEqual(container.hidden, true);
            }
        },
        {
            name: "deleted remembered session opens a fresh ID instead of recreating the tombstone",
            async run() {
                const { root, elements } = createAgentTestDom();
                elements.agentSessions = createElement({ ownerDocument: root });
                let suppliedId = "not-called";
                const client = { sessionId: "deleted", selectSession(id) { this.sessionId = id; },
                    async getSession() { const error = new Error("missing"); error.status = 404; throw error; },
                    async createSession(kind, id) { suppliedId = id; return { session_id: "fresh", turns: [] }; },
                    async listSessions() { return { sessions: [{ session_id: "fresh", title: "新会话" }] }; }
                };
                const view = createAgentFloatingWindow({ root, seedConversation: false, agentClient: client });
                for (let i = 0; i < 16; i++) await Promise.resolve();
                assertEqual(suppliedId, undefined);
                assertEqual(client.sessionId, "fresh");
                assertEqual(view.getState().busy, false);
                assertEqual(elements.agentSessions.children[4].hidden, true);
                view.destroy();
            }
        },
        {
            name: "restores visible history before sending and new session has a distinct context",
            async run() {
                const { root, elements } = createAgentTestDom();
                elements.agentSessions = createElement({ ownerDocument: root });
                const chats = [];
                let resolveHistory;
                const client = { sessionId: "old", selectSession(id) { this.sessionId = id; },
                    getSession: () => new Promise((resolve) => { resolveHistory = resolve; }),
                    listSessions: async () => ({ sessions: [{ session_id: "old", title: "原会话" }, { session_id: "new", title: "新会话" }] }),
                    async createSession() { return { session_id: "new", turns: [] }; },
                    async chat(text) { chats.push(this.sessionId); return { answer: "新回答" }; }
                };
                const view = createAgentFloatingWindow({ root, seedConversation: false, agentClient: client });
                await view.sendMessage("不能提前发送");
                assertEqual(chats.length, 0);
                resolveHistory({ session_id: "old", turns: [{ message: "原问题", response: { answer: "原回答" } }] });
                for (let i = 0; i < 12; i++) await Promise.resolve();
                assertEqual(elements.agentMessages.children.length, 2);
                assertEqual(elements.agentMessages.children[0].children[1].textContent, "原问题");
                elements.agentSessions.children[1].dispatch("click");
                for (let i = 0; i < 12; i++) await Promise.resolve();
                await view.sendMessage("新问题");
                assertEqual(chats[0], "new");
                assertEqual(elements.agentMessages.children.some((item) => item.children[1]?.textContent === "原问题"), false);
                view.destroy();
            }
        },
        {
            name: "failed history restoration blocks hidden-context chat but permits retry",
            async run() {
                const { root, elements } = createAgentTestDom();
                elements.agentSessions = createElement({ ownerDocument: root });
                let attempts = 0, calls = 0;
                const client = { sessionId: "old", selectSession() {},
                    async getSession() { if (++attempts === 1) throw new Error("暂时离线"); return { session_id: "old", turns: [] }; },
                    listSessions: async () => ({ sessions: [] }), chat: async () => { calls++; return { answer: "ok" }; }
                };
                const view = createAgentFloatingWindow({ root, seedConversation: false, agentClient: client });
                for (let i = 0; i < 8; i++) await Promise.resolve();
                await view.sendMessage("不应发送");
                assertEqual(calls, 0);
                assertEqual(elements.agentSessions.children[3].disabled, false);
                elements.agentSessions.children[3].dispatch("click");
                for (let i = 0; i < 12; i++) await Promise.resolve();
                await view.sendMessage("恢复后发送");
                assertEqual(calls, 1);
                view.destroy();
            }
        },
        {
            name: "successful route card opens its captured session and failed turns expose no card",
            async run() {
                const { root, elements } = createAgentTestDom();
                const opened = [];
                const client = { sessionId: "original-session", async chat() {
                    return { answer: "草稿已生成", route_task: { status: "completed" }, route_plan: { plan_id: "plan", revision: 3 } };
                } };
                const controller = createAgentFloatingWindow({ root, seedConversation: false, agentClient: client,
                    onOpenRoute: async (reference) => opened.push(reference) });
                await controller.sendMessage("规划一圈");
                client.sessionId = "new-session";
                const button = elements.agentMessages.children.at(-1).children.at(-1);
                assertEqual(button.textContent, "打开路线草稿");
                button.dispatch("click");
                await Promise.resolve();
                assertEqual(opened[0].sessionId, "original-session");
                assertEqual(opened[0].revision, 3);
                client.chat = async () => ({ answer: "失败", error: { code: "provider_error" },
                    route_task: { status: "failed" }, route_plan: { plan_id: "old", revision: 1 } });
                await controller.sendMessage("修改路线");
                assertEqual(elements.agentMessages.children.at(-1).children.length, 2);
                controller.destroy();
            }
        },
        {
            name: "report cards survive later replies and context reset; cancel remains available without AI",
            async run() {
                const { root, elements } = createAgentTestDom();
                const id = "a".repeat(32);
                let cancelled = 0;
                const controller = createAgentFloatingWindow({ root, seedConversation: false,
                    reportJobOptions: { storage: null, schedule: () => 1, unschedule: () => {} },
                    agentClient: {
                        chat: async () => ({ answer: "已提交", presentations: [{ type: "report_job", data: { job_id: id } }] }),
                        getReportJob: async () => ({ kind: "activity_report_job", job_id: id,
                            status: cancelled ? "cancelled" : "running", total: 2, completed: 1, failed: 0, activities: [] }),
                        cancelReportJob: async () => { cancelled++; }, resetSession() {}
                    }
                });
                await controller.sendMessage("重建报告");
                for (let i = 0; i < 8; i++) await Promise.resolve();
                assertEqual(elements.agentWorkspaceContent.children.length, 1);
                await controller.sendMessage("规划路线");
                elements.agentClearContextBtn.dispatch("click");
                assertEqual(elements.agentWorkspaceContent.children.length, 1);
                controller.setCapabilities({ capabilities: { activity_analysis: false } });
                const card = elements.agentWorkspaceContent.children[0];
                const cancel = card.children.at(-1).children[0];
                assertEqual(cancel.textContent, "取消任务");
                assertEqual(Boolean(cancel.disabled), false);
                cancel.dispatch("click");
                for (let i = 0; i < 10; i++) await Promise.resolve();
                assertEqual(cancelled, 1);
                assertEqual(elements.agentWorkspaceContent.children[0].children[1].textContent, "已取消");
                controller.destroy();
            }
        },
        {
            name: "route consultation reaches chat even without activity capability",
            async run() {
                const { root } = createAgentTestDom();
                const messages = [];
                const controller = createAgentFloatingWindow({ root, seedConversation: false,
                    agentClient: { async chat(text) { messages.push(text); return { answer: "支持路线规划" }; } }
                });
                controller.setCapabilities({ backend: "available", llm: "ready", capabilities: { activity_analysis: false, ai_route_planning: true } });
                await controller.sendMessage("路线规划支持哪些功能？");
                assertEqual(messages.length, 1);
                controller.destroy();
            }
        },
        {
            name: "recognizes blocking activity workflow prompts",
            run() {
                assertEqual(isBlockingActivityWorkflowPrompt("同步最新3个活动，分析后上传 Strava"), true);
                assertEqual(isBlockingActivityWorkflowPrompt("同步 Garmin 最新一个活动并分析，不要上传 Strava"), true);
                assertEqual(isBlockingActivityWorkflowPrompt("分析最近一次活动"), false);
                assertEqual(isBlockingActivityWorkflowPrompt("规划一条骑行路线"), false);
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
            name: "shows streamed processing outside the conversation and keeps partial status",
            async run() {
                const { root, elements } = createAgentTestDom();
                let finishRequest;
                const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
                const windowController = createAgentFloatingWindow({
                    root,
                    seedConversation: false,
                    agentClient: {
                        async chat(text, options) {
                            options.onProgress({ stage: "run_activity_workflow", index: 1, status: "running", label: "处理本地活动" });
                            options.onProgress({ stage: "run_activity_workflow", index: 1, status: "partial", label: "处理本地活动" });
                            return pendingRequest;
                        }
                    }
                });

                const request = windowController.sendMessage("同步最新3个活动，分析后上传 Strava");
                assertEqual(elements.agentMessages.children.length, 1);
                assertEqual(elements.agentProgress.hidden, false);
                const steps = elements.agentProgress.children[1].children[1];
                assertEqual(steps.children[0].textContent, "处理本地活动 · 部分完成");
                assertEqual(windowController.getState().busy, true);

                finishRequest({ status: "completed", answer: "部分完成。", executions: [{ status: "partial" }], presentations: [] });
                await request;
                assertEqual(elements.agentProgress.children[0].children[0].textContent, "部分步骤未完成，请查看结果");
                assertEqual(windowController.getState().busy, false);
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
        agentProgress: createElement(),
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
