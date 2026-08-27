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
                throw responseError(response, payload);
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
        return sendJson("POST", pathname, body);
    }

    async function put(pathname, body) {
        return sendJson("PUT", pathname, body);
    }

    async function sendJson(method, pathname, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(apiToken ? { "X-API-Token": apiToken } : {})
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const payload = await readJson(response);
            if (!response.ok) {
                throw responseError(response, payload);
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
        athleteProfile: () => get("/api/athlete-profile"),
        updateAthleteProfile: (profile) => put("/api/athlete-profile", { profile }),
        stravaConfig: () => get("/api/strava/config"),
        stravaConnection: () => get("/api/strava/connection"),
        stravaAuthorizeUrl: (request) => post("/api/strava/auth-url", request),
        stravaExchangeCode: (request) => post("/api/strava/exchange-code", request),
        stravaUploadActivity: (request) => post("/api/strava/upload-activity", request),
        stravaUploadStatus: (uploadId) => get(
            `/api/strava/upload-status/${encodeURIComponent(uploadId)}`
        ),
        selectRouteCandidate: (request) => post("/api/route-plans/select", request),
        routePlanCommand: (request) => post("/api/route-plans/command", request),
        prepareRouteNarration: (request) => post("/api/route-narrations/prepare", request)
    };
}

function responseError(response, payload) {
    const detail = payload?.detail;
    const message = typeof detail === "string"
        ? detail
        : detail?.message || payload?.error || `Personal FIT Agent 请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.detail = detail;
    return error;
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}
