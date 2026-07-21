import { buildOverpassRoadQuery } from "../../domain/route/osm-road-network.js";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
];

const OVERPASS_REQUEST_TIMEOUT_MS = 10000;
const OVERPASS_TOTAL_TIMEOUT_MS = 25000;

export async function fetchOverpassRoadNetwork(bounds, {
    fetchImpl = globalThis.fetch,
    endpoints = OVERPASS_ENDPOINTS,
    requestTimeoutMs = OVERPASS_REQUEST_TIMEOUT_MS,
    totalTimeoutMs = OVERPASS_TOTAL_TIMEOUT_MS
} = {}) {
    if (!fetchImpl) {
        throw new Error("当前环境不支持 fetch，无法请求 OSM 路网");
    }

    const query = buildOverpassRoadQuery(bounds);
    const errors = [];
    const startedAt = Date.now();

    for (const method of ["POST", "GET"]) {
        const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
            throw new Error(`Overpass 总请求超时（${totalTimeoutMs}ms）：${errors.join(" | ")}`);
        }

        try {
            return await Promise.any(endpoints.map((endpoint) => (
                fetchOverpassEndpoint(endpoint, query, {
                    fetchImpl,
                    method,
                    requestTimeoutMs: Math.min(requestTimeoutMs, remainingMs)
                })
            )));
        } catch (error) {
            const attemptErrors = error instanceof AggregateError ? error.errors : [error];
            attemptErrors.forEach((attemptError, index) => {
                errors.push(`${endpoints[index] ?? "Overpass"} ${method}：${attemptError.message}`);
            });
        }
    }

    throw new Error(`Overpass 路网请求失败：${errors.join(" | ")}`);
}

async function fetchOverpassEndpoint(endpoint, query, { fetchImpl, method, requestTimeoutMs }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
        const url = method === "GET" ? `${endpoint}?data=${encodeURIComponent(query)}` : endpoint;
        const response = await fetchImpl(url, {
            method,
            ...(method === "POST" ? { body: new URLSearchParams({ data: query }) } : {}),
            headers: method === "POST"
                ? {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                }
                : { "Accept": "application/json" },
            signal: controller.signal
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`返回非 JSON：${text.slice(0, 120)}`);
        }
    } finally {
        clearTimeout(timeoutId);
    }
}
