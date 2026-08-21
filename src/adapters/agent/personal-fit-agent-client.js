const SESSION_STORAGE_KEY = "rider-tracker:agent-session-id";

export function createAgentApiClient({
    baseUrl = "",
    fetchImpl = fetch,
    storage = getLocalStorage()
} = {}) {
    const sessionId = loadOrCreateSessionId(storage);

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
        sessionId,
        chat(message) {
            return post("/api/agent/chat", {
                session_id: sessionId,
                request_id: `request-${crypto.randomUUID()}`,
                message
            });
        },
        selectRouteCandidate(planId, candidateId) {
            return post("/api/agent/route-plans/select", {
                session_id: sessionId,
                plan_id: planId,
                candidate_id: candidateId
            });
        },
        routePlanCommand(operation, input = {}) {
            return post("/api/agent/route-plans/command", {
                session_id: sessionId,
                operation,
                ...input
            });
        }
    };
}

function loadOrCreateSessionId(storage) {
    try {
        const stored = storage?.getItem(SESSION_STORAGE_KEY);
        if (/^[A-Za-z0-9_-]{1,128}$/.test(stored || "")) return stored;
        const created = `rider-${crypto.randomUUID()}`;
        storage?.setItem(SESSION_STORAGE_KEY, created);
        return created;
    } catch {
        return `rider-${crypto.randomUUID()}`;
    }
}

function getLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
