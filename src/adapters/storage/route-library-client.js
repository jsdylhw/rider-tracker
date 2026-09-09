function resolveServerUrl(serverUrl) {
    return serverUrl || globalThis.location?.origin || "";
}

export async function saveRoute(input, options = {}) {
    return routeRequest("/api/routes", { method: "POST", json: input, ...options });
}

export async function listSavedRoutes({ source = "", serverUrl } = {}) {
    const query = source ? `?source=${encodeURIComponent(source)}` : "";
    const body = await requestJson(`/api/routes${query}`, { serverUrl });
    return Array.isArray(body.routes) ? body.routes : [];
}

export async function loadSavedRoute(routeId, options = {}) {
    return routeRequest(`/api/routes/${encodeURIComponent(requireRouteId(routeId))}`, options);
}

export async function renameSavedRoute(routeId, name, options = {}) {
    return routeRequest(`/api/routes/${encodeURIComponent(requireRouteId(routeId))}`, {
        method: "PATCH", json: { name }, ...options
    });
}

export async function deleteSavedRoute(routeId, options = {}) {
    return routeRequest(`/api/routes/${encodeURIComponent(requireRouteId(routeId))}`, {
        method: "DELETE", ...options
    });
}

export async function saveRouteProgress(routeId, progress, options = {}) {
    return routeRequest(`/api/routes/${encodeURIComponent(requireRouteId(routeId))}/progress`, {
        method: "PUT", json: progress, ...options
    });
}

export async function clearRouteProgress(routeId, options = {}) {
    return routeRequest(`/api/routes/${encodeURIComponent(requireRouteId(routeId))}/progress`, {
        method: "DELETE", ...options
    });
}

async function routeRequest(pathname, options = {}) {
    const body = await requestJson(pathname, options);
    return body.route ?? null;
}

function requireRouteId(value) {
    const routeId = String(value ?? "").trim();
    if (!routeId) throw new Error("路线 ID 无效。");
    return routeId;
}

async function requestJson(pathname, { method = "GET", json, serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl) throw new Error("本地路线库服务不可用。");
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: json === undefined ? undefined : { "Content-Type": "application/json" },
        body: json === undefined ? undefined : JSON.stringify(json)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || "路线库请求失败。");
    }
    return body;
}
