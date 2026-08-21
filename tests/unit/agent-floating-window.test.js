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
