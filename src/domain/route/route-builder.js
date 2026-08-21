const MIN_SEGMENT_DISTANCE_KM = 0.1;
const EARTH_RADIUS_METERS = 6371000;
const MIN_CURVE_RADIUS_METERS = 8;
const MAX_CURVE_RADIUS_METERS = 500;
const DEFAULT_CURVE_LATERAL_G = 0.22;
const MIN_CURVE_SPEED_KPH = 12;
const MAX_CURVE_SPEED_KPH = 90;
const FORWARD_CURVE_WINDOW_METERS = 50;
const FORWARD_CURVE_ANCHOR_METERS = 20;
const FORWARD_CURVE_STEP_METERS = 10;
const MIN_FORWARD_CURVE_TURN_RADIANS = Math.PI / 7.2;
const FORWARD_GRADE_WINDOW_METERS = 50;
const FORWARD_GRADE_STEP_METERS = 10;
const DOWNHILL_SPEED_LIMIT_START_GRADE = -3;
const MAX_DOWNHILL_GRADE_SPEED_KPH = 58;
const MIN_DOWNHILL_GRADE_SPEED_KPH = 24;
const DOWNHILL_GRADE_SPEED_DROP_PER_PERCENT = 3.2;

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

    let elevationMeters = 0;
    const points = routeSegments.length > 0 ? [{
        distanceMeters: 0,
        elevationMeters,
        gradePercent: routeSegments[0].gradePercent,
        latitude: null,
        longitude: null,
        name: "起点"
    }] : [];
    routeSegments.forEach((segment, index) => {
        if (index > 0) {
            points.push({
                distanceMeters: segment.startDistanceMeters,
                elevationMeters,
                gradePercent: segment.gradePercent,
                latitude: null,
                longitude: null,
                name: segment.name
            });
        }
        elevationMeters += segment.elevationDelta;
        points.push({
            distanceMeters: segment.endDistanceMeters,
            elevationMeters,
            gradePercent: segment.gradePercent,
            latitude: null,
            longitude: null,
            name: segment.name
        });
    });

    return createRouteObject({
        source: "manual",
        name: "手工路线",
        segments: routeSegments,
        totalDistanceMeters,
        totalElevationGainMeters,
        totalDescentMeters,
        points
    });
}

export function isRouteReadyForRide(route) {
    return Number.isFinite(route?.totalDistanceMeters)
        && route.totalDistanceMeters > 0
        && route?.isLoading !== true
        && route?.isPrototype !== true
        && route?.isDraft !== true;
}

export function getSegmentAtDistance(route, distanceMeters) {
    const boundedDistance = Math.max(0, distanceMeters);
    const current = route.segments.find((segment) => boundedDistance < segment.endDistanceMeters);
    return current ?? route.segments.at(-1) ?? null;
}

export function buildRouteFromTrackPoints({ name, points, segments, hasElevationData = true, source = "gpx" }) {
    const basePoints = points.map((point, index) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        elevationMeters: point.elevationMeters,
        distanceMeters: point.distanceMeters,
        gradePercent: point.gradePercent ?? 0,
        name: point.name ?? `轨迹点 ${index + 1}`
    }));
    const safePoints = annotateCurveLimits(basePoints);

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
        source,
        name: name || (source === "gpx" ? "GPX 路线" : "地图路线"),
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
        const followingPoint = nextIndex === 0 ? route.points[1] : null;
        return {
            latitude: nextPoint?.latitude ?? null,
            longitude: nextPoint?.longitude ?? null,
            elevationMeters: nextPoint?.elevationMeters ?? 0,
            gradePercent: isFinished ? 0 : (followingPoint?.gradePercent ?? nextPoint?.gradePercent ?? getSegmentAtDistance(route, distanceMeters)?.gradePercent ?? 0)
        };
    }

    const ratio = (boundedDistance - previousPoint.distanceMeters) / (nextPoint.distanceMeters - previousPoint.distanceMeters);

    return {
        latitude: interpolate(previousPoint.latitude, nextPoint.latitude, ratio),
        longitude: interpolate(previousPoint.longitude, nextPoint.longitude, ratio),
        elevationMeters: interpolate(previousPoint.elevationMeters, nextPoint.elevationMeters, ratio),
        gradePercent: isFinished ? 0 : interpolate(previousPoint.gradePercent, nextPoint.gradePercent, ratio),
        curveRadiusMeters: interpolate(previousPoint.curveRadiusMeters, nextPoint.curveRadiusMeters, ratio),
        curveSpeedLimitKph: resolveSampleCurveSpeedLimit(previousPoint, nextPoint)
    };
}

