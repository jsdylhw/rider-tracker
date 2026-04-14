import { buildRouteFromTrackPoints } from "./route-builder.js";

const SEGMENT_BUCKET_METERS = 500;
const MIN_GRADE_WINDOW_METERS = 30;
const MAX_REASONABLE_GRADE_PERCENT = 20;

export function parseGpx(xmlText) {
    const parser = new DOMParser();
    let cleanXmlText = xmlText.replace(/\s+xmlns(:\w+)?="[^"]*?"/g, "");
    cleanXmlText = cleanXmlText.replace(/\s+xsi:\w+="[^"]*?"/g, "");
    cleanXmlText = cleanXmlText.replace(/<(\/?)[\w-]+:/g, "<$1");

    const xml = parser.parseFromString(cleanXmlText, "application/xml");
    const parserError = xml.querySelector("parsererror");

    if (parserError) {
        console.error("XML parse error details:", parserError.textContent);
        throw new Error("GPX 文件解析失败，可能格式不合法");
    }

    const rawTrackPoints = [...xml.querySelectorAll("trkpt, rtept")]
        .map((node, index) => {
            const latitude = Number(node.getAttribute("lat"));
            const longitude = Number(node.getAttribute("lon"));
            const elevationMeters = parseElevation(node.querySelector("ele")?.textContent);

            return {
                latitude,
                longitude,
                elevationMeters,
                name: `轨迹点 ${index + 1}`
            };
        })
        .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));

    if (rawTrackPoints.length < 2) {
        throw new Error("GPX 文件至少需要包含两个有效轨迹点");
    }

    const name = xml.querySelector("metadata > name, trk > name, rte > name")?.textContent?.trim() || "GPX 路线";
    const { points: elevationResolvedPoints, hasElevationData } = resolveElevationData(rawTrackPoints);
    const normalizedPoints = normalizeTrackPoints(elevationResolvedPoints);
    const smoothedPoints = smoothTrackPoints(normalizedPoints, hasElevationData);
    const segments = buildSummarySegments(smoothedPoints, hasElevationData);

    return buildRouteFromTrackPoints({
        name,
        points: smoothedPoints,
        segments,
        hasElevationData
    });
}

function normalizeTrackPoints(points) {
    let cumulativeDistance = 0;

    return points.map((point, index) => {
        if (index === 0) {
            return {
                ...point,
                elevationMeters: point.elevationMeters ?? 0,
                distanceMeters: 0,
                gradePercent: 0
            };
        }

        const previousPoint = points[index - 1];
        const distanceMeters = haversineDistance(previousPoint.latitude, previousPoint.longitude, point.latitude, point.longitude);
        cumulativeDistance += distanceMeters;

        return {
            ...point,
            elevationMeters: point.elevationMeters ?? 0,
            distanceMeters: cumulativeDistance,
            gradePercent: 0
        };
    });
}

function smoothTrackPoints(points, hasElevationData) {
    if (!hasElevationData) {
        return points.map((point) => ({
            ...point,
            elevationMeters: 0,
            gradePercent: 0
        }));
    }

    const windowSize = 5;
    const smoothed = [];

    for (let i = 0; i < points.length; i += 1) {
        if (i === 0 || i === points.length - 1) {
            smoothed.push({ ...points[i] });
            continue;
        }

        let sumElevation = 0;
        let count = 0;

        for (
            let j = Math.max(0, i - Math.floor(windowSize / 2));
            j <= Math.min(points.length - 1, i + Math.floor(windowSize / 2));
            j += 1
        ) {
            sumElevation += points[j].elevationMeters;
            count += 1;
        }

        smoothed.push({
            ...points[i],
            elevationMeters: sumElevation / count
        });
    }

    return smoothed.map((point, index) => ({
        ...point,
        gradePercent: index === 0 ? 0 : calculateWindowedGrade(smoothed, index)
    }));
}

