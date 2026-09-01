import { getRouteSampleAtDistance } from "../../domain/route/route-builder.js";
import { resolveSpeedTarget } from "../../domain/physics/cycling-model.js";

const MAX_ROUTE_SAMPLES = 48;
const TARGET_SAMPLE_INTERVAL_MINUTES = 4;
const NARRATION_POWER_FTP_RATIO = 0.6;
const MIN_ESTIMATED_SPEED_KPH = 4;
const MAX_ESTIMATED_SPEED_KPH = 60;

export function createRouteNarrationClient({ baseUrl = "", fetchImpl = fetch } = {}) {
    async function prepare(route, { routeFingerprint, rideSettings } = {}) {
        const response = await fetchImpl(`${baseUrl}/api/route-narrations/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildRequest(route, routeFingerprint, rideSettings))
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error || `路线讲解准备失败（HTTP ${response.status}）`);
        }
        return payload.result;
    }

    return { prepare };
}

export function buildRouteNarrationRequest(route, routeFingerprint, rideSettings) {
    return buildRequest(route, routeFingerprint, rideSettings);
}

function buildRequest(route, routeFingerprint, rideSettings) {
    const totalDistanceMeters = Number(route?.totalDistanceMeters) || 0;
    const durationEstimate = estimateRouteNarrationDuration(route, rideSettings);
    const estimatedDurationMinutes = durationEstimate.minutes;
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
        duration_estimation: {
            method: durationEstimate.method,
            target_power_w: durationEstimate.targetPowerWatts,
            ftp_ratio: durationEstimate.ftpRatio
        },
        locale: "zh-CN",
        samples
    };
}

export function estimateRouteNarrationDuration(route, rideSettings = {}) {
    const physicsEstimate = estimateDurationFromRouteProfile(route, rideSettings);
    if (physicsEstimate) return physicsEstimate;

    const explicit = Number(route?.durationMinutes ?? route?.virtualDurationMinutes);
    if (Number.isFinite(explicit) && explicit > 0) {
        return { minutes: Math.round(explicit), method: "route_duration", targetPowerWatts: null, ftpRatio: null };
    }
    return {
        minutes: Math.max(20, Math.round((Number(route?.totalDistanceMeters) || 0) / 1000 / 24 * 60)),
        method: "distance_at_24_kph",
        targetPowerWatts: null,
        ftpRatio: null
    };
}

function estimateDurationFromRouteProfile(route, rideSettings) {
    if (route?.hasElevationData === false) return null;
    const ftp = Number(rideSettings?.ftp);
    const mass = Number(rideSettings?.mass);
    const crr = Number(rideSettings?.crr);
    const cda = Number(rideSettings?.cda);
    const windSpeed = Number(rideSettings?.windSpeed ?? 0);
    if (![ftp, mass, crr, cda, windSpeed].every(Number.isFinite)
        || ftp <= 0 || mass <= 0 || crr <= 0 || cda <= 0) {
        return null;
    }

    const profileSegments = buildProfileSegments(route);
    if (profileSegments.length === 0) return null;

    const targetPowerWatts = ftp * NARRATION_POWER_FTP_RATIO;
    const minimumSpeedMps = MIN_ESTIMATED_SPEED_KPH / 3.6;
    const maximumSpeedMps = MAX_ESTIMATED_SPEED_KPH / 3.6;
    const seconds = profileSegments.reduce((total, segment) => {
        const speedMps = resolveSpeedTarget({
            power: targetPowerWatts,
            gradePercent: segment.gradePercent,
            mass,
            crr,
            cda,
            windSpeed
        });
        const boundedSpeedMps = Math.max(minimumSpeedMps, Math.min(maximumSpeedMps, speedMps));
        return total + segment.distanceMeters / boundedSpeedMps;
    }, 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return {
        minutes: Math.max(1, Math.round(seconds / 60)),
        method: "route_profile_at_60pct_ftp",
        targetPowerWatts: Math.round(targetPowerWatts),
        ftpRatio: NARRATION_POWER_FTP_RATIO
    };
}

function buildProfileSegments(route) {
    const routeSegments = (route?.segments ?? []).map((segment) => ({
        distanceMeters: Number(segment?.distanceMeters ?? (
            Number(segment?.endDistanceMeters) - Number(segment?.startDistanceMeters)
        )),
        gradePercent: Number(segment?.gradePercent)
    })).filter(isUsableProfileSegment);
    if (hasCompleteProfileCoverage(routeSegments, route?.totalDistanceMeters)) return routeSegments;

    const points = Array.isArray(route?.points) ? route.points : [];
    const pointSegments = points.slice(1).map((point, index) => ({
        distanceMeters: Number(point?.distanceMeters) - Number(points[index]?.distanceMeters),
        gradePercent: averageFinite(points[index]?.gradePercent, point?.gradePercent)
    })).filter(isUsableProfileSegment);
    return hasCompleteProfileCoverage(pointSegments, route?.totalDistanceMeters) ? pointSegments : [];
}

function isUsableProfileSegment(segment) {
    return Number.isFinite(segment.distanceMeters)
        && segment.distanceMeters > 0
        && Number.isFinite(segment.gradePercent);
}

function hasCompleteProfileCoverage(segments, totalDistanceMeters) {
    const routeDistance = Number(totalDistanceMeters);
    if (!Number.isFinite(routeDistance) || routeDistance <= 0 || segments.length === 0) return false;
    const coveredDistance = segments.reduce((sum, segment) => sum + segment.distanceMeters, 0);
    // Permit sub-metre and ordinary GPX rounding differences, but never use a
    // partial profile as though it represented the complete route.
    return coveredDistance >= routeDistance * 0.99 && coveredDistance <= routeDistance * 1.01;
}

function averageFinite(first, second) {
    const values = [Number(first), Number(second)].filter(Number.isFinite);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}