export function getMinimumCurveSpeedLimitAhead(route, distanceMeters, lookaheadMeters = 120) {
    return getForwardCurveSpeedLimitAhead(route, distanceMeters, lookaheadMeters);
}

export function getForwardRouteSpeedLimitAhead(route, distanceMeters, lookaheadMeters = 120) {
    const curveSpeedLimitKph = getForwardCurveSpeedLimitAhead(route, distanceMeters, lookaheadMeters);
    const gradeSpeedLimitKph = getForwardGradeSpeedLimitAhead(route, distanceMeters);
    const limits = [curveSpeedLimitKph, gradeSpeedLimitKph].filter(Number.isFinite);

    return {
        speedLimitKph: limits.length > 0 ? Math.min(...limits) : null,
        curveSpeedLimitKph,
        gradeSpeedLimitKph
    };
}

function getForwardCurveSpeedLimitAhead(route, distanceMeters, lookaheadMeters = 120) {
    if (!route?.points?.length) {
        return null;
    }

    const startDistance = Math.max(0, distanceMeters);
    const endDistance = Math.min(route.totalDistanceMeters ?? startDistance, startDistance + Math.max(0, lookaheadMeters));
    const limits = [];

    for (let anchorDistance = startDistance; anchorDistance <= endDistance; anchorDistance += FORWARD_CURVE_STEP_METERS) {
        const limit = getForwardCurveSpeedLimitAt(route, anchorDistance);
        if (Number.isFinite(limit)) {
            limits.push(limit);
        }
    }

    return limits.length > 0 ? Math.min(...limits) : null;
}

function getForwardCurveSpeedLimitAt(route, distanceMeters) {
    const totalDistanceMeters = route.totalDistanceMeters ?? 0;
    const startDistance = Math.max(0, Math.min(distanceMeters, totalDistanceMeters));
    const anchorDistance = Math.min(startDistance + FORWARD_CURVE_ANCHOR_METERS, totalDistanceMeters);
    const endDistance = Math.min(startDistance + FORWARD_CURVE_WINDOW_METERS, totalDistanceMeters);

    if (endDistance - startDistance < FORWARD_CURVE_ANCHOR_METERS) {
        return null;
    }

    const start = getRouteSampleAtDistance(route, startDistance);
    const anchor = getRouteSampleAtDistance(route, anchorDistance);
    const end = getRouteSampleAtDistance(route, endDistance);
    if (![start, anchor, end].every(hasCoordinates)) {
        return null;
    }

    const radius = calculateForwardCurveRadiusMeters(start, anchor, end);
    const turnRadians = calculateTurnRadians(start, anchor, end);
    const hasCurveLimit = Number.isFinite(radius)
        && radius >= MIN_CURVE_RADIUS_METERS
        && radius <= MAX_CURVE_RADIUS_METERS
        && turnRadians >= MIN_FORWARD_CURVE_TURN_RADIANS;

    return hasCurveLimit ? calculateCurveSpeedLimitKph(radius) : null;
}