function buildSummarySegments(points, hasElevationData) {
    if (!hasElevationData) {
        const totalDistanceMeters = points.at(-1)?.distanceMeters ?? 0;

        return [{
            name: "GPX 全程",
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
        const deltaElevation = currentPoint.elevationMeters - previousPoint.elevationMeters;

        bucketDistance += deltaDistance;
        bucketElevationDelta += deltaElevation;

        const shouldFlush = bucketDistance >= SEGMENT_BUCKET_METERS || index === points.length - 1;

        if (!shouldFlush) {
            continue;
        }

        segments.push({
            name: `GPX 路段 ${segmentIndex}`,
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

function haversineDistance(lat1, lon1, lat2, lon2) {
    const earthRadiusMeters = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMeters * c;
}

function toRadians(value) {
    return value * Math.PI / 180;
}

function clampGrade(gradePercent) {
    if (!Number.isFinite(gradePercent)) {
        return 0;
    }

    return Math.min(MAX_REASONABLE_GRADE_PERCENT, Math.max(-MAX_REASONABLE_GRADE_PERCENT, gradePercent));
}

function parseElevation(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveElevationData(points) {
    const knownIndexes = points
        .map((point, index) => Number.isFinite(point.elevationMeters) ? index : -1)
        .filter((index) => index >= 0);

    if (knownIndexes.length === 0) {
        return {
            hasElevationData: false,
            points: points.map((point) => ({
                ...point,
                elevationMeters: 0
            }))
        };
    }

    if (knownIndexes.length === points.length) {
        return {
            hasElevationData: true,
            points
        };
    }

    const resolved = points.map((point) => ({ ...point }));

    for (let index = 0; index < resolved.length; index += 1) {
        if (Number.isFinite(resolved[index].elevationMeters)) {
            continue;
        }

        const previousKnownIndex = findNearestKnownIndex(knownIndexes, index, -1);
        const nextKnownIndex = findNearestKnownIndex(knownIndexes, index, 1);

        if (previousKnownIndex === null && nextKnownIndex === null) {
            resolved[index].elevationMeters = 0;
        } else if (previousKnownIndex === null) {
            resolved[index].elevationMeters = resolved[nextKnownIndex].elevationMeters;
        } else if (nextKnownIndex === null) {
            resolved[index].elevationMeters = resolved[previousKnownIndex].elevationMeters;
        } else {
            const prevPoint = resolved[previousKnownIndex];
            const nextPoint = resolved[nextKnownIndex];
            const ratio = (index - previousKnownIndex) / (nextKnownIndex - previousKnownIndex);
            resolved[index].elevationMeters = prevPoint.elevationMeters + (nextPoint.elevationMeters - prevPoint.elevationMeters) * ratio;
        }
    }

    return {
        hasElevationData: true,
        points: resolved
    };
}

function findNearestKnownIndex(knownIndexes, index, direction) {
    if (direction < 0) {
        for (let cursor = knownIndexes.length - 1; cursor >= 0; cursor -= 1) {
            if (knownIndexes[cursor] < index) {
                return knownIndexes[cursor];
            }
        }

        return null;
    }

    for (let cursor = 0; cursor < knownIndexes.length; cursor += 1) {
        if (knownIndexes[cursor] > index) {
            return knownIndexes[cursor];
        }
    }

    return null;
}

function calculateWindowedGrade(points, index) {
    const previousIndex = findPointByDistanceWindow(points, index, -1, MIN_GRADE_WINDOW_METERS);
    const nextIndex = findPointByDistanceWindow(points, index, 1, MIN_GRADE_WINDOW_METERS);
    const startIndex = previousIndex ?? index;
    const endIndex = nextIndex ?? index;

    if (startIndex === endIndex) {
        return 0;
    }

    const distanceDelta = points[endIndex].distanceMeters - points[startIndex].distanceMeters;
    const elevationDelta = points[endIndex].elevationMeters - points[startIndex].elevationMeters;

    return distanceDelta > 0 ? clampGrade((elevationDelta / distanceDelta) * 100) : 0;
}

function findPointByDistanceWindow(points, index, direction, targetDistance) {
    const originDistance = points[index].distanceMeters;

    for (let cursor = index + direction; cursor >= 0 && cursor < points.length; cursor += direction) {
        if (Math.abs(points[cursor].distanceMeters - originDistance) >= targetDistance) {
            return cursor;
        }
    }

    return null;
}
