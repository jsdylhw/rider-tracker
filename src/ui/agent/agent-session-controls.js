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
        remove.disabled ||= !(select.value || currentDetail?.session_id || client.sessionId);
    }
    async function refreshList() {
        const result = await client.listSessions(kind);
        if (destroyed) return;
        const items = [...result.sessions];
        if (currentDetail && items.some((item) => item.session_id === currentDetail.session_id)) currentDetail.local_draft = false;
        if (currentDetail && !items.some((item) => item.session_id === currentDetail.session_id)) items.unshift({ ...currentDetail, title: currentDetail.kind && currentDetail.kind !== kind ? `${currentDetail.title}（来自主会话）` : currentDetail.title });
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
    const emptySession = () => client.createDraftSession?.(kind) ?? client.createSession(kind);
    async function restore() {
        try { return await client.getSession(); }
        catch (error) {
            if (error.status !== 404) throw error;
            return emptySession();
        }
    }
    select.addEventListener("change", () => void run(() => client.getSession(select.value)));
    create.addEventListener("click", () => void run(() => emptySession()));
    retry.addEventListener("click", () => void run(restore));
    const dialog = doc.createElement("dialog");
    dialog.className = "agent-session-dialog";
    dialog.setAttribute("aria-label", "删除会话确认");
    const heading = doc.createElement("h3");
    heading.textContent = "删除这个会话？";
    const description = doc.createElement("p");
    description.textContent = "聊天记录将被删除。已保存的路线和活动不受影响。";
    const actions = doc.createElement("div");
    const cancel = doc.createElement("button");
    const confirm = doc.createElement("button");
    cancel.type = confirm.type = "button";
    cancel.textContent = "取消";
    confirm.textContent = "删除会话";
    confirm.className = "is-danger";
    actions.append(cancel, confirm);
    dialog.append(heading, description, actions);
    container.append(dialog);
    let deleteTarget = null;
    function closeDialog() {
        dialog.close?.();
        dialog.removeAttribute?.("open");
        deleteTarget = null;
        remove.focus?.();
    }
    cancel.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", () => { deleteTarget = null; });
    remove.addEventListener("click", () => {
        if (loading || blocked || isLocked() || destroyed) return;
        deleteTarget = select.value || currentDetail?.session_id || client.sessionId;
        if (!deleteTarget) return;
        if (dialog.showModal) dialog.showModal();
        else dialog.setAttribute("open", "");
        cancel.focus?.();
    });
    confirm.addEventListener("click", () => {
        const id = deleteTarget;
        closeDialog();
        if (!id) return;
        void run(async () => {
            try { await client.deleteSession(id); }
            catch (error) { if (error.status !== 404) throw error; }
            currentDetail = null;
            const result = await client.listSessions(kind);
            const next = result.sessions.find((item) => item.session_id !== id);
            return next ? client.getSession(next.session_id) : emptySession();
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
        newSession: () => run(() => emptySession()),
        refreshList: () => refreshList().catch(() => {}),
        setBlocked(value) { blocked = value; update(); },
        destroy() { destroyed = true; dialog.close?.(); container.replaceChildren(); }
    };
}
