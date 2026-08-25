import { createAgentApiClient } from "../../adapters/agent/personal-fit-agent-client.js";
import { createAgentPresentationRenderer } from "./agent-presentation-renderer.js";
import { replaceWithSafeMarkdown } from "../shared/safe-markdown-renderer.js";

const QUICK_PROMPTS = {
    activity: "详细分析我最近一次活动",
    history: "分析我最近四周的训练趋势"
};

export function createAgentFloatingWindow({
    root = document,
    schedule = setTimeout,
    seedConversation = true,
    agentClient = createAgentApiClient({ sessionStorageKey: "rider-tracker:home-agent-session-id" })
} = {}) {
    const elements = collectElements(root);
    if (!elements.window || !elements.launcher) {
        return { destroy() {}, open() {}, close() {}, setVisible() {}, sendMessage: async () => null };
    }

    const listeners = [];
    const presentationRenderer = createAgentPresentationRenderer({
        root,
        container: elements.workspaceContent,
        titleElement: elements.workspaceTitle
    });
    let requestSequence = 0;
    let contextCleared = false;
    let visible = true;
    let busy = false;

    const listen = (element, type, handler) => {
        element?.addEventListener(type, handler);
        if (element) listeners.push(() => element.removeEventListener(type, handler));
    };

    function setWindowOpen(open) {
        const shouldOpen = visible && open;
        elements.window.hidden = !shouldOpen;
        elements.window.setAttribute("aria-hidden", String(!shouldOpen));
        elements.launcher.setAttribute("aria-expanded", String(shouldOpen));
        elements.launcher.classList.toggle("is-hidden", shouldOpen);
        if (shouldOpen) {
            elements.badge.hidden = true;
            schedule(() => elements.input?.focus(), 0);
        }
    }

    function setVisible(nextVisible) {
        visible = nextVisible === true;
        elements.launcher.hidden = !visible;
        if (!visible) setWindowOpen(false);
    }

    function setExpanded(expanded) {
        elements.window.classList.toggle("is-expanded", expanded);
        elements.expandButton.setAttribute("aria-pressed", String(expanded));
        elements.expandButton.textContent = expanded ? "收起" : "展开";
        elements.expandButton.setAttribute("aria-label", expanded ? "收起工作区" : "展开工作区");
    }

    function setBusy(nextBusy) {
        busy = nextBusy;
        if (elements.sendButton) elements.sendButton.disabled = nextBusy;
        if (elements.input) elements.input.disabled = nextBusy;
    }

    function addTextMessage(role, text, { error = false } = {}) {
        const article = root.createElement("article");
        article.className = `agent-message is-${role}${error ? " is-error" : ""}`;
        const label = root.createElement("span");
        label.textContent = role === "user" ? "你" : "Agent";
        const body = root.createElement("div");
        body.className = "agent-message-body";
        if (role === "agent" && !error) {
            replaceWithSafeMarkdown(root, body, text);
        } else {
            body.textContent = text;
        }
        article.append(label, body);
        elements.messages.append(article);
        scrollMessages(elements.messages);
        return article;
    }

    function addThinkingMessage(sequence) {
        const article = root.createElement("article");
        article.className = "agent-message is-agent is-thinking";
        article.dataset.sequence = String(sequence);
        const label = root.createElement("span");
        label.textContent = "Agent";
        const body = root.createElement("div");
        body.className = "agent-message-body";
        body.textContent = "正在查询本地活动与分析上下文";
        const dots = root.createElement("i");
        dots.setAttribute("aria-hidden", "true");
        body.append(dots);
        article.append(label, body);
        elements.messages.append(article);
        scrollMessages(elements.messages);
        return article;
    }

    async function sendMessage(text, kind = inferPromptKind(text)) {
        const normalized = String(text ?? "").trim();
        if (!normalized || busy) return null;
        requestSequence += 1;
        const sequence = requestSequence;
        addTextMessage("user", normalized);
        elements.input.value = "";

        if (kind === "route") {
            const answer = "路线规划请进入“实时骑行设置 → AI 路线”，候选和地图预览会在那里联动。";
            addTextMessage("agent", answer);
            presentationRenderer.render([], { fallbackText: answer });
            updateContext("路线规划入口");
            return { answer, presentations: [] };
        }

        const thinking = addThinkingMessage(sequence);
        setBusy(true);
        try {
            const result = await agentClient.chat(normalized);
            if (sequence !== requestSequence) return null;
            thinking.remove();
            const answer = String(result?.answer || "本轮已完成，但没有返回文字说明。");
            addTextMessage("agent", answer);
            presentationRenderer.render(result?.presentations, { fallbackText: answer });
            updateContext(resolveContextLabel(result));
            if (elements.window.hidden) elements.badge.hidden = false;
            return result;
        } catch (error) {
            if (sequence !== requestSequence) return null;
            thinking.remove();
            const message = `请求失败：${error?.message || "无法连接本地 Personal FIT Agent"}`;
            addTextMessage("agent", message, { error: true });
            presentationRenderer.render([], { fallbackText: message });
            updateContext("连接失败");
            return null;
        } finally {
            if (sequence === requestSequence) setBusy(false);
        }
    }

    function updateContext(label) {
        contextCleared = false;
        elements.contextBar.hidden = false;
        elements.contextLabel.textContent = label;
    }

    function clearContext() {
        requestSequence += 1;
        setBusy(false);
        agentClient.resetSession?.();
        contextCleared = true;
        elements.contextBar.hidden = true;
        elements.messages.replaceChildren();
        presentationRenderer.clear();
        addTextMessage("agent", "已开始一个新的本地分析会话。下一条消息不会继承之前选择的活动。 ");
    }

    listen(elements.launcher, "click", () => setWindowOpen(true));
    listen(elements.closeButton, "click", () => setWindowOpen(false));
    listen(elements.minimizeButton, "click", () => setWindowOpen(false));
    listen(elements.expandButton, "click", () => setExpanded(!elements.window.classList.contains("is-expanded")));
    listen(elements.clearContextButton, "click", clearContext);
    listen(elements.composer, "submit", (event) => {
        event.preventDefault();
        void sendMessage(elements.input.value);
    });
    elements.quickPrompts?.querySelectorAll("[data-agent-prompt]").forEach((button) => {
        listen(button, "click", () => {
            const prompt = QUICK_PROMPTS[button.dataset.agentPrompt];
            if (prompt) void sendMessage(prompt, button.dataset.agentPrompt);
        });
    });

    if (seedConversation) {
        addTextMessage("agent", "你好，我可以读取本地活动数据库，分析单次活动或训练历史。路线规划请使用骑行设置中的“AI 路线”栏目。 ");
        presentationRenderer.clear();
    }

    return {
        open: () => setWindowOpen(true),
        close: () => setWindowOpen(false),
        setVisible,
        sendMessage,
        destroy() {
            requestSequence += 1;
            listeners.splice(0).forEach((remove) => remove());
        },
        getState: () => ({
            open: !elements.window.hidden,
            visible,
            expanded: elements.window.classList.contains("is-expanded"),
            contextCleared,
            busy
        })
    };
}

