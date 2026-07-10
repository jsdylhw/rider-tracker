import { buildOverpassRoadQuery } from "../../domain/route/osm-road-network.js";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
];

const OVERPASS_REQUEST_TIMEOUT_MS = 8000;

export async function fetchOverpassRoadNetwork(bounds, {
    fetchImpl = globalThis.fetch,
    endpoints = OVERPASS_ENDPOINTS,
    requestTimeoutMs = OVERPASS_REQUEST_TIMEOUT_MS
} = {}) {
    if (!fetchImpl) {
        throw new Error("当前环境不支持 fetch，无法请求 OSM 路网");
    }

    const query = buildOverpassRoadQuery(bounds);
    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            return await fetchOverpassEndpoint(endpoint, query, { fetchImpl, requestTimeoutMs });
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error("Overpass 路网请求失败");
}

async function fetchOverpassEndpoint(endpoint, query, { fetchImpl, requestTimeoutMs }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
        const response = await fetchImpl(endpoint, {
            method: "POST",
            body: query,
            headers: {
                "Content-Type": "text/plain;charset=UTF-8"
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Overpass 返回 ${response.status}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}
