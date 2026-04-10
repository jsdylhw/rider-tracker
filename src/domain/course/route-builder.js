const MIN_SEGMENT_DISTANCE_KM = 0.1;

export function sanitizeSegments(segments) {
    return segments.map((segment, index) => ({
        id: segment.id ?? crypto.randomUUID(),
        name: String(segment.name || `路段 ${index + 1}`),
        distanceKm: clampNumber(segment.distanceKm, MIN_SEGMENT_DISTANCE_KM, 200, 1),
        gradePercent: clampNumber(segment.gradePercent, -15, 20, 0)
    }));
}

export function buildRoute(segments) {
    const sanitized = sanitizeSegments(segments);
    let totalDistanceMeters = 0;
    let totalElevationGainMeters = 0;
    let totalDescentMeters = 0;

    const routeSegments = sanitized.map((segment) => {
        const distanceMeters = segment.distanceKm * 1000;
        const slopeRatio = segment.gradePercent / 100;
        const elevationDelta = distanceMeters * slopeRatio;
        const startDistanceMeters = totalDistanceMeters;
        totalDistanceMeters += distanceMeters;

        if (elevationDelta > 0) {
            totalElevationGainMeters += elevationDelta;
        } else {
            totalDescentMeters += Math.abs(elevationDelta);
        }

        return {
            ...segment,
            distanceMeters,
            slopeRatio,
            elevationDelta,
            startDistanceMeters,
            endDistanceMeters: totalDistanceMeters
        };
    });

    return {
        segments: routeSegments,
        totalDistanceMeters,
        totalElevationGainMeters,
        totalDescentMeters
    };
}

export function getSegmentAtDistance(route, distanceMeters) {
    const boundedDistance = Math.max(0, distanceMeters);
    const current = route.segments.find((segment) => boundedDistance < segment.endDistanceMeters);
    return current ?? route.segments.at(-1) ?? null;
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);

    if (Number.isNaN(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}
