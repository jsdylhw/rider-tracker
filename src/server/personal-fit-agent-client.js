import { createAgentUnavailableError } from "./agent-unavailable.js";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_ROUTE_LIBRARY_TIMEOUT_MS = 2_000;
export const DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS = 2_000;

export function createPersonalFitAgentClient({
    baseUrl = "http://127.0.0.1:8000",
    apiToken = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    routeLibraryTimeoutMs = DEFAULT_ROUTE_LIBRARY_TIMEOUT_MS,
    fetchImpl = fetch
} = {}) {
    const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");

    async function get(pathname, requestTimeoutMs = timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
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
                throw createAgentUnavailableError(
                    `Training Agent 在 ${Math.round(requestTimeoutMs / 1000)} 秒内未响应。`,
                    { cause: error }
                );
            }
            if (!error?.statusCode) throw createAgentUnavailableError("无法连接本地 Training Agent。", { cause: error });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function post(pathname, body, requestTimeoutMs = timeoutMs) {
        return sendJson("POST", pathname, body, requestTimeoutMs);
    }

    async function put(pathname, body, requestTimeoutMs = timeoutMs) {
        return sendJson("PUT", pathname, body, requestTimeoutMs);
    }

    async function patch(pathname, body, requestTimeoutMs = timeoutMs) {
        return sendJson("PATCH", pathname, body, requestTimeoutMs);
    }

    async function remove(pathname, requestTimeoutMs = timeoutMs) {
        return sendJson("DELETE", pathname, undefined, requestTimeoutMs);
    }

    async function sendJson(method, pathname, body, requestTimeoutMs = timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
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
                throw createAgentUnavailableError(
                    `Training Agent 在 ${Math.round(requestTimeoutMs / 1000)} 秒内未响应。`,
                    { cause: error }
                );
            }
            if (!error?.statusCode) throw createAgentUnavailableError("无法连接本地 Training Agent。", { cause: error });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function getBinary(pathname, requestTimeoutMs = timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
                headers: apiToken ? { "X-API-Token": apiToken } : {},
                signal: controller.signal
            });
            if (!response.ok) {
                throw responseError(response, await readJson(response));
            }
            return {
                contentType: response.headers?.get?.("content-type") || "image/jpeg",
                body: Buffer.from(await response.arrayBuffer())
            };
        } catch (error) {
            if (error?.name === "AbortError") {
                throw createAgentUnavailableError(
                    `Training Agent 在 ${Math.round(requestTimeoutMs / 1000)} 秒内未响应。`,
                    { cause: error }
                );
            }
            if (!error?.statusCode) throw createAgentUnavailableError("无法连接本地 Training Agent。", { cause: error });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    return {
        health: () => get("/health", healthTimeoutMs),
        chat: (request) => post("/api/chat", request),
        ingestFit: (request) => post("/api/activities/ingest-fit", request),
        archiveRiderSession: (request) => post(
            "/api/activities/rider-session",
            request,
            DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS
        ),
        activityDetail: (activityId, { maxPoints = 700, requestTimeoutMs = timeoutMs } = {}) => get(
            `/api/activities/${encodeURIComponent(activityId)}/detail?max_points=${encodeURIComponent(maxPoints)}`,
            requestTimeoutMs
        ),
        listActivities: ({ limit = 50, offset = 0, sportType = "", source = "" } = {}) => {
            const query = new URLSearchParams({
                limit: String(limit),
                offset: String(offset)
            });
            if (sportType) query.set("sport_type", sportType);
            if (source) query.set("source", source);
            return get(`/api/activities?${query}`, DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS);
        },
        getActivity: (activityId, { requestTimeoutMs = DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS } = {}) => get(
            `/api/activities/${encodeURIComponent(activityId)}`,
            requestTimeoutMs
        ),
        renameActivity: (activityId, name) => patch(
            `/api/activities/${encodeURIComponent(activityId)}`,
            { name },
            DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS
        ),
        deleteActivity: (activityId) => remove(
            `/api/activities/${encodeURIComponent(activityId)}`,
            DEFAULT_ACTIVITY_LIBRARY_TIMEOUT_MS
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
        listSavedRoutes: ({ source = "" } = {}) => get(
            `/api/routes${source ? `?source=${encodeURIComponent(source)}` : ""}`,
            routeLibraryTimeoutMs
        ),
        saveRoute: (request) => post("/api/routes", request, routeLibraryTimeoutMs),
        getSavedRoute: (routeId) => get(
            `/api/routes/${encodeURIComponent(routeId)}`,
            routeLibraryTimeoutMs
        ),
        renameSavedRoute: (routeId, name) => patch(
            `/api/routes/${encodeURIComponent(routeId)}`,
            { name },
            routeLibraryTimeoutMs
        ),
        deleteSavedRoute: (routeId) => remove(
            `/api/routes/${encodeURIComponent(routeId)}`,
            routeLibraryTimeoutMs
        ),
        saveRouteProgress: (routeId, request) => put(
            `/api/routes/${encodeURIComponent(routeId)}/progress`,
            request,
            routeLibraryTimeoutMs
        ),
        clearRouteProgress: (routeId) => remove(
            `/api/routes/${encodeURIComponent(routeId)}/progress`,
            routeLibraryTimeoutMs
        ),
        selectRouteCandidate: (request) => post("/api/route-plans/select", request),
        routePlanCommand: (request) => post("/api/route-plans/command", request),
        prepareRouteNarration: (request) => post("/api/route-narrations/prepare", request),
        routeNarrationPhoto: ({ name, maxWidth = 720 }) => getBinary(
            `/api/route-narrations/photo?name=${encodeURIComponent(name)}&max_width=${encodeURIComponent(maxWidth)}`,
            30_000
        )
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
    error.code = detail?.code || payload?.code || null;
    error.retryable = detail?.retryable ?? payload?.retryable;
    return error;
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}
