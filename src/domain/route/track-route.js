const SEGMENT_BUCKET_METERS = 500;
const MAX_REASONABLE_GRADE_PERCENT = 20;
const GRADE_WINDOW_METERS = 300;
const ELEVATION_DENOISE_WINDOW_METERS = 120;

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
    windowMeters = GRADE_WINDOW_METERS,
    elevationDenoiseWindowMeters = ELEVATION_DENOISE_WINDOW_METERS,
    maxGradePercent = MAX_REASONABLE_GRADE_PERCENT
} = {}) {
    const denoisedElevations = calculateMedianElevations(points, elevationDenoiseWindowMeters);

    return points.map((point, index) => {
        const [windowStart, windowEnd] = resolveGradeWindow(points, point.distanceMeters, windowMeters);
        const samples = points
            .map((candidate, candidateIndex) => ({
                distanceMeters: candidate.distanceMeters,
                elevationMeters: denoisedElevations[candidateIndex]
            }))
            .filter((candidate) => candidate.distanceMeters >= windowStart && candidate.distanceMeters <= windowEnd)
            .filter((candidate) => Number.isFinite(candidate.distanceMeters) && Number.isFinite(candidate.elevationMeters));
        const slope = calculateLinearSlope(samples);

        if (!Number.isFinite(slope)) {
            return {
                ...point,
                gradePercent: 0
            };
        }

        return {
            ...point,
            gradePercent: round(clamp(slope * 100, -maxGradePercent, maxGradePercent), 2)
        };
    });
}

function calculateMedianElevations(points, windowMeters) {
    const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;
    if (totalDistanceMeters <= windowMeters * 2) {
        return points.map((point) => point.elevationMeters);
    }

    return points.map((point) => {
        const [windowStart, windowEnd] = resolveGradeWindow(points, point.distanceMeters, windowMeters);
        const elevations = points
            .filter((candidate) => candidate.distanceMeters >= windowStart && candidate.distanceMeters <= windowEnd)
            .map((candidate) => candidate.elevationMeters)
            .filter(Number.isFinite)
            .sort((first, second) => first - second);
        if (elevations.length === 0) return point.elevationMeters;

        const middle = Math.floor(elevations.length / 2);
        return elevations.length % 2 === 0
            ? (elevations[middle - 1] + elevations[middle]) / 2
            : elevations[middle];
    });
}

function resolveGradeWindow(points, distanceMeters, windowMeters) {
    const totalDistanceMeters = points.at(-1)?.distanceMeters ?? distanceMeters;
    const halfWindow = Math.max(1, Number(windowMeters) || GRADE_WINDOW_METERS) / 2;
    let start = distanceMeters - halfWindow;
    let end = distanceMeters + halfWindow;

    if (start < 0) {
        end = Math.min(totalDistanceMeters, end - start);
        start = 0;
    }
    if (end > totalDistanceMeters) {
        start = Math.max(0, start - (end - totalDistanceMeters));
        end = totalDistanceMeters;
    }
    return [start, end];
}

function calculateLinearSlope(samples) {
    if (samples.length < 2) return null;
    const averageDistance = samples.reduce((sum, sample) => sum + sample.distanceMeters, 0) / samples.length;
    const averageElevation = samples.reduce((sum, sample) => sum + sample.elevationMeters, 0) / samples.length;
    let covariance = 0;
    let variance = 0;

    for (const sample of samples) {
        const distanceDelta = sample.distanceMeters - averageDistance;
        covariance += distanceDelta * (sample.elevationMeters - averageElevation);
        variance += distanceDelta * distanceDelta;
    }
    return variance > 0 ? covariance / variance : null;
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
