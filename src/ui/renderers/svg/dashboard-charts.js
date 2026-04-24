export function buildTrajectoryOverviewSvg(route, currentRecord) {
    const points = (route?.points ?? []).filter((point) => typeof point.latitude === "number" && typeof point.longitude === "number");
    if (points.length < 2) {
        return buildCenteredMessageSvg({
            width: 300,
            height: 180,
            message: "暂无轨迹数据",
            fontSize: 12
        });
    }

    const width = 300;
    const height = 180;
    const overviewPadding = 16;
    const detail = { x: 22, y: 84, width: width - 44, height: 72 };
    const lats = points.map((point) => point.latitude);
    const lngs = points.map((point) => point.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latRange = Math.max(maxLat - minLat, 1e-9);
    const lngRange = Math.max(maxLng - minLng, 1e-9);
    const totalDistanceMeters = Math.max(route?.totalDistanceMeters ?? points.at(-1)?.distanceMeters ?? 0, 1);
    const currentDistanceMeters = clamp(
        typeof currentRecord?.distanceKm === "number" ? currentRecord.distanceKm * 1000 : 0,
        0,
        totalDistanceMeters
    );
    const currentPointByDistance = getRoutePointAtDistance(points, currentDistanceMeters);
    const currentLat = typeof currentRecord?.positionLat === "number" ? currentRecord.positionLat : currentPointByDistance.latitude;
    const currentLng = typeof currentRecord?.positionLong === "number" ? currentRecord.positionLong : currentPointByDistance.longitude;
    const localWindowSpan = Math.min(totalDistanceMeters, Math.max(1200, Math.min(totalDistanceMeters * 0.15, 5000)));
    const localWindowStart = clamp(currentDistanceMeters - localWindowSpan / 2, 0, Math.max(totalDistanceMeters - localWindowSpan, 0));
    const localWindowEnd = Math.min(localWindowStart + localWindowSpan, totalDistanceMeters);
    const localPoints = getRoutePointsWithinDistanceRange(points, localWindowStart, localWindowEnd);
    const localLats = localPoints.map((point) => point.latitude);
    const localLngs = localPoints.map((point) => point.longitude);
    const localMinLat = Math.min(...localLats);
    const localMaxLat = Math.max(...localLats);
    const localMinLng = Math.min(...localLngs);
    const localMaxLng = Math.max(...localLngs);
    const localLatRange = Math.max(localMaxLat - localMinLat, 1e-9);
    const localLngRange = Math.max(localMaxLng - localMinLng, 1e-9);

    const toOverviewX = (lng) => overviewPadding + ((lng - minLng) / lngRange) * (width - overviewPadding * 2);
    const toOverviewY = (lat) => 68 - ((lat - minLat) / latRange) * (68 - 18);
    const toDetailX = (lng) => detail.x + ((lng - localMinLng) / localLngRange) * detail.width;
    const toDetailY = (lat) => detail.y + detail.height - ((lat - localMinLat) / localLatRange) * detail.height;

    const polyline = points.map((point) => `${toOverviewX(point.longitude).toFixed(1)},${toOverviewY(point.latitude).toFixed(1)}`).join(" ");
    const detailPolyline = localPoints.map((point) => `${toDetailX(point.longitude).toFixed(1)},${toDetailY(point.latitude).toFixed(1)}`).join(" ");
    const start = points[0];
    const end = points.at(-1);
    const localWindowRect = buildOverviewWindowRect({
        points,
        windowStart: localWindowStart,
        windowEnd: localWindowEnd,
        toX: toOverviewX,
        toY: toOverviewY
    });
    const currentDetailX = toDetailX(currentLng);
    const currentDetailY = toDetailY(currentLat);
    const currentPillX = clamp(currentDetailX - 40, detail.x + 4, detail.x + detail.width - 84);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a" rx="12"></rect>
        <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(56, 189, 248, 0.04)" rx="12"></rect>
        <text x="${overviewPadding}" y="14" fill="#cbd5e1" font-size="10.5" font-weight="700">全程路线</text>
        <polyline points="${polyline}" fill="none" stroke="rgba(56, 189, 248, 0.45)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${localWindowRect}
        <circle cx="${toOverviewX(start.longitude).toFixed(1)}" cy="${toOverviewY(start.latitude).toFixed(1)}" r="3.8" fill="#22c55e"></circle>
        <circle cx="${toOverviewX(end.longitude).toFixed(1)}" cy="${toOverviewY(end.latitude).toFixed(1)}" r="3.8" fill="#ef4444"></circle>
        <circle cx="${toOverviewX(currentLng).toFixed(1)}" cy="${toOverviewY(currentLat).toFixed(1)}" r="4.8" fill="#f8fafc" stroke="#38bdf8" stroke-width="2"></circle>
        <text x="${overviewPadding}" y="78" fill="#94a3b8" font-size="10.5">起点</text>
        <text x="${width - overviewPadding}" y="78" text-anchor="end" fill="#94a3b8" font-size="10.5">${formatDistanceLabel(totalDistanceMeters)}</text>

        <text x="${detail.x}" y="${detail.y - 8}" fill="#f8fafc" font-size="11" font-weight="700">当前位置局部放大</text>
        <text x="${detail.x + detail.width}" y="${detail.y - 8}" text-anchor="end" fill="#94a3b8" font-size="10">${formatDistanceLabel(localWindowStart)} - ${formatDistanceLabel(localWindowEnd)}</text>
        <rect x="${detail.x}" y="${detail.y}" width="${detail.width}" height="${detail.height}" rx="12" fill="rgba(15, 23, 42, 0.5)" stroke="rgba(148, 163, 184, 0.18)" stroke-width="1"></rect>
        <polyline points="${detailPolyline}" fill="none" stroke="rgba(248, 250, 252, 0.3)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <polyline points="${detailPolyline}" fill="none" stroke="#67e8f9" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <circle cx="${toDetailX(localPoints[0].longitude).toFixed(1)}" cy="${toDetailY(localPoints[0].latitude).toFixed(1)}" r="3.4" fill="#22c55e"></circle>
        <circle cx="${toDetailX(localPoints.at(-1).longitude).toFixed(1)}" cy="${toDetailY(localPoints.at(-1).latitude).toFixed(1)}" r="3.4" fill="#f59e0b"></circle>
        <circle cx="${currentDetailX.toFixed(1)}" cy="${currentDetailY.toFixed(1)}" r="7" fill="rgba(56, 189, 248, 0.16)"></circle>
        <circle cx="${currentDetailX.toFixed(1)}" cy="${currentDetailY.toFixed(1)}" r="4.8" fill="#f8fafc" stroke="#38bdf8" stroke-width="2"></circle>
        <rect x="${currentPillX.toFixed(1)}" y="${(detail.y + 6).toFixed(1)}" width="80" height="22" rx="11" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(148, 163, 184, 0.35)" stroke-width="1"></rect>
        <text x="${(currentPillX + 40).toFixed(1)}" y="${(detail.y + 20).toFixed(1)}" text-anchor="middle" fill="#f8fafc" font-size="10.5" font-weight="700">${formatDistanceLabel(currentDistanceMeters)}</text>
    `;
}

export function buildWorkoutTargetChartSvg({ records, runtime, customWorkoutTarget, ftp }) {
    if (!customWorkoutTarget?.steps?.length) {
        return buildCenteredMessageSvg({
            width: 640,
            height: 220,
            message: "启用自定义训练目标后，这里会实时显示输入功率与目标功率对比"
        });
    }

    const width = 640;
    const height = 220;
    const padding = 36;
    const totalPlanSeconds = Math.max(runtime.customWorkoutTargetTotalSeconds ?? 0, 1);
    const maxElapsedSeconds = Math.max(records.at(-1)?.elapsedSeconds ?? 0, totalPlanSeconds);
    const actualPowerMax = Math.max(...records.map((record) => record.power ?? 0), 0);
    const targetPowerMax = Math.max(
        ...customWorkoutTarget.steps.flatMap((step) => [
            Math.round((ftp ?? 0) * ((step.ftpPercent ?? 0) / 100)),
            Math.round((ftp ?? 0) * (((step.endFtpPercent ?? step.ftpPercent) ?? 0) / 100))
        ]),
        0
    );
    const maxPower = Math.max(100, actualPowerMax, targetPowerMax);
    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;
    const toX = (seconds) => padding + (seconds / maxElapsedSeconds) * innerWidth;
    const toY = (power) => height - padding - (power / maxPower) * innerHeight;

    const actualPolyline = records.length > 0
        ? records.map((record) => `${toX(record.elapsedSeconds).toFixed(1)},${toY(record.power ?? 0).toFixed(1)}`).join(" ")
        : "";

    let cumulativeSeconds = 0;
    const firstStepStartPower = Math.round((ftp ?? 0) * ((customWorkoutTarget.steps[0].ftpPercent ?? 0) / 100));
    const targetPoints = [`${toX(0).toFixed(1)},${toY(firstStepStartPower).toFixed(1)}`];
    customWorkoutTarget.steps.forEach((step) => {
        const startPower = Math.round((ftp ?? 0) * ((step.ftpPercent ?? 0) / 100));
        const endPower = Math.round((ftp ?? 0) * (((step.endFtpPercent ?? step.ftpPercent) ?? 0) / 100));
        targetPoints.push(`${toX(cumulativeSeconds).toFixed(1)},${toY(startPower).toFixed(1)}`);
        cumulativeSeconds += Math.round(step.durationMinutes * 60);
        targetPoints.push(`${toX(cumulativeSeconds).toFixed(1)},${toY(endPower).toFixed(1)}`);
    });

    const currentElapsedSeconds = records.at(-1)?.elapsedSeconds ?? 0;
    const currentX = toX(Math.min(currentElapsedSeconds, maxElapsedSeconds)).toFixed(1);

    return `
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#334155" stroke-width="1"></line>
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#334155" stroke-width="1"></line>
        <text x="${padding}" y="${height - 10}" fill="#64748b" font-size="12">0</text>
        <text x="${width - padding}" y="${height - 10}" text-anchor="end" fill="#64748b" font-size="12">${formatAxisTime(maxElapsedSeconds)}</text>
        <text x="${padding - 8}" y="${padding + 4}" text-anchor="end" fill="#64748b" font-size="12">${Math.round(maxPower)}W</text>
        <text x="${padding - 8}" y="${height - padding}" text-anchor="end" fill="#64748b" font-size="12">0W</text>
        <polyline points="${targetPoints.join(" ")}" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="6 4" stroke-linejoin="round"></polyline>
        ${actualPolyline ? `<polyline points="${actualPolyline}" fill="none" stroke="#38bdf8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"></polyline>` : ""}
        <line x1="${currentX}" y1="${padding}" x2="${currentX}" y2="${height - padding}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 4"></line>
        <text x="${padding}" y="${padding - 10}" fill="#38bdf8" font-size="12">实际功率</text>
        <text x="${padding + 78}" y="${padding - 10}" fill="#f59e0b" font-size="12">目标功率</text>
    `;
}

function buildCenteredMessageSvg({ width, height, message, fontSize = 14 }) {
    return `
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="${fontSize}">
            ${message}
        </text>
    `;
}

function formatAxisTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function getRoutePointsWithinDistanceRange(points, startDistanceMeters, endDistanceMeters) {
    const rangePoints = points.filter((point) => point.distanceMeters >= startDistanceMeters && point.distanceMeters <= endDistanceMeters);
    const startPoint = getRoutePointAtDistance(points, startDistanceMeters);
    const endPoint = getRoutePointAtDistance(points, endDistanceMeters);
    return dedupeRoutePoints([startPoint, ...rangePoints, endPoint]);
}

function getRoutePointAtDistance(points, distanceMeters) {
    if (!points.length) {
        return {
            distanceMeters,
            latitude: 0,
            longitude: 0
        };
    }

    const maxDistance = points.at(-1)?.distanceMeters ?? distanceMeters;
    const boundedDistance = clamp(distanceMeters, 0, maxDistance);
    const nextPoint = points.find((point) => point.distanceMeters >= boundedDistance) ?? points.at(-1);
    const previousPoint = [...points].reverse().find((point) => point.distanceMeters <= boundedDistance) ?? points[0];

    if (!nextPoint || !previousPoint || nextPoint.distanceMeters === previousPoint.distanceMeters) {
        return {
            ...nextPoint,
            distanceMeters: boundedDistance
        };
    }

    const ratio = (boundedDistance - previousPoint.distanceMeters) / (nextPoint.distanceMeters - previousPoint.distanceMeters);
    return {
        distanceMeters: boundedDistance,
        latitude: interpolate(previousPoint.latitude, nextPoint.latitude, ratio),
        longitude: interpolate(previousPoint.longitude, nextPoint.longitude, ratio)
    };
}

function buildOverviewWindowRect({ points, windowStart, windowEnd, toX, toY }) {
    const windowPoints = getRoutePointsWithinDistanceRange(points, windowStart, windowEnd);
    const xs = windowPoints.map((point) => toX(point.longitude));
    const ys = windowPoints.map((point) => toY(point.latitude));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return `
        <rect x="${Math.max(minX - 6, 8).toFixed(1)}" y="${Math.max(minY - 6, 16).toFixed(1)}" width="${Math.max(maxX - minX + 12, 10).toFixed(1)}" height="${Math.max(maxY - minY + 12, 10).toFixed(1)}" rx="10" fill="rgba(248, 250, 252, 0.08)" stroke="rgba(226, 232, 240, 0.3)" stroke-width="1"></rect>
    `;
}

function dedupeRoutePoints(points) {
    return points.filter((point, index) => {
        const previousPoint = points[index - 1];
        return !previousPoint || Math.abs(previousPoint.distanceMeters - point.distanceMeters) > 0.1;
    });
}

function interpolate(start, end, ratio) {
    return start + (end - start) * ratio;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function formatDistanceLabel(distanceMeters) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
}