export function inferPromptKind(text) {
    const normalized = String(text ?? "");
    if (/实时|现在|当前强度|本组/.test(normalized)) return "live";
    if (/路线|骑一圈|途经|起点|终点|爬坡|风景/.test(normalized)) return "route";
    if (/趋势|历史|最近.*周|最近.*月|周期/.test(normalized)) return "history";
    if (/活动|分析|报告|掉速|心率/.test(normalized)) return "activity";
    return "general";
}

function resolveContextLabel(result) {
    const skill = String(result?.skill_id || "");
    if (skill.includes("training-history")) return "训练历史分析";
    if (skill.includes("activity")) return "活动分析";
    const intent = String(result?.intent || "");
    if (intent === "analyze_single") return "单次活动分析";
    if (intent.includes("history")) return "训练历史分析";
    return "本地骑行助手";
}

function collectElements(root) {
    const byId = (id) => root.getElementById?.(id) ?? null;
    return {
        launcher: byId("agentLauncher"),
        badge: byId("agentLauncherBadge"),
        window: byId("agentWindow"),
        expandButton: byId("agentExpandBtn"),
        minimizeButton: byId("agentMinimizeBtn"),
        closeButton: byId("agentCloseBtn"),
        contextBar: byId("agentWindow")?.querySelector?.(".agent-context-bar") ?? null,
        contextLabel: byId("agentContextLabel"),
        clearContextButton: byId("agentClearContextBtn"),
        messages: byId("agentMessages"),
        quickPrompts: byId("agentQuickPrompts"),
        composer: byId("agentComposer"),
        input: byId("agentMessageInput"),
        sendButton: byId("agentSendBtn"),
        workspaceTitle: byId("agentWorkspaceTitle"),
        workspaceContent: byId("agentWorkspaceContent")
    };
}

function scrollMessages(messages) {
    messages.scrollTop = messages.scrollHeight;
}
