import { buildRouteFromTrackPoints } from "./route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "./track-route.js";

export const COORDINATE_ROUTE_SAMPLE_SPACING_METERS = 20;
const MIN_DISTINCT_POINT_DISTANCE_METERS = 1;

/** Build Rider's runtime route from a provider-neutral WGS84 coordinate line. */
export function buildCoordinateRoute({
    waypoints,
    routePath,
    totalDistanceMeters = null,
    estimatedDuration = null,
    travelMode = "BICYCLE",
    sampleSpacingMeters = COORDINATE_ROUTE_SAMPLE_SPACING_METERS,
    source = "coordinate-route",
    name = "坐标路线",
    routeProvider = "coordinate-contract"
} = {}) {
    const normalizedWaypoints = normalizePoints(waypoints);
    if (normalizedWaypoints.length < 2) throw new Error("路线至少需要两个不同的有效点。");
    const normalizedRoutePath = normalizePoints(routePath);
    if (normalizedRoutePath.length < 2) throw new Error("路线没有可用的道路坐标。");

    const points = samplePoints(normalizedRoutePath, sampleSpacingMeters, totalDistanceMeters);
    if (points.length < 2 || points.at(-1)?.distanceMeters <= 0) {
        throw new Error("路线距离过短，无法开始骑行。");
    }
    const route = buildRouteFromTrackPoints({
        source,
        name,
        points,
        segments: buildSummarySegmentsFromTrackPoints(points, {
            hasElevationData: false,
            namePrefix: name
        }),
        hasElevationData: false
    });
    return {
        ...route,
        waypoints: normalizedWaypoints.map((point, index) => ({ ...point, index: index + 1 })),
        mapGeometry: normalizedRoutePath.map(({ lat, lng }) => ({ lat, lng })),
        waypointSnaps: normalizedWaypoints.map((requested, index) => {
            const snapped = findNearestRoutePoint(requested, normalizedRoutePath);
            return { index: index + 1, requested, snapped, offsetMeters: haversineDistanceMeters(requested, snapped) };
        }),
        routeProvider,
        travelMode,
        estimatedDuration
    };
}

function findNearestRoutePoint(point, routePath) {
    return routePath.reduce((nearest, candidate) => (
        haversineDistanceMeters(point, candidate) < haversineDistanceMeters(point, nearest)
            ? candidate : nearest
    ));
}

function normalizePoints(values) {
    const normalized = [];
    for (const value of values ?? []) {
        const lat = Number(value?.lat ?? value?.latitude);
        const lng = Number(value?.lng ?? value?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        const point = { lat, lng };
        const previous = normalized.at(-1);
        if (previous && haversineDistanceMeters(previous, point) < MIN_DISTINCT_POINT_DISTANCE_METERS) continue;
        normalized.push(point);
    }
    return normalized;
}

function samplePoints(points, sampleSpacingMeters, totalDistanceMeters) {
    const spacing = Math.max(5, Number(sampleSpacingMeters) || COORDINATE_ROUTE_SAMPLE_SPACING_METERS);
    const samples = [{
        latitude: points[0].lat, longitude: points[0].lng, elevationMeters: 0,
        gradePercent: 0, distanceMeters: 0, name: "路线点 1"
    }];
    let cumulativeDistanceMeters = 0;
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        const legDistanceMeters = haversineDistanceMeters(previous, current);
        const steps = Math.max(1, Math.ceil(legDistanceMeters / spacing));
        for (let step = 1; step <= steps; step += 1) {
            const ratio = step / steps;
            samples.push({
                latitude: interpolate(previous.lat, current.lat, ratio),
                longitude: interpolate(previous.lng, current.lng, ratio),
                elevationMeters: 0,
                gradePercent: 0,
                distanceMeters: cumulativeDistanceMeters + legDistanceMeters * ratio,
                name: step === steps ? `路线点 ${index + 1}` : `路线采样 ${samples.length + 1}`
            });
        }
        cumulativeDistanceMeters += legDistanceMeters;
    }
    const sampledDistanceMeters = samples.at(-1)?.distanceMeters ?? 0;
    const resolvedTotal = Number.isFinite(totalDistanceMeters) && totalDistanceMeters > 0
        ? totalDistanceMeters : sampledDistanceMeters;
    if (sampledDistanceMeters <= 0 || resolvedTotal === sampledDistanceMeters) return samples;
    const scale = resolvedTotal / sampledDistanceMeters;
    return samples.map((point) => ({ ...point, distanceMeters: point.distanceMeters * scale }));
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

function interpolate(start, end, ratio) { return start + (end - start) * ratio; }
function toRadians(value) { return value * Math.PI / 180; }
