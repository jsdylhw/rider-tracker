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

    async function post(pathname, body) {
        const response = await fetchImpl(`${baseUrl}${pathname}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error || `Agent 请求失败（HTTP ${response.status}）`);
        }
        return payload.result;
    }

    return {
        get sessionId() { return sessionId; },
        getReportJob: (id) => jobRequest(`/api/jobs/${encodeURIComponent(id)}/report-rebuild`),
        cancelReportJob: (id) => jobRequest(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
        retryReportJob: (activityKeys, requestId) => jobRequest("/api/jobs", {
            job_type: "activity_report_rebuild.v1", request_id: requestId,
            payload: { scope: "all", activity_keys: activityKeys }
        }),
        chat(message, { routeOptions = null } = {}) {
            return post("/api/agent/chat", {
                session_id: sessionId,
                request_id: `request-${crypto.randomUUID()}`,
                message,
                ...(routeOptions ? { route_options: routeOptions } : {})
            });
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
