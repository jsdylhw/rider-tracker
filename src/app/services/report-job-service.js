const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);

// Persist identifiers only; displayed progress always comes from the task API.
export function createReportJobService({ client, onChange = () => {}, storage = localStorageOrNull(),
    storageKey = "rider-tracker:home-report-jobs", schedule = setTimeout, unschedule = clearTimeout,
    requestId = () => `report-${crypto.randomUUID()}` } = {}) {
    const jobs = new Map();
    let epoch = 0;
    let destroyed = false;

    function persist() {
        try {
            storage?.setItem(storageKey, JSON.stringify([...jobs.values()].map(({ id, retry }) => ({ id, retry }))));
        } catch { /* Storage restrictions must not prevent querying or cancelling. */ }
    }
    function current(item, generation) { return !destroyed && generation === epoch && jobs.get(item.id) === item; }
    function changed() { if (!destroyed) onChange(); }
    function later(item) {
        if (!destroyed && !item.timer && !item.missing && (!item.view || !TERMINAL.has(item.view.status) || item.error)) {
            item.timer = schedule(() => { item.timer = null; void refresh(item); }, item.error ? 5000 : 2000);
        }
    }
    async function refresh(item) {
        if (item.loading || destroyed) return;
        const generation = epoch;
        const before = JSON.stringify([item.view, item.error, item.missing]);
        item.loading = true;
        try {
            const view = await client.getReportJob(item.id);
            if (!current(item, generation)) return;
            if (view?.job_id !== item.id || view?.kind !== "activity_report_job") throw new Error("Invalid task response");
            item.view = view;
            item.error = "";
            item.missing = false;
            if (TERMINAL.has(view.status) && item.timer) { unschedule(item.timer); item.timer = null; }
        } catch (error) {
            if (!current(item, generation)) return;
            item.missing = error.status === 404;
            item.error = item.missing ? "找不到这项任务，记录可能已被清理。" : "暂时无法更新进度，正在重新连接。";
        } finally {
            item.loading = false;
            if (current(item, generation)) {
                if (before !== JSON.stringify([item.view, item.error, item.missing])) changed();
                later(item);
            }
        }
    }
    function track(id, retry = null) {
        if (!validId(id) || jobs.has(id) || destroyed || !client?.getReportJob) return;
        const item = { id, retry, view: null, error: "", timer: null, loading: false, busy: false, missing: false };
        jobs.set(id, item);
        persist();
        changed();
        void refresh(item);
    }
    async function action(id, actionName) {
        const item = jobs.get(id);
        if (!item || item.busy || destroyed) return;
        if (actionName === "dismiss") {
            if (!item.missing && !TERMINAL.has(item.view?.status)) return;
            if (item.timer) unschedule(item.timer);
            jobs.delete(id); persist(); changed(); return;
        }
        const generation = epoch;
        item.busy = true;
        item.actionError = "";
        changed();
        try {
            if (actionName === "cancel") {
                await client.cancelReportJob(id);
                if (!current(item, generation)) return;
                // Generic cancel response lacks the per-activity details.
                if (item.view) item.view = { ...item.view, cancel_requested: true };
            } else if (actionName === "retry") {
                if (!TERMINAL.has(item.view?.status)) return;
                const keys = (item.view?.activities || []).filter((a) => a.status === "failed"
                    || (["failed", "partial"].includes(item.view.status) && a.status === "pending")).map((a) => a.activity_key);
                if (!keys.length || item.retry?.jobId) return;
                if (!item.retry) { item.retry = { requestId: requestId(), keys }; persist(); }
                // Keep this request ID after an uncertain response, including page reload.
                const result = await client.retryReportJob(item.retry.keys, item.retry.requestId);
                if (!current(item, generation)) return;
                if (!validId(result?.job_id)) throw new Error("Invalid task response");
                item.retry.jobId = result.job_id;
                persist();
                track(result.job_id);
            }
            if (current(item, generation)) await refresh(item);
        } catch {
            if (current(item, generation)) item.actionError = "操作未确认，请重试；重复点击不会重复创建同一次重试任务。";
        } finally {
            item.busy = false;
            if (current(item, generation)) changed();
        }
    }
    function clear() {
        epoch += 1;
        for (const item of jobs.values()) if (item.timer) unschedule(item.timer);
        jobs.clear(); persist(); changed();
    }
    function restore() {
        try {
            const saved = JSON.parse(storage?.getItem(storageKey) || "[]");
            if (Array.isArray(saved)) for (const entry of saved) {
                const retry = entry?.retry;
                const safeRetry = retry && typeof retry.requestId === "string" && Array.isArray(retry.keys)
                    && retry.keys.length <= 1000 && retry.keys.every((key) => typeof key === "string") ? retry : null;
                track(entry?.id, safeRetry);
                if (validId(safeRetry?.jobId)) track(safeRetry.jobId);
            }
        } catch { /* Ignore unavailable or damaged local storage. */ }
    }
    return {
        track, action, clear, restore,
        blocks: () => [...jobs.values()].map((item) => ({ type: "report_job", title: "报告重建任务",
            data: { ...item.view, job_id: item.id, connectionError: item.error, actionError: item.actionError,
                busy: item.busy, missing: item.missing, retried: Boolean(item.retry?.jobId) } })),
        destroy() {
            destroyed = true; epoch += 1;
            for (const item of jobs.values()) if (item.timer) unschedule(item.timer);
        }
    };
}

function localStorageOrNull() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
}
