import { readAgentStream } from "../../shared/agent-stream.js";
const DEFAULT_SESSION_STORAGE_KEY = "rider-tracker:agent-session-id";

export function createAgentApiClient({
    baseUrl = "",
    fetchImpl = fetch,
    storage = getLocalStorage(),
    sessionStorageKey = DEFAULT_SESSION_STORAGE_KEY
} = {}) {
    let sessionId = loadOrCreateSessionId(storage, sessionStorageKey);

    async function jobRequest(pathname, body) {
        const response = await fetchImpl(`${baseUrl}${pathname}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error("暂时无法连接任务服务，请稍后重试。");
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    async function post(pathname, body, onProgress) {
        const response = await fetchImpl(`${baseUrl}${pathname}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(onProgress ? { Accept: "application/x-ndjson" } : {}) },
            body: JSON.stringify(body)
        });
        if (response.ok && response.headers?.get?.("content-type")?.includes("application/x-ndjson")) {
            return readAgentStream(response, onProgress);
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error || `Agent 请求失败（HTTP ${response.status}）`);
        }
        return payload.result;
    }

    async function sessionRequest(path = "", method = "GET", body) {
        const response = await fetchImpl(`${baseUrl}/api/agent/sessions${path}`, {
            method, headers: { "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
            const error = new Error(payload.error || "会话加载失败，请重试");
            error.status = response.status;
            throw error;
        }
        return payload.result;
    }
    function selectSession(id) {
        sessionId = id;
        try { storage?.setItem(sessionStorageKey, id); } catch { /* memory selection remains usable */ }
    }

    return {
        selectSession,
        listSessions: (kind = "chat") => sessionRequest(`?kind=${encodeURIComponent(kind)}`),
        getSession: (id = sessionId) => sessionRequest(`/${encodeURIComponent(id)}`),
        async createSession(kind = "chat", id = createSessionId()) {
            const detail = await sessionRequest("", "POST", { session_id: id, kind });
            return detail;
        },
        createDraftSession(kind = "chat") {
            return { session_id: createSessionId(), kind, title: kind === "route_plan" ? "新规划" : "新对话", turns: [], local_draft: true };
        },
        deleteSession: (id = sessionId) => sessionRequest(`/${encodeURIComponent(id)}`, "DELETE"),
        get sessionId() { return sessionId; },
        getReportJob: (id) => jobRequest(`/api/jobs/${encodeURIComponent(id)}/report-rebuild`),
        cancelReportJob: (id) => jobRequest(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
        retryReportJob: (activityKeys, requestId) => jobRequest("/api/jobs", {
            job_type: "activity_report_rebuild.v1", request_id: requestId,
            payload: { scope: "all", activity_keys: activityKeys }
        }),
        chat(message, { onProgress = null, routeOptions = null, requestMode = "chat", routeAction = null, routeReference = null, sessionId: routeSessionId = sessionId } = {}) {
            return post("/api/agent/chat", {
                session_id: routeSessionId,
                request_id: `request-${crypto.randomUUID()}`,
                message,
                request_mode: requestMode,
                ...(routeAction ? { route_action: routeAction } : {}),
                ...(routeReference ? { route_reference: routeReference } : {}),
                ...(routeOptions ? { route_options: routeOptions } : {})
            }, onProgress);
        },
        selectRouteCandidate(planId, candidateId, expectedRevision) {
            return post("/api/agent/route-plans/select", {
                session_id: sessionId,
                request_id: `route-${crypto.randomUUID()}`,
                plan_id: planId,
                candidate_id: candidateId,
                expected_revision: expectedRevision
            });
        },
        routePlanCommand(operation, input = {}) {
            return post("/api/agent/route-plans/command", {
                session_id: sessionId,
                request_id: `route-${crypto.randomUUID()}`,
                operation,
                ...input
            });
        },
        resetSession() {
            sessionId = createSessionId();
            try {
                storage?.setItem(sessionStorageKey, sessionId);
            } catch {
                // The new in-memory session still clears context for this page.
            }
            return sessionId;
        }
    };
}

function loadOrCreateSessionId(storage, storageKey) {
    try {
        const stored = storage?.getItem(storageKey);
        if (/^[A-Za-z0-9_-]{1,128}$/.test(stored || "")) return stored;
        const created = createSessionId();
        storage?.setItem(storageKey, created);
        return created;
    } catch {
        return createSessionId();
    }
}

function createSessionId() {
    return `rider-${crypto.randomUUID()}`;
}

function getLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
