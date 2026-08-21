const MOCK_PROMPTS = {
    route: "规划一个京都市内风景好一点的 30 km 骑行路线",
    activity: "分析我最近一次骑行活动",
    live: "看一下我现在的骑行强度"
};

export function createAgentFloatingWindow({
    root = document,
    delayMs = 420,
    schedule = setTimeout,
    seedConversation = true
} = {}) {
    const elements = collectElements(root);
    if (!elements.window || !elements.launcher) {
        return { destroy() {}, open() {}, close() {} };
    }

    const listeners = [];
    let requestSequence = 0;
    let contextCleared = false;

    const listen = (element, type, handler) => {
        element?.addEventListener(type, handler);
        if (element) listeners.push(() => element.removeEventListener(type, handler));
    };

    function setWindowOpen(open) {
        elements.window.hidden = !open;
        elements.window.setAttribute("aria-hidden", String(!open));
        elements.launcher.setAttribute("aria-expanded", String(open));
        elements.launcher.classList.toggle("is-hidden", open);
        if (open) {
            elements.badge.hidden = true;
            schedule(() => elements.input?.focus(), 0);
        }
    }

    function setExpanded(expanded) {
        elements.window.classList.toggle("is-expanded", expanded);
        elements.expandButton.setAttribute("aria-pressed", String(expanded));
        elements.expandButton.textContent = expanded ? "收起" : "展开";
        elements.expandButton.setAttribute("aria-label", expanded ? "收起工作区" : "展开工作区");
    }

    function addTextMessage(role, text) {
        const article = root.createElement("article");
        article.className = `agent-message is-${role}`;
        const label = root.createElement("span");
        label.textContent = role === "user" ? "你" : "Agent";
        const body = root.createElement("p");
        body.textContent = text;
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
        const body = root.createElement("p");
        body.textContent = "正在整理本地上下文与结构化结果";
        const dots = root.createElement("i");
        dots.setAttribute("aria-hidden", "true");
        body.append(dots);
        article.append(label, body);
        elements.messages.append(article);
        scrollMessages(elements.messages);
        return article;
    }

    function addRouteResponse() {
        updateContext("全局骑行助手");
        addTextMessage("agent", "路线规划已移到“实时骑行设置 → AI 路线”栏目。请在那里继续对话，候选会直接联动页面中的唯一地图；浮窗保留活动分析和实时骑行问答。 ");
        elements.workspaceTitle.textContent = "前往 AI 路线栏目";
        elements.workspaceContent.replaceChildren(
            createNote(root, "进入实时骑行设置，选择“AI 路线”。路线对话、候选比较和地图预览会在同一页面完成。")
        );
        scrollMessages(elements.messages);
    }

    function addActivityResponse() {
        updateContext("最近活动 · 公路骑行");
        addTextMessage("agent", "最近一次活动整体负荷适中，后半程心率持续抬升，功率保持得比心率更稳定。下面先给出适合浮窗阅读的摘要。 ");
        const card = root.createElement("section");
        card.className = "agent-insight-card";
        card.append(
            createCardHeader(root, "活动分析", "2026-08-19 · 公路骑行"),
            createMetricGrid(root, [
                ["距离", "42.1 km"], ["时间", "1:36:20"], ["NP", "186 W"], ["训练负荷", "76 TSS"]
            ]),
            createNote(root, "后 30 分钟平均心率比前段高 9 bpm，但功率仅下降 3%，更像热应激或补水不足，而不是明显掉功率。")
        );
        elements.messages.append(card);
        renderActivityWorkspace();
        scrollMessages(elements.messages);
    }

    function addLiveResponse() {
        updateContext("实时骑行 · 阈值训练 2/4");
        addTextMessage("agent", "你目前接近目标功率，短时间不需要调整。心率仍在合理范围，建议先完成本组再判断。 ");
        const card = root.createElement("section");
        card.className = "agent-insight-card is-live";
        card.append(
            createCardHeader(root, "实时强度快照", "最近 30 秒 · 模拟数据"),
            createMetricGrid(root, [
                ["功率", "205 W"], ["目标", "210 W"], ["心率", "161 bpm"], ["踏频", "87 rpm"]
            ]),
            createNote(root, "目标完成度 98%。继续保持平顺踩踏；Agent 只提供建议，不会直接修改 ERG 或骑行台。")
        );
        elements.messages.append(card);
        renderLiveWorkspace();
        scrollMessages(elements.messages);
    }

    function addGeneralResponse() {
        updateContext("全局骑行助手");
        addTextMessage("agent", "我可以分析已完成活动，或结合 Rider 的实时数据回答当前强度问题。路线规划请进入“实时骑行设置 → AI 路线”。");
        renderLiveWorkspace();
        scrollMessages(elements.messages);
    }

    function sendMessage(text, kind = inferPromptKind(text)) {
        const normalized = String(text ?? "").trim();
        if (!normalized) return;
        requestSequence += 1;
        const sequence = requestSequence;
        addTextMessage("user", normalized);
        const thinking = addThinkingMessage(sequence);
        elements.input.value = "";
        elements.sendButton.disabled = true;
        schedule(() => {
            thinking.remove();
            if (sequence !== requestSequence) return;
            if (kind === "activity") addActivityResponse();
            else if (kind === "live") addLiveResponse();
            else if (kind === "route") addRouteResponse();
            else addGeneralResponse();
            elements.sendButton.disabled = false;
            if (elements.window.hidden) elements.badge.hidden = false;
        }, delayMs);
    }

    function updateContext(label) {
        contextCleared = false;
        elements.contextBar.hidden = false;
        elements.contextLabel.textContent = label;
    }

    function clearContext() {
        contextCleared = true;
        elements.contextBar.hidden = true;
        addTextMessage("agent", "已清除当前上下文。下一条消息会作为新的任务处理。 ");
    }

    function renderActivityWorkspace() {
        elements.workspaceTitle.textContent = "最近一次骑行分析";
        elements.workspaceContent.replaceChildren(
            createChartMock(root, [52, 55, 59, 62, 61, 67, 73, 76, 82, 79]),
            createMetricGrid(root, [["平均功率", "174 W"], ["平均心率", "154 bpm"], ["有氧效果", "3.2"]]),
            createNote(root, "核心观察：功率基本稳定，心率后程漂移。完整报告将使用 Rider 的活动详情区域展示，浮窗保留结论与追问入口。")
        );
    }

    function renderLiveWorkspace() {
        elements.workspaceTitle.textContent = "实时骑行快照";
        elements.workspaceContent.replaceChildren(
            createLiveGauge(root, 205, 210),
            createMetricGrid(root, [["本组剩余", "05:42"], ["当前坡度", "2.1%"], ["速度", "31.4 km/h"]]),
            createWorkspaceHint(root, "实时数据由 Rider 汇总后按需交给 Agent；250ms 物理循环和 FTMS 控制不会经过模型。")
        );
    }

    listen(elements.launcher, "click", () => setWindowOpen(true));
    listen(elements.closeButton, "click", () => setWindowOpen(false));
    listen(elements.minimizeButton, "click", () => setWindowOpen(false));
    listen(elements.expandButton, "click", () => setExpanded(!elements.window.classList.contains("is-expanded")));
    listen(elements.clearContextButton, "click", clearContext);
    listen(elements.composer, "submit", (event) => {
        event.preventDefault();
        sendMessage(elements.input.value);
    });
    elements.quickPrompts?.querySelectorAll("[data-agent-prompt]").forEach((button) => {
        listen(button, "click", () => sendMessage(MOCK_PROMPTS[button.dataset.agentPrompt], button.dataset.agentPrompt));
    });

    if (seedConversation) {
        addTextMessage("agent", "你好，我可以在骑行过程中回答实时强度问题，也可以分析已完成的活动。路线规划请使用页面中的“AI 路线”栏目。 ");
        renderLiveWorkspace();
    }

    return {
        open: () => setWindowOpen(true),
        close: () => setWindowOpen(false),
        sendMessage,
        destroy() {
            requestSequence += 1;
            listeners.splice(0).forEach((remove) => remove());
        },
        getState: () => ({
            open: !elements.window.hidden,
            expanded: elements.window.classList.contains("is-expanded"),
            contextCleared
        })
    };
}

