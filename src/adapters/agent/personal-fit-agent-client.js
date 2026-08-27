const DEFAULT_SESSION_STORAGE_KEY = "rider-tracker:agent-session-id";

export function createAgentApiClient({
    baseUrl = "",
    fetchImpl = fetch,
    storage = getLocalStorage(),
    sessionStorageKey = DEFAULT_SESSION_STORAGE_KEY
} = {}) {
    let sessionId = loadOrCreateSessionId(storage, sessionStorageKey);

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
        chat(message) {
            return post("/api/agent/chat", {
                session_id: sessionId,
                request_id: `request-${crypto.randomUUID()}`,
                message
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
