/** Session UI owns selection only; Python owns transcript and model context. */
export function createAgentSessionControls({ container, client, kind, onLoad, onBusy = () => {}, isLocked = () => false }) {
    if (!container || !client?.getSession) return null;
    const doc = container.ownerDocument;
    const select = doc.createElement("select");
    select.setAttribute("aria-label", "选择会话");
    const create = doc.createElement("button");
    const remove = doc.createElement("button");
    const retry = doc.createElement("button");
    const status = doc.createElement("span");
    select.className = "agent-session-select";
    create.className = "agent-session-new";
    remove.className = "agent-session-icon is-danger";
    retry.className = "agent-session-icon";
    status.className = "agent-session-status";
    create.textContent = "＋ 新对话";
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>';
    retry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>';
    for (const [button, label] of [[create, "新建独立会话"], [remove, "删除当前会话"], [retry, "刷新会话记录"]]) {
        button.title = label;
        button.setAttribute("aria-label", label);
    }
    status.hidden = true;
    for (const button of [create, remove, retry]) button.type = "button";
    status.setAttribute("role", "status");
    container.append(select, create, remove, retry, status);
    let loading = false;
    let blocked = false;
    let destroyed = false;
    let ready = false;
    let currentDetail = null;
    let sequence = 0;
    function update() {
        for (const item of [select, create, remove, retry]) item.disabled = loading || blocked || isLocked();
        remove.disabled ||= !ready;
    }
    async function refreshList() {
        const result = await client.listSessions(kind);
        if (destroyed) return;
        const items = [...result.sessions];
        if (currentDetail && !items.some((item) => item.session_id === currentDetail.session_id)) items.unshift({ ...currentDetail, title: `${currentDetail.title}（来自主会话）` });
        select.replaceChildren(...items.map((session) => {
            const option = doc.createElement("option");
            option.value = session.session_id;
            const updated = session.updated_at ? new Date(session.updated_at * 1000).toLocaleString("zh-CN", {
                month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
            }) : "";
            option.textContent = updated ? `${session.title} · ${updated}` : session.title;
            return option;
        }));
        select.value = client.sessionId;
    }
    async function run(action) {
        if (loading || blocked || isLocked() || destroyed) return;
        const ticket = ++sequence;
        loading = true; onBusy(true); update(); status.hidden = false; status.textContent = "正在加载会话…";
        container.classList.remove("has-session-error");
        try {
            const detail = await action();
            if (destroyed || ticket !== sequence) return;
            await onLoad(detail);
            if (destroyed || ticket !== sequence) return;
            currentDetail = detail;
            client.selectSession(detail.session_id);
            await refreshList();
            ready = true;
            status.hidden = true;
            status.textContent = detail.turns.length ? "会话已恢复" : "新会话";
        } catch (error) {
            if (destroyed || ticket !== sequence) return;
            // Keep sending disabled until transcript and server context agree.
            ready = false;
            status.hidden = false;
            container.classList.add("has-session-error");
            status.textContent = `${error.message}；请刷新或新建会话。`;
        } finally {
            if (ticket !== sequence) return;
            loading = false;
            if (!destroyed) { onBusy(!ready); update(); }
        }
    }
    async function restore() {
        try { return await client.getSession(); }
        catch (error) {
            if (error.status !== 404) throw error;
            return client.createSession(kind);
        }
    }
    select.addEventListener("change", () => void run(() => client.getSession(select.value)));
    create.addEventListener("click", () => void run(() => client.createSession(kind)));
    retry.addEventListener("click", () => void run(restore));
    remove.addEventListener("click", () => {
        if (doc.defaultView?.confirm && !doc.defaultView.confirm("删除当前会话及聊天记录？已保存的路线和活动不受影响。")) return;
        void run(async () => {
            await client.deleteSession();
            return client.createSession(kind);
        });
    });
    return {
        adopt(detail) {
            sequence += 1; loading = false; ready = true; currentDetail = detail;
            client.selectSession(detail.session_id); onBusy(false); update();
            status.hidden = true;
            container.classList.remove("has-session-error");
            status.textContent = "已打开对应路线会话";
            void refreshList().catch(() => {});
        },
        restore: () => run(restore),
        newSession: () => run(() => client.createSession(kind)),
        refreshList: () => refreshList().catch(() => {}),
        setBlocked(value) { blocked = value; update(); },
        destroy() { destroyed = true; container.replaceChildren(); }
    };
}
