import { buildRouteFromTrackPoints } from "./route-builder.js";

const SEGMENT_BUCKET_METERS = 500;

export function parseGpx(xmlText) {
    const parser = new DOMParser();
    // 更彻底的 XML 清理：
    // 1. 移除所有命名空间声明，避免 querySelectorAll 匹配失败
    // 2. 移除所有 xsi:xxx 属性
    // 3. 移除所有命名空间前缀（例如将 <gpxtpx:TrackPointExtension> 变成 <TrackPointExtension>）
    let cleanXmlText = xmlText.replace(/\s+xmlns(:\w+)?="[^"]*?"/g, "");
    cleanXmlText = cleanXmlText.replace(/\s+xsi:\w+="[^"]*?"/g, "");
    cleanXmlText = cleanXmlText.replace(/<(\/?)[\w-]+:/g, "<$1");
    
    const xml = parser.parseFromString(cleanXmlText, "application/xml");
    
    // Some browsers like Chrome don't always create <parsererror> as a direct child, so we query anywhere
    const parserError = xml.querySelector("parsererror");

    if (parserError) {
        console.error("XML parse error details:", parserError.textContent);
        throw new Error("GPX 文件解析失败，可能格式不合法");
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
    const smoothedPoints = smoothTrackPoints(normalizedPoints);
    
    // 我们不再需要将 GPX 强制切分成多个 500m 的 segment。
    // 为了兼容旧系统接口，我们将整个 GPX 视为一个单一的 Segment。
    const totalDistance = smoothedPoints.at(-1).distanceMeters;
    const elevationDelta = smoothedPoints.at(-1).elevationMeters - smoothedPoints[0].elevationMeters;
    
    const segments = [{
        name: "GPX 全程",
        distanceMeters: totalDistance,
        gradePercent: totalDistance > 0 ? clampGrade((elevationDelta / totalDistance) * 100) : 0,
        elevationDelta: elevationDelta,
        startDistanceMeters: 0,
        endDistanceMeters: totalDistance
    }];

    return buildRouteFromTrackPoints({
        name,
        points: smoothedPoints,
        segments
    });
}

function smoothTrackPoints(points) {
    // 采用移动窗口平均来平滑海拔和坡度，避免 GPX 噪点导致坡度剧烈跳动
    const windowSize = 5; // 前后各 2 个点
    const smoothed = [];

    for (let i = 0; i < points.length; i++) {
        let sumElevation = 0;
        let count = 0;
        
        for (let j = Math.max(0, i - Math.floor(windowSize / 2)); j <= Math.min(points.length - 1, i + Math.floor(windowSize / 2)); j++) {
            sumElevation += points[j].elevationMeters;
            count++;
        }
        
        smoothed.push({
            ...points[i],
            elevationMeters: sumElevation / count
        });
    }

    // 重新计算平滑后的坡度
    return smoothed.map((point, index) => {
        if (index === 0) {
            return { ...point, gradePercent: 0 };
        }
        
        const previousPoint = smoothed[index - 1];
        const distanceDelta = point.distanceMeters - previousPoint.distanceMeters;
        const elevationDelta = point.elevationMeters - previousPoint.elevationMeters;
        
        // 为避免极小距离导致坡度异常，我们往前找一个距离差大于 10 米的点来计算坡度
        let calcPrevIndex = index - 1;
        let distDiff = distanceDelta;
        while (distDiff < 10 && calcPrevIndex > 0) {
            calcPrevIndex--;
            distDiff = point.distanceMeters - smoothed[calcPrevIndex].distanceMeters;
        }
        
        const calcEleDelta = point.elevationMeters - smoothed[calcPrevIndex].elevationMeters;
        const gradePercent = distDiff > 0 ? (calcEleDelta / distDiff) * 100 : 0;

        return {
            ...point,
            gradePercent: clampGrade(gradePercent)
        };
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
