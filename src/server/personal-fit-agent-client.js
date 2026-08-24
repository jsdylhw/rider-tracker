const DEFAULT_TIMEOUT_MS = 240_000;

export function createPersonalFitAgentClient({
    baseUrl = "http://127.0.0.1:8000",
    apiToken = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch
} = {}) {
    const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");

    async function get(pathname) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
                headers: apiToken ? { "X-API-Token": apiToken } : {},
                signal: controller.signal
            });
            const payload = await readJson(response);
            if (!response.ok) {
                throw new Error(payload?.detail || payload?.error || `Personal FIT Agent 请求失败（HTTP ${response.status}）`);
            }
            return payload;
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`Personal FIT Agent 在 ${Math.round(timeoutMs / 1000)} 秒内未响应。`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function post(pathname, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(apiToken ? { "X-API-Token": apiToken } : {})
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const payload = await readJson(response);
            if (!response.ok) {
                throw new Error(payload?.detail || payload?.error || `Personal FIT Agent 请求失败（HTTP ${response.status}）`);
            }
            return payload;
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`Personal FIT Agent 在 ${Math.round(timeoutMs / 1000)} 秒内未响应。`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    return {
        health: () => get("/health"),
        chat: (request) => post("/api/chat", request),
        ingestFit: (request) => post("/api/activities/ingest-fit", request),
        activityDetail: (activityId, { maxPoints = 700 } = {}) => get(
            `/api/activities/${encodeURIComponent(activityId)}/detail?max_points=${encodeURIComponent(maxPoints)}`
        ),
        selectRouteCandidate: (request) => post("/api/route-plans/select", request),
        routePlanCommand: (request) => post("/api/route-plans/command", request)
    };
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}
