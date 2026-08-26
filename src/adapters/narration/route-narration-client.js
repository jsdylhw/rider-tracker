import { getRouteSampleAtDistance } from "../../domain/route/route-builder.js";

const MAX_ROUTE_SAMPLES = 48;
const TARGET_SAMPLE_INTERVAL_MINUTES = 4;

export function createRouteNarrationClient({ baseUrl = "", fetchImpl = fetch } = {}) {
    async function prepare(route, { routeFingerprint } = {}) {
        const response = await fetchImpl(`${baseUrl}/api/route-narrations/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildRequest(route, routeFingerprint))
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error || `路线讲解准备失败（HTTP ${response.status}）`);
        }
        return payload.result;
    }

    return { prepare };
}

export function buildRouteNarrationRequest(route, routeFingerprint) {
    return buildRequest(route, routeFingerprint);
}

function buildRequest(route, routeFingerprint) {
    const totalDistanceMeters = Number(route?.totalDistanceMeters) || 0;
    const estimatedDurationMinutes = estimateDurationMinutes(route);
    const sampleCount = Math.min(MAX_ROUTE_SAMPLES, Math.max(
        6,
        Math.ceil(estimatedDurationMinutes / TARGET_SAMPLE_INTERVAL_MINUTES) + 1
    ));
    const samples = Array.from({ length: sampleCount }, (_, index) => {
        const distanceMeters = sampleCount === 1 ? 0 : totalDistanceMeters * index / (sampleCount - 1);
        const point = getRouteSampleAtDistance(route, distanceMeters);
        return {
            sample_id: `sample_${index + 1}`,
            // Keep rounded payloads compact without letting the final sample
            // cross a fractional route boundary (for example 10399.6 -> 10400).
            route_distance_m: Math.min(totalDistanceMeters, Math.max(0, Math.round(distanceMeters))),
            estimated_elapsed_s: Math.round(estimatedDurationMinutes * 60 * index / (sampleCount - 1)),
            latitude: point.latitude,
            longitude: point.longitude,
            elevation_m: Number.isFinite(point.elevationMeters) ? point.elevationMeters : null,
            grade_percent: Number.isFinite(point.gradePercent) ? point.gradePercent : null
        };
    }).filter((sample) => Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude));

    return {
        route_fingerprint: routeFingerprint,
        route_name: route?.name || "当前路线",
        total_distance_m: totalDistanceMeters,
        estimated_duration_min: estimatedDurationMinutes,
        locale: "zh-CN",
        samples
    };
}

function estimateDurationMinutes(route) {
    const explicit = Number(route?.durationMinutes ?? route?.virtualDurationMinutes);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    return Math.max(20, Math.round((Number(route?.totalDistanceMeters) || 0) / 1000 / 24 * 60));
}
