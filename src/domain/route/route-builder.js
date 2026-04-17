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

    return createRouteObject({
        source: "manual",
        name: "手工路线",
        segments: routeSegments,
        totalDistanceMeters,
        totalElevationGainMeters,
        totalDescentMeters,
        points: routeSegments.map((segment) => ({
            distanceMeters: segment.endDistanceMeters,
            elevationMeters: Math.max(0, routeSegments
                .slice(0, routeSegments.indexOf(segment) + 1)
                .reduce((sum, item) => sum + item.elevationDelta, 0)),
            gradePercent: segment.gradePercent,
            latitude: null,
            longitude: null,
            name: segment.name
        }))
    });
}

export function getSegmentAtDistance(route, distanceMeters) {
    const boundedDistance = Math.max(0, distanceMeters);
    const current = route.segments.find((segment) => boundedDistance < segment.endDistanceMeters);
    return current ?? route.segments.at(-1) ?? null;
}

export function buildRouteFromTrackPoints({ name, points, segments, hasElevationData = true }) {
    const safePoints = points.map((point, index) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        elevationMeters: point.elevationMeters,
        distanceMeters: point.distanceMeters,
        gradePercent: point.gradePercent ?? 0,
        name: point.name ?? `轨迹点 ${index + 1}`
    }));

    const safeSegments = segments.map((segment, index) => ({
        id: crypto.randomUUID(),
        name: segment.name ?? `路段 ${index + 1}`,
        distanceKm: segment.distanceMeters / 1000,
        gradePercent: segment.gradePercent,
        distanceMeters: segment.distanceMeters,
        slopeRatio: segment.gradePercent / 100,
        elevationDelta: segment.elevationDelta,
        startDistanceMeters: segment.startDistanceMeters,
        endDistanceMeters: segment.endDistanceMeters
    }));

    const totalDistanceMeters = safePoints.at(-1)?.distanceMeters ?? 0;
    const totalElevationGainMeters = safeSegments.reduce((sum, segment) => sum + Math.max(0, segment.elevationDelta), 0);
    const totalDescentMeters = safeSegments.reduce((sum, segment) => sum + Math.max(0, -segment.elevationDelta), 0);

    return createRouteObject({
        source: "gpx",
        name: name || "GPX 路线",
        segments: safeSegments,
        totalDistanceMeters,
        totalElevationGainMeters,
        totalDescentMeters,
        points: safePoints,
        hasElevationData
    });
}

export function getRouteSampleAtDistance(route, distanceMeters) {
    // 检查是否已经骑完路线
    const isFinished = distanceMeters >= route.totalDistanceMeters;

    if (!route.points || route.points.length === 0) {
        return {
            latitude: null,
            longitude: null,
            elevationMeters: 0,
            gradePercent: isFinished ? 0 : (getSegmentAtDistance(route, distanceMeters)?.gradePercent ?? 0)
        };
    }

    const boundedDistance = Math.max(0, Math.min(distanceMeters, route.totalDistanceMeters));
    const nextPoint = route.points.find((point) => boundedDistance <= point.distanceMeters) ?? route.points.at(-1);
    const nextIndex = route.points.indexOf(nextPoint);
    const previousPoint = route.points[Math.max(0, nextIndex - 1)] ?? nextPoint;

    if (!previousPoint || !nextPoint || previousPoint.distanceMeters === nextPoint.distanceMeters) {
        return {
            latitude: nextPoint?.latitude ?? null,
            longitude: nextPoint?.longitude ?? null,
            elevationMeters: nextPoint?.elevationMeters ?? 0,
            gradePercent: isFinished ? 0 : (nextPoint?.gradePercent ?? getSegmentAtDistance(route, distanceMeters)?.gradePercent ?? 0)
        };
    }

    const ratio = (boundedDistance - previousPoint.distanceMeters) / (nextPoint.distanceMeters - previousPoint.distanceMeters);

    return {
        latitude: interpolate(previousPoint.latitude, nextPoint.latitude, ratio),
        longitude: interpolate(previousPoint.longitude, nextPoint.longitude, ratio),
        elevationMeters: interpolate(previousPoint.elevationMeters, nextPoint.elevationMeters, ratio),
        gradePercent: isFinished ? 0 : interpolate(previousPoint.gradePercent, nextPoint.gradePercent, ratio)
    };
}

function createRouteObject({ source, name, segments, totalDistanceMeters, totalElevationGainMeters, totalDescentMeters, points, hasElevationData = true }) {
    return {
        source,
        name,
        segments,
        points,
        totalDistanceMeters,
        totalElevationGainMeters,
        totalDescentMeters,
        hasElevationData
    };
}

function interpolate(start, end, ratio) {
    if (start == null || end == null) {
        return start ?? end ?? null;
    }

    return start + (end - start) * Math.min(1, Math.max(0, ratio));
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);

    if (Number.isNaN(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}