function getForwardGradeSpeedLimitAhead(route, distanceMeters) {
    if (!route) {
        return null;
    }

    const startDistance = Math.max(0, distanceMeters);
    const endDistance = Math.min(route.totalDistanceMeters ?? startDistance, startDistance + FORWARD_GRADE_WINDOW_METERS);
    let steepestDownhillGrade = 0;

    for (let sampleDistance = startDistance; sampleDistance <= endDistance; sampleDistance += FORWARD_GRADE_STEP_METERS) {
        const gradePercent = getRouteSampleAtDistance(route, sampleDistance).gradePercent ?? 0;
        steepestDownhillGrade = Math.min(steepestDownhillGrade, gradePercent);
    }

    if (steepestDownhillGrade >= DOWNHILL_SPEED_LIMIT_START_GRADE) {
        return null;
    }

    return clampNumber(
        MAX_DOWNHILL_GRADE_SPEED_KPH + (steepestDownhillGrade - DOWNHILL_SPEED_LIMIT_START_GRADE) * DOWNHILL_GRADE_SPEED_DROP_PER_PERCENT,
        MIN_DOWNHILL_GRADE_SPEED_KPH,
        MAX_DOWNHILL_GRADE_SPEED_KPH,
        MAX_DOWNHILL_GRADE_SPEED_KPH
    );
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

function annotateCurveLimits(points) {
    if (points.length < 3 || !points.every(hasCoordinates)) {
        return points.map((point) => ({
            ...point,
            curveRadiusMeters: null,
            curveSpeedLimitKph: null
        }));
    }

    return points.map((point, index) => {
        if (index === 0 || index === points.length - 1) {
            return {
                ...point,
                curveRadiusMeters: null,
                curveSpeedLimitKph: null
            };
        }

        const radius = calculateCurveRadiusMeters(points[index - 1], point, points[index + 1]);
        const hasCurveLimit = Number.isFinite(radius) && radius >= MIN_CURVE_RADIUS_METERS && radius <= MAX_CURVE_RADIUS_METERS;

        return {
            ...point,
            curveRadiusMeters: hasCurveLimit ? radius : null,
            curveSpeedLimitKph: hasCurveLimit ? calculateCurveSpeedLimitKph(radius) : null
        };
    });
}

function calculateCurveRadiusMeters(previousPoint, point, nextPoint) {
    const originLat = point.latitude;
    const originLng = point.longitude;
    const previous = projectToLocalMeters(previousPoint, originLat, originLng);
    const current = projectToLocalMeters(point, originLat, originLng);
    const next = projectToLocalMeters(nextPoint, originLat, originLng);
    const sideA = distanceBetweenLocalPoints(current, next);
    const sideB = distanceBetweenLocalPoints(previous, next);
    const sideC = distanceBetweenLocalPoints(previous, current);
    const areaTwice = Math.abs(
        previous.x * (current.y - next.y)
        + current.x * (next.y - previous.y)
        + next.x * (previous.y - current.y)
    );

    if (sideA <= 0 || sideB <= 0 || sideC <= 0 || areaTwice <= 0.001) {
        return Infinity;
    }

    return (sideA * sideB * sideC) / (2 * areaTwice);
}

function calculateForwardCurveRadiusMeters(startPoint, anchorPoint, endPoint) {
    const radius = calculateCurveRadiusMeters(startPoint, anchorPoint, endPoint);
    if (!Number.isFinite(radius)) {
        return radius;
    }

    const turnRadians = calculateTurnRadians(startPoint, anchorPoint, endPoint);
    return turnRadians > 0 ? FORWARD_CURVE_WINDOW_METERS / turnRadians : Infinity;
}

function calculateTurnRadians(startPoint, anchorPoint, endPoint) {
    const start = projectToLocalMeters(startPoint, anchorPoint.latitude, anchorPoint.longitude);
    const anchor = projectToLocalMeters(anchorPoint, anchorPoint.latitude, anchorPoint.longitude);
    const end = projectToLocalMeters(endPoint, anchorPoint.latitude, anchorPoint.longitude);
    const incoming = {
        x: anchor.x - start.x,
        y: anchor.y - start.y
    };
    const outgoing = {
        x: end.x - anchor.x,
        y: end.y - anchor.y
    };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    if (incomingLength < 1 || outgoingLength < 1) {
        return 0;
    }

    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    return Math.abs(Math.atan2(cross, dot));
}

function calculateCurveSpeedLimitKph(radiusMeters) {
    const speedMps = Math.sqrt(DEFAULT_CURVE_LATERAL_G * 9.80665 * radiusMeters);
    return Math.min(MAX_CURVE_SPEED_KPH, Math.max(MIN_CURVE_SPEED_KPH, speedMps * 3.6));
}

function projectToLocalMeters(point, originLat, originLng) {
    const latRadians = toRadians(originLat);

    return {
        x: toRadians(point.longitude - originLng) * EARTH_RADIUS_METERS * Math.cos(latRadians),
        y: toRadians(point.latitude - originLat) * EARTH_RADIUS_METERS
    };
}

function distanceBetweenLocalPoints(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y);
}

function resolveSampleCurveSpeedLimit(previousPoint, nextPoint) {
    const limits = [previousPoint.curveSpeedLimitKph, nextPoint.curveSpeedLimitKph].filter(Number.isFinite);

    return limits.length > 0 ? Math.min(...limits) : null;
}

function hasCoordinates(point) {
    return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
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

function toRadians(value) {
    return value * Math.PI / 180;
}
