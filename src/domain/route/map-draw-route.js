import { buildRouteFromTrackPoints } from "./route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "./track-route.js";

export const MAP_DRAW_SAMPLE_SPACING_METERS = 20;
const MIN_DISTINCT_POINT_DISTANCE_METERS = 1;

export function buildMapDrawRoute({
    waypoints,
    routePath,
    totalDistanceMeters = null,
    estimatedDuration = null,
    travelMode = "BICYCLE",
    sampleSpacingMeters = MAP_DRAW_SAMPLE_SPACING_METERS
} = {}) {
    const normalizedWaypoints = normalizeWaypoints(waypoints);
    if (normalizedWaypoints.length < 2) {
        throw new Error("请至少在地图上选择两个不同的点。");
    }

    const normalizedRoutePath = normalizeWaypoints(routePath);
    if (normalizedRoutePath.length < 2) {
        throw new Error("导航服务未返回可用的道路路线。");
    }

    const points = sampleWaypoints(normalizedRoutePath, sampleSpacingMeters, totalDistanceMeters);
    if (points.length < 2 || points.at(-1)?.distanceMeters <= 0) {
        throw new Error("所选点之间距离过短，请重新选择路线。");
    }

    const route = buildRouteFromTrackPoints({
        source: "map-drawn",
        name: "地图绘制路线",
        points,
        segments: buildSummarySegmentsFromTrackPoints(points, {
            hasElevationData: false,
            namePrefix: "地图路线"
        }),
        hasElevationData: false
    });

    return {
        ...route,
        waypoints: normalizedWaypoints.map((point, index) => ({
            ...point,
            index: index + 1
        })),
        mapGeometry: normalizedRoutePath.map(({ lat, lng }) => ({
            lat,
            lng
        })),
        waypointSnaps: normalizedWaypoints.map((requested, index) => {
            const snapped = findNearestRoutePoint(requested, normalizedRoutePath);
            return {
                index: index + 1,
                requested,
                snapped,
                offsetMeters: haversineDistanceMeters(requested, snapped)
            };
        }),
        routeProvider: "google-routes",
        travelMode,
        estimatedDuration
    };
}

function findNearestRoutePoint(point, routePath) {
    return routePath.reduce((nearest, candidate) => (
        haversineDistanceMeters(point, candidate) < haversineDistanceMeters(point, nearest)
            ? candidate
            : nearest
    ));
}

function normalizeWaypoints(waypoints) {
    const normalized = [];

    for (const waypoint of waypoints ?? []) {
        const lat = Number(waypoint?.lat ?? waypoint?.latitude);
        const lng = Number(waypoint?.lng ?? waypoint?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            continue;
        }

        const point = { lat, lng };
        const previous = normalized.at(-1);
        if (previous && haversineDistanceMeters(previous, point) < MIN_DISTINCT_POINT_DISTANCE_METERS) {
            continue;
        }
        normalized.push(point);
    }

    return normalized;
}

function sampleWaypoints(waypoints, sampleSpacingMeters, totalDistanceMeters) {
    const spacing = Math.max(5, Number(sampleSpacingMeters) || MAP_DRAW_SAMPLE_SPACING_METERS);
    const points = [{
        latitude: waypoints[0].lat,
        longitude: waypoints[0].lng,
        elevationMeters: 0,
        gradePercent: 0,
        distanceMeters: 0,
        name: "地图点 1"
    }];
    let cumulativeDistanceMeters = 0;

    for (let index = 1; index < waypoints.length; index += 1) {
        const previous = waypoints[index - 1];
        const current = waypoints[index];
        const legDistanceMeters = haversineDistanceMeters(previous, current);
        const steps = Math.max(1, Math.ceil(legDistanceMeters / spacing));

        for (let step = 1; step <= steps; step += 1) {
            const ratio = step / steps;
            points.push({
                latitude: interpolate(previous.lat, current.lat, ratio),
                longitude: interpolate(previous.lng, current.lng, ratio),
                elevationMeters: 0,
                gradePercent: 0,
                distanceMeters: cumulativeDistanceMeters + legDistanceMeters * ratio,
                name: step === steps ? `地图点 ${index + 1}` : `路线采样 ${points.length + 1}`
            });
        }
        cumulativeDistanceMeters += legDistanceMeters;
    }

    const sampledDistanceMeters = points.at(-1)?.distanceMeters ?? 0;
    const resolvedTotalDistanceMeters = Number.isFinite(totalDistanceMeters) && totalDistanceMeters > 0
        ? totalDistanceMeters
        : sampledDistanceMeters;
    if (sampledDistanceMeters <= 0 || resolvedTotalDistanceMeters === sampledDistanceMeters) {
        return points;
    }

    const scale = resolvedTotalDistanceMeters / sampledDistanceMeters;
    return points.map((point) => ({
        ...point,
        distanceMeters: point.distanceMeters * scale
    }));
}

function haversineDistanceMeters(first, second) {
    const earthRadiusMeters = 6371000;
    const latitudeDelta = toRadians(second.lat - first.lat);
    const longitudeDelta = toRadians(second.lng - first.lng);
    const latitude1 = toRadians(first.lat);
    const latitude2 = toRadians(second.lat);
    const value = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function interpolate(start, end, ratio) {
    return start + (end - start) * ratio;
}

function toRadians(value) {
    return value * Math.PI / 180;
}
