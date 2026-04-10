import { buildRouteFromTrackPoints } from "./route-builder.js";

const SEGMENT_BUCKET_METERS = 500;

export function parseGpx(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, "application/xml");
    const parserError = xml.querySelector("parsererror");

    if (parserError) {
        throw new Error("GPX 文件解析失败");
    }

    const trackPoints = [...xml.querySelectorAll("trkpt, rtept")].map((node, index) => {
        const latitude = Number(node.getAttribute("lat"));
        const longitude = Number(node.getAttribute("lon"));
        const elevationNode = node.querySelector("ele");
        const elevationMeters = elevationNode ? Number(elevationNode.textContent) : 0;

        return {
            latitude,
            longitude,
            elevationMeters: Number.isFinite(elevationMeters) ? elevationMeters : 0,
            name: `轨迹点 ${index + 1}`
        };
    }).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));

    if (trackPoints.length < 2) {
        throw new Error("GPX 文件至少需要包含两个有效轨迹点");
    }

    const name = xml.querySelector("metadata > name, trk > name, rte > name")?.textContent?.trim() || "GPX 路线";
    const normalizedPoints = normalizeTrackPoints(trackPoints);
    const segments = buildSummarySegments(normalizedPoints);

    return buildRouteFromTrackPoints({
        name,
        points: normalizedPoints,
        segments
    });
}

function normalizeTrackPoints(points) {
    let cumulativeDistance = 0;

    return points.map((point, index) => {
        if (index === 0) {
            return {
                ...point,
                distanceMeters: 0,
                gradePercent: 0
            };
        }

        const previousPoint = points[index - 1];
        const distanceMeters = haversineDistance(previousPoint.latitude, previousPoint.longitude, point.latitude, point.longitude);
        cumulativeDistance += distanceMeters;
        const elevationDelta = point.elevationMeters - previousPoint.elevationMeters;
        const gradePercent = distanceMeters > 0 ? (elevationDelta / distanceMeters) * 100 : 0;

        return {
            ...point,
            distanceMeters: cumulativeDistance,
            gradePercent: clampGrade(gradePercent)
        };
    });
}

function buildSummarySegments(points) {
    const segments = [];
    let bucketStart = points[0];
    let bucketGradeTotal = 0;
    let bucketDistance = 0;
    let segmentIndex = 1;

    for (let index = 1; index < points.length; index += 1) {
        const currentPoint = points[index];
        const previousPoint = points[index - 1];
        const deltaDistance = currentPoint.distanceMeters - previousPoint.distanceMeters;
        const deltaElevation = currentPoint.elevationMeters - previousPoint.elevationMeters;

        bucketDistance += deltaDistance;
        bucketGradeTotal += deltaElevation;

        const shouldFlush = bucketDistance >= SEGMENT_BUCKET_METERS || index === points.length - 1;

        if (!shouldFlush) {
            continue;
        }

        const gradePercent = bucketDistance > 0 ? clampGrade((bucketGradeTotal / bucketDistance) * 100) : 0;

        segments.push({
            name: `GPX 路段 ${segmentIndex}`,
            distanceMeters: bucketDistance,
            gradePercent,
            elevationDelta: bucketGradeTotal,
            startDistanceMeters: bucketStart.distanceMeters,
            endDistanceMeters: currentPoint.distanceMeters
        });

        bucketStart = currentPoint;
        bucketDistance = 0;
        bucketGradeTotal = 0;
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
    return Math.min(25, Math.max(-25, gradePercent));
}
