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
    const padding = 14;
    const lats = points.map((point) => point.latitude);
    const lngs = points.map((point) => point.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latRange = Math.max(maxLat - minLat, 1e-9);
    const lngRange = Math.max(maxLng - minLng, 1e-9);

    const toX = (lng) => padding + ((lng - minLng) / lngRange) * (width - padding * 2);
    const toY = (lat) => height - padding - ((lat - minLat) / latRange) * (height - padding * 2);

    const polyline = points.map((point) => `${toX(point.longitude).toFixed(1)},${toY(point.latitude).toFixed(1)}`).join(" ");
    const start = points[0];
    const end = points.at(-1);
    const currentLat = typeof currentRecord?.positionLat === "number" ? currentRecord.positionLat : end.latitude;
    const currentLng = typeof currentRecord?.positionLong === "number" ? currentRecord.positionLong : end.longitude;

    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a" rx="10"></rect>
        <polyline points="${polyline}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <circle cx="${toX(start.longitude).toFixed(1)}" cy="${toY(start.latitude).toFixed(1)}" r="4.2" fill="#22c55e"></circle>
        <circle cx="${toX(end.longitude).toFixed(1)}" cy="${toY(end.latitude).toFixed(1)}" r="4.2" fill="#ef4444"></circle>
        <circle cx="${toX(currentLng).toFixed(1)}" cy="${toY(currentLat).toFixed(1)}" r="5.3" fill="#f8fafc" stroke="#2563eb" stroke-width="2.2"></circle>
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
