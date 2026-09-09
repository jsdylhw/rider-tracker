function resolveServerUrl(serverUrl) {
    return serverUrl || globalThis.location?.origin || "";
}

export async function listStravaRoutes({ serverUrl } = {}) {
    const body = await request(`/api/strava/routes`, { serverUrl });
    return normalizeCatalog(body);
}

export async function refreshStravaRoutes({ serverUrl } = {}) {
    const body = await request(`/api/strava/routes/refresh`, { serverUrl, method: "POST" });
    return normalizeCatalog(body);
}

export async function loadStravaRouteGpx(routeId, { serverUrl } = {}) {
    const normalizedId = String(routeId ?? "").trim();
    if (!/^\d+$/.test(normalizedId)) throw new Error("Strava 路线 ID 无效。");
    return request(`/api/strava/routes/${encodeURIComponent(normalizedId)}/gpx`, {
        serverUrl,
        responseType: "text"
    });
}

async function request(pathname, { serverUrl, responseType = "json", method = "GET" } = {}) {
    const baseUrl = resolveServerUrl(serverUrl);
    if (!baseUrl) throw new Error("本地 Strava 路线服务不可用。");
    const response = await fetch(`${baseUrl}${pathname}`, { method });
    if (responseType === "text" && response.ok) return response.text();
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `Strava 路线请求失败（HTTP ${response.status}）。`);
    }
    return body;
}

function normalizeCatalog(body) {
    return {
        routes: Array.isArray(body.routes) ? body.routes : [],
        cachedAt: body.cachedAt ?? null,
        hasCache: body.hasCache === true
    };
}
