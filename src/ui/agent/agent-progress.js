// Request-scoped display of server evidence; never estimates business completion.
export function createAgentProgress({ root, container, clock = globalThis }) {
    let timer = null;
    let active = false;
    let started = 0;
    const steps = new Map();
    const title = root.createElement("strong");
    title.setAttribute("role", "status");
    const elapsed = root.createElement("span");
    const heading = root.createElement("div");
    heading.className = "agent-progress-heading";
    heading.append(title, elapsed);
    const details = root.createElement("details");
    const summary = root.createElement("summary");
    summary.textContent = "处理步骤";
    const list = root.createElement("ul");
    details.append(summary, list);
    container?.append(heading, details);
    const now = () => clock.now?.() ?? Date.now();
    const tick = () => { elapsed.textContent = `${Math.max(0, Math.floor((now() - started) / 1000))} 秒`; };
    const stop = () => { active = false; if (timer !== null) clock.clearInterval?.(timer); timer = null; };
    const labels = { running: "处理中", completed: "已完成", partial: "部分完成", failed: "未完成",
        queued: "已排队", submitted: "已提交", pending: "等待结果", blocked: "未执行", unknown: "结果未确认" };
    function render() {
        list.replaceChildren(...[...steps.values()].map(({ label, status }) => {
            const item = root.createElement("li");
            item.dataset.status = status;
            item.textContent = `${label} · ${labels[status] || "已返回结果"}`;
            return item;
        }));
        details.hidden = steps.size === 0;
    }
    return {
        start() {
            stop(); active = true; started = now(); steps.clear(); render(); details.open = true;
            if (container) { container.hidden = false; container.dataset.state = "running"; }
            title.textContent = "请求已发送，等待处理"; tick(); timer = clock.setInterval?.(tick, 1000) ?? null;
        },
        update(event) {
            if (!active) return;
            if (event.stage === "reasoning") { title.textContent = "分析需求与下一步"; return; }
            if (!event.stage || !event.label) return;
            steps.set(`${event.index ?? 0}:${event.stage}`, { label: event.label, status: event.status });
            title.textContent = event.status === "running" ? `正在${event.label}` : "等待下一步处理";
            render();
        },
        finish(result) {
            tick(); stop();
            const partial = result?.executions?.some((item) => ["partial", "failed", "blocked"].includes(item.status));
            const pending = result?.executions?.some((item) => ["queued", "submitted", "pending", "waiting", "running"].includes(item.status));
            const okay = result?.status === "completed" && !result?.error && !partial && !pending;
            title.textContent = result?.status === "clarification_required" ? "等待补充信息"
                : partial ? "部分步骤未完成，请查看结果" : pending ? "请求已提交，等待任务结果" : okay ? "本轮处理完成" : "本轮未完成，请查看结果";
            if (container) container.dataset.state = okay ? "completed" : "incomplete";
            for (const step of steps.values()) if (step.status === "running") step.status = "unknown";
            render(); details.open = !okay;
        },
        clear() { stop(); steps.clear(); if (container) container.hidden = true; },
        destroy: stop,
    };
}