export function inferPromptKind(text) {
    const normalized = String(text ?? "");
    if (/实时|现在|当前强度|本组/.test(normalized)) return "live";
    if (/路线|骑一圈|途经|起点|终点|爬坡|风景/.test(normalized)) return "route";
    if (/活动|分析|报告|掉速|心率/.test(normalized)) return "activity";
    return "general";
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

function createCardHeader(root, titleText, metaText) {
    const heading = root.createElement("div");
    heading.className = "agent-card-heading";
    const title = root.createElement("strong");
    title.textContent = titleText;
    const meta = root.createElement("span");
    meta.textContent = metaText;
    heading.append(title, meta);
    return heading;
}

function createMetricGrid(root, entries) {
    const grid = root.createElement("div");
    grid.className = "agent-metric-grid";
    entries.forEach(([labelText, valueText]) => {
        const item = root.createElement("div");
        const label = root.createElement("span");
        label.textContent = labelText;
        const value = root.createElement("strong");
        value.textContent = valueText;
        item.append(label, value);
        grid.append(item);
    });
    return grid;
}

function createNote(root, text) {
    const note = root.createElement("p");
    note.className = "agent-card-note";
    note.textContent = text;
    return note;
}

function createWorkspaceHint(root, text) {
    const hint = createNote(root, text);
    hint.classList.add("agent-workspace-hint");
    return hint;
}

function createChartMock(root, values) {
    const shell = root.createElement("div");
    shell.className = "agent-chart-mock";
    const max = Math.max(...values);
    values.forEach((value) => {
        const bar = root.createElement("i");
        bar.style.height = `${Math.round((value / max) * 100)}%`;
        shell.append(bar);
    });
    return shell;
}

function createLiveGauge(root, actual, target) {
    const shell = root.createElement("div");
    shell.className = "agent-live-gauge";
    const value = root.createElement("strong");
    value.textContent = `${actual} W`;
    const label = root.createElement("span");
    label.textContent = `目标 ${target} W · 完成度 ${Math.round((actual / target) * 100)}%`;
    const track = root.createElement("div");
    const fill = root.createElement("i");
    fill.style.width = `${Math.min(100, Math.round((actual / target) * 100))}%`;
    track.append(fill);
    shell.append(value, label, track);
    return shell;
}

function scrollMessages(messages) {
    messages.scrollTop = messages.scrollHeight;
}
