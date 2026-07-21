const SEGMENT_BUCKET_METERS = 500;
const MAX_REASONABLE_GRADE_PERCENT = 20;

export function buildSummarySegmentsFromTrackPoints(points, {
    hasElevationData = true,
    namePrefix = "路线"
} = {}) {
    if (!points?.length) {
        return [];
    }

    if (!hasElevationData) {
        const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;

        return [{
            name: `${namePrefix} 全程`,
            distanceMeters: totalDistanceMeters,
            gradePercent: 0,
            elevationDelta: 0,
            startDistanceMeters: 0,
            endDistanceMeters: totalDistanceMeters
        }];
    }

    const segments = [];
    let bucketStart = points[0];
    let bucketElevationDelta = 0;
    let bucketDistance = 0;
    let segmentIndex = 1;

    for (let index = 1; index < points.length; index += 1) {
        const currentPoint = points[index];
        const previousPoint = points[index - 1];
        const deltaDistance = currentPoint.distanceMeters - previousPoint.distanceMeters;
        const deltaElevation = (currentPoint.elevationMeters ?? 0) - (previousPoint.elevationMeters ?? 0);

        bucketDistance += deltaDistance;
        bucketElevationDelta += deltaElevation;

        const shouldFlush = bucketDistance >= SEGMENT_BUCKET_METERS || index === points.length - 1;

        if (!shouldFlush) {
            continue;
        }

        segments.push({
            name: `${namePrefix} 路段 ${segmentIndex}`,
            distanceMeters: bucketDistance,
            gradePercent: bucketDistance > 0 ? clampGrade((bucketElevationDelta / bucketDistance) * 100) : 0,
            elevationDelta: bucketElevationDelta,
            startDistanceMeters: bucketStart.distanceMeters,
            endDistanceMeters: currentPoint.distanceMeters
        });

        bucketStart = currentPoint;
        bucketDistance = 0;
        bucketElevationDelta = 0;
        segmentIndex += 1;
    }

    return segments;
}

export function calculateWindowedGrades(points, {
    windowMeters = 60,
    maxGradePercent = MAX_REASONABLE_GRADE_PERCENT
} = {}) {
    return points.map((point) => {
        const before = findPointNearDistance(points, point.distanceMeters - windowMeters / 2);
        const after = findPointNearDistance(points, point.distanceMeters + windowMeters / 2);

        if (
            !Number.isFinite(before?.elevationMeters)
            || !Number.isFinite(after?.elevationMeters)
            || !Number.isFinite(before?.distanceMeters)
            || !Number.isFinite(after?.distanceMeters)
            || after.distanceMeters <= before.distanceMeters
        ) {
            return {
                ...point,
                gradePercent: 0
            };
        }

        const grade = ((after.elevationMeters - before.elevationMeters) / (after.distanceMeters - before.distanceMeters)) * 100;

        return {
            ...point,
            gradePercent: round(clamp(grade, -maxGradePercent, maxGradePercent), 2)
        };
    });
}

function findPointNearDistance(points, targetDistanceMeters) {
    let best = points[0] ?? null;
    let bestDistance = best ? Math.abs(best.distanceMeters - targetDistanceMeters) : Infinity;

    for (const point of points) {
        const distance = Math.abs(point.distanceMeters - targetDistanceMeters);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }

    return best;
}

function clampGrade(gradePercent) {
    if (!Number.isFinite(gradePercent)) {
        return 0;
    }

    return Math.min(MAX_REASONABLE_GRADE_PERCENT, Math.max(-MAX_REASONABLE_GRADE_PERCENT, gradePercent));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
