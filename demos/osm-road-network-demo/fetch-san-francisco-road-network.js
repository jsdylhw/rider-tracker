import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    NETWORK_SIZE_KM,
    ROAD_NETWORK_PRESETS,
    buildBoundsAroundCenter,
    buildOverpassQuery
} from "./road-network-core.js";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
];
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "rider-tracker-osm-road-network-demo/1.0 (local prototype; contact: local)"
};

const presetId = process.argv[2] ?? "san-francisco";
const preset = ROAD_NETWORK_PRESETS.find((candidate) => candidate.id === presetId);
if (!preset) {
    throw new Error(`Unknown road-network preset: ${presetId}`);
}

const demoDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(demoDir, `fixtures/${preset.id}-road-network.json`);

const bounds = buildBoundsAroundCenter(preset.center, NETWORK_SIZE_KM);
const query = buildOverpassQuery(bounds);

console.log(`Fetching ${preset.label} ${NETWORK_SIZE_KM}km road network...`);
console.log(`Bounds: ${bounds.south}, ${bounds.west}, ${bounds.north}, ${bounds.east}`);

const data = await fetchOverpassJson(query);
const output = {
    ...data,
    cacheMetadata: {
        generatedAt: new Date().toISOString(),
        source: "overpass",
        presetId: preset.id,
        center: preset.center,
        sizeKm: NETWORK_SIZE_KM,
        bounds,
        query
    }
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Saved ${output.elements?.length ?? 0} OSM elements to ${outputPath}`);

async function fetchOverpassJson(overpassQuery) {
    const errors = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
        for (const method of ["POST", "GET"]) {
            try {
                console.log(`Trying ${endpoint} ${method}...`);
                const response = method === "POST"
                    ? await fetchWithTimeout(endpoint, {
                        method,
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                            ...REQUEST_HEADERS
                        },
                        body: new URLSearchParams({ data: overpassQuery })
                    })
                    : await fetchWithTimeout(`${endpoint}?data=${encodeURIComponent(overpassQuery)}`, {
                        headers: REQUEST_HEADERS
                    });

                const text = await response.text();
                if (!response.ok) {
                    errors.push(`${endpoint} ${method} HTTP ${response.status}: ${text.slice(0, 160)}`);
                    continue;
                }
                return JSON.parse(text);
            } catch (error) {
                errors.push(`${endpoint} ${method}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    throw new Error(errors.join(" | "));
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}
