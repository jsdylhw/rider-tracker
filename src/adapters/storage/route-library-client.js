function resolveServerUrl(serverUrl) {
    return serverUrl || globalThis.location?.origin || "";
}

export async function saveGpxRoute({ route, originalGpxText }, { serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl) throw new Error("本地路线库服务不可用。");
    const response = await fetch(`${baseUrl}/api/routes/gpx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route, originalGpxText })
    });
    return readRouteResponse(response);
}

export async function listSavedGpxRoutes({ serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl) return [];
    const response = await fetch(`${baseUrl}/api/routes?source=gpx`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(body?.error || "读取路线库失败。");
    return Array.isArray(body.routes) ? body.routes : [];
}

export async function loadSavedRoute(routeId, { serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl || !routeId) throw new Error("本地路线库服务不可用。");
    const response = await fetch(`${baseUrl}/api/routes/${encodeURIComponent(routeId)}`);
    return readRouteResponse(response);
}

export async function deleteSavedRoute(routeId, { serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl || !routeId) throw new Error("本地路线库服务不可用。");
    const response = await fetch(`${baseUrl}/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
    return readRouteResponse(response);
}

export async function updateSavedRouteResumeDistance(routeId, resumeDistanceMeters, { serverUrl } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl || !routeId) throw new Error("本地路线库服务不可用。");
    const response = await fetch(`${baseUrl}/api/routes/${encodeURIComponent(routeId)}/resume-distance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeDistanceMeters })
    });
    return readRouteResponse(response);
}

async function readRouteResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(body?.error || "路线库请求失败。");
    return body.route;
}
