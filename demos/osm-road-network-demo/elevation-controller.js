const ELEVATION_CACHE_KEY = "osmRoadNetworkDemo:elevationCache:v1";
const ELEVATION_USAGE_KEY = "osmRoadNetworkDemo:elevationUsage:v1";
const ELEVATION_BATCH_SIZE = 512;
const ELEVATION_CACHE_MAX_ENTRIES = 8000;
const ELEVATION_DAILY_REQUEST_CAP = 250;
const ELEVATION_MONTHLY_REQUEST_CAP = 3000;
const GRADE_WINDOW_METERS = 60;
const MAX_GRADE_PERCENT = 18;

export function createRouteElevationController({
    storage = globalThis.localStorage,
    now = () => new Date(),
    dailyRequestCap = ELEVATION_DAILY_REQUEST_CAP,
    monthlyRequestCap = ELEVATION_MONTHLY_REQUEST_CAP,
    onUpdate = () => {}
} = {}) {
    const elevationService = new window.google.maps.ElevationService();
    const elevationCache = readJson(storage, ELEVATION_CACHE_KEY, {});
    let chain = Promise.resolve();

    function enrichRoute(route, { mode = "incremental" } = {}) {
        chain = chain
            .catch(() => {})
            .then(() => enrichRouteNow(route, { mode }));
        return chain;
    }

    async function enrichRouteNow(route, { mode }) {
        if (!route?.points?.length) {
            return buildSummary({ mode, cacheHits: 0, requestedPoints: 0, requests: 0, skippedByQuota: false });
        }

        const uniqueMissing = new Map();
        let cacheHits = 0;
        for (const point of route.points) {
            const key = getElevationCacheKey(point);
            const cached = elevationCache[key];
            if (cached) {
                applyElevation(point, cached.elevationMeters);
                cacheHits += 1;
            } else if (!uniqueMissing.has(key)) {
                uniqueMissing.set(key, {
                    key,
                    lat: point.latitude,
                    lng: point.longitude
                });
            }
        }

        let requests = 0;
        let requestedPoints = 0;
        let skippedByQuota = false;
        const missing = [...uniqueMissing.values()];
        for (let index = 0; index < missing.length; index += ELEVATION_BATCH_SIZE) {
            const batch = missing.slice(index, index + ELEVATION_BATCH_SIZE);
            if (!reserveQuota(1)) {
                skippedByQuota = true;
                break;
            }
            requests += 1;
            requestedPoints += batch.length;
            const elevations = await requestElevationBatch(batch);
            elevations.forEach((item) => {
                elevationCache[item.key] = {
                    elevationMeters: item.elevationMeters,
                    updatedAt: Date.now()
                };
            });
            trimCache();
            writeJson(storage, ELEVATION_CACHE_KEY, elevationCache);
        }

        for (const point of route.points) {
            const cached = elevationCache[getElevationCacheKey(point)];
            if (cached) {
                applyElevation(point, cached.elevationMeters);
            }
        }
        updateRouteGrades(route);

        const summary = buildSummary({
            mode,
            cacheHits,
            requestedPoints,
            requests,
            skippedByQuota,
            dailyRequestCap,
            monthlyRequestCap
        });
        route.elevation = summary;
        onUpdate(summary);
        return summary;
    }

    function requestElevationBatch(batch) {
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

    function reserveQuota(requests) {
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

    function trimCache() {
        const entries = Object.entries(elevationCache);
        if (entries.length <= ELEVATION_CACHE_MAX_ENTRIES) return;
        entries
            .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
            .slice(0, entries.length - ELEVATION_CACHE_MAX_ENTRIES)
            .forEach(([key]) => {
                delete elevationCache[key];
            });
    }

    return { enrichRoute };
}

function updateRouteGrades(route) {
    const points = route.points ?? [];
    points.forEach((point) => {
        const before = findPointNearDistance(points, point.distanceMeters - GRADE_WINDOW_METERS / 2);
        const after = findPointNearDistance(points, point.distanceMeters + GRADE_WINDOW_METERS / 2);
        if (
            !before?.elevationLoaded
            || !after?.elevationLoaded
            || !Number.isFinite(before?.elevationMeters)
            || !Number.isFinite(after?.elevationMeters)
            || !Number.isFinite(before?.distanceMeters)
            || !Number.isFinite(after?.distanceMeters)
            || after.distanceMeters <= before.distanceMeters
        ) {
            point.gradePercent = 0;
            return;
        }

        const grade = ((after.elevationMeters - before.elevationMeters) / (after.distanceMeters - before.distanceMeters)) * 100;
        point.gradePercent = round(clamp(grade, -MAX_GRADE_PERCENT, MAX_GRADE_PERCENT), 2);
    });
}

function findPointNearDistance(points, targetDistanceMeters) {
    if (points.length === 0) return null;
    let best = points[0];
    let bestDistance = Math.abs(points[0].distanceMeters - targetDistanceMeters);
    for (const point of points) {
        const distance = Math.abs(point.distanceMeters - targetDistanceMeters);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }
    return best;
}

function applyElevation(point, elevationMeters) {
    point.elevationMeters = round(elevationMeters, 1);
    point.elevationLoaded = true;
}

function getElevationCacheKey(point) {
    return `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
}

function buildSummary({ mode, cacheHits, requestedPoints, requests, skippedByQuota, dailyRequestCap, monthlyRequestCap }) {
    return {
        mode,
        cacheHits,
        requestedPoints,
        requests,
        skippedByQuota,
        dailyRequestCap,
        monthlyRequestCap,
        batchSize: ELEVATION_BATCH_SIZE,
        updatedAt: new Date().toISOString()
    };
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
        // Demo cache is best-effort.
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
