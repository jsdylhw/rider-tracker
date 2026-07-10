import { calculateWindowedGrades } from "../../domain/route/track-route.js";

const ELEVATION_CACHE_KEY = "riderTracker:mapRouteElevationCache:v1";
const ELEVATION_USAGE_KEY = "riderTracker:mapRouteElevationUsage:v1";
const ELEVATION_BATCH_SIZE = 512;
const ELEVATION_CACHE_MAX_ENTRIES = 12000;
const ELEVATION_DAILY_REQUEST_CAP = 250;
const ELEVATION_MONTHLY_REQUEST_CAP = 3000;

export async function enrichTrackPointsWithGoogleElevation(points, {
    storage = globalThis.localStorage,
    now = () => new Date(),
    dailyRequestCap = ELEVATION_DAILY_REQUEST_CAP,
    monthlyRequestCap = ELEVATION_MONTHLY_REQUEST_CAP,
    elevationService = new window.google.maps.ElevationService()
} = {}) {
    const elevationCache = readJson(storage, ELEVATION_CACHE_KEY, {});
    const uniqueMissing = new Map();
    let cacheHits = 0;

    const enriched = points.map((point) => {
        const key = getElevationCacheKey(point);
        const cached = elevationCache[key];

        if (cached) {
            cacheHits += 1;
            return applyElevation(point, cached.elevationMeters);
        }

        if (!uniqueMissing.has(key)) {
            uniqueMissing.set(key, {
                key,
                lat: point.latitude,
                lng: point.longitude
            });
        }

        return { ...point };
    });

    let requests = 0;
    let requestedPoints = 0;
    let skippedByQuota = false;
    const missing = [...uniqueMissing.values()];

    for (let index = 0; index < missing.length; index += ELEVATION_BATCH_SIZE) {
        const batch = missing.slice(index, index + ELEVATION_BATCH_SIZE);
        if (!reserveQuota({ storage, now, requests: 1, dailyRequestCap, monthlyRequestCap })) {
            skippedByQuota = true;
            break;
        }

        requests += 1;
        requestedPoints += batch.length;
        const elevations = await requestElevationBatch(elevationService, batch);

        elevations.forEach((item) => {
            elevationCache[item.key] = {
                elevationMeters: item.elevationMeters,
                updatedAt: Date.now()
            };
        });
        trimCache(elevationCache);
        writeJson(storage, ELEVATION_CACHE_KEY, elevationCache);
    }

    const withElevation = enriched.map((point) => {
        const cached = elevationCache[getElevationCacheKey(point)];
        return cached ? applyElevation(point, cached.elevationMeters) : point;
    });
    const hasElevationData = withElevation.every((point) => Number.isFinite(point.elevationMeters) && point.elevationLoaded === true);

    return {
        points: hasElevationData ? calculateWindowedGrades(withElevation) : withElevation,
        hasElevationData,
        summary: {
            cacheHits,
            requestedPoints,
            requests,
            skippedByQuota,
            dailyRequestCap,
            monthlyRequestCap,
            batchSize: ELEVATION_BATCH_SIZE,
            updatedAt: new Date().toISOString()
        }
    };
}

function requestElevationBatch(elevationService, batch) {
    return new Promise((resolve, reject) => {
        elevationService.getElevationForLocations(
            {
                locations: batch.map((point) => ({ lat: point.lat, lng: point.lng }))
            },
            (results, status) => {
                if (status !== "OK") {
                    reject(new Error(`Elevation API 返回 ${status}`));
                    return;
                }

                resolve(batch.map((point, index) => ({
                    key: point.key,
                    elevationMeters: Number(results?.[index]?.elevation) || 0
                })));
            }
        );
    });
}

function reserveQuota({ storage, now, requests, dailyRequestCap, monthlyRequestCap }) {
    const current = now();
    const day = current.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const usage = readJson(storage, ELEVATION_USAGE_KEY, {
        day,
        month,
        dailyRequests: 0,
        monthlyRequests: 0
    });

    if (usage.day !== day) {
        usage.day = day;
        usage.dailyRequests = 0;
    }
    if (usage.month !== month) {
        usage.month = month;
        usage.monthlyRequests = 0;
    }
    if (usage.dailyRequests + requests > dailyRequestCap) return false;
    if (usage.monthlyRequests + requests > monthlyRequestCap) return false;

    usage.dailyRequests += requests;
    usage.monthlyRequests += requests;
    writeJson(storage, ELEVATION_USAGE_KEY, usage);
    return true;
}

function trimCache(elevationCache) {
    const entries = Object.entries(elevationCache);
    if (entries.length <= ELEVATION_CACHE_MAX_ENTRIES) {
        return;
    }

    entries
        .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
        .slice(0, entries.length - ELEVATION_CACHE_MAX_ENTRIES)
        .forEach(([key]) => {
            delete elevationCache[key];
        });
}

function applyElevation(point, elevationMeters) {
    return {
        ...point,
        elevationMeters: round(elevationMeters, 1),
        elevationLoaded: true
    };
}

function getElevationCacheKey(point) {
    return `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
}

function readJson(storage, key, fallback) {
    try {
        const raw = storage?.getItem?.(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(storage, key, value) {
    try {
        storage?.setItem?.(key, JSON.stringify(value));
    } catch {
        // Local cache is best-effort.
    }
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
