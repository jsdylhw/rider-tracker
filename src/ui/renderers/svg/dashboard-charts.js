import { buildRouteMapSvg } from "./route-map-chart.js";

export function buildTrajectoryOverviewSvg(route, currentRecord, options = {}) {
    const { width = 300, height = 180, title = "路线平面图", theme = "default" } = options;
    return buildRouteMapSvg({
        route,
        currentRecord,
        width,
        height,
        title,
        theme
    });
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

export function buildErgPowerChartSvg({ records, targetPowerWatts, ftp, progressPercent = 0 }) {
    const width = 640;
    const height = 160;
    const padding = { left: 42, right: 18, top: 18, bottom: 28 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const safeRecords = records.filter((record) => Number.isFinite(record?.elapsedSeconds));
    const targetPower = Number.isFinite(targetPowerWatts) ? targetPowerWatts : 0;
    const maxElapsedSeconds = Math.max(safeRecords.at(-1)?.elapsedSeconds ?? 0, 60);
    const maxActualPower = Math.max(...safeRecords.map((record) => record.power ?? 0), 0);
    const maxPower = Math.max(100, targetPower * 1.25, maxActualPower * 1.1);
    const currentElapsedSeconds = Math.min(safeRecords.at(-1)?.elapsedSeconds ?? 0, maxElapsedSeconds);
    const currentX = toX(currentElapsedSeconds);

    function toX(seconds) {
        return padding.left + (seconds / maxElapsedSeconds) * innerWidth;
    }

    function toY(power) {
        return height - padding.bottom - (Math.max(0, power) / maxPower) * innerHeight;
    }

    const targetY = toY(targetPower);
    const segments = safeRecords.slice(1).map((record, index) => {
        const previous = safeRecords[index];
        return `
            <line x1="${toX(previous.elapsedSeconds).toFixed(1)}" y1="${toY(previous.power ?? 0).toFixed(1)}" x2="${toX(record.elapsedSeconds).toFixed(1)}" y2="${toY(record.power ?? 0).toFixed(1)}" stroke="${getPowerZoneColor(record.power ?? 0, ftp)}" stroke-width="3" stroke-linecap="round"></line>
        `;
    }).join("");
    const progressRadius = 22;
    const progressCircumference = 2 * Math.PI * progressRadius;
    const progressOffset = progressCircumference * (1 - Math.max(0, Math.min(progressPercent, 100)) / 100);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="rgba(15, 23, 42, 0.82)"></rect>
        <g transform="translate(34 58)">
            <circle cx="0" cy="0" r="${progressRadius}" fill="rgba(31, 41, 55, 0.8)" stroke="rgba(148, 163, 184, 0.25)" stroke-width="5"></circle>
            <circle cx="0" cy="0" r="${progressRadius}" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round" stroke-dasharray="${progressCircumference.toFixed(1)}" stroke-dashoffset="${progressOffset.toFixed(1)}" transform="rotate(-90)"></circle>
            <text x="0" y="4" text-anchor="middle" fill="#f8fafc" font-size="12" font-weight="800">${Math.round(progressPercent)}%</text>
        </g>
        <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="rgba(148, 163, 184, 0.28)" stroke-width="1"></line>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="rgba(148, 163, 184, 0.28)" stroke-width="1"></line>
        <line x1="${padding.left}" y1="${targetY.toFixed(1)}" x2="${width - padding.right}" y2="${targetY.toFixed(1)}" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="7 5"></line>
        ${segments || `<text x="${padding.left + innerWidth / 2}" y="${padding.top + innerHeight / 2}" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">等待实时功率数据</text>`}
        <line x1="${currentX.toFixed(1)}" y1="${padding.top}" x2="${currentX.toFixed(1)}" y2="${height - padding.bottom}" stroke="rgba(248, 250, 252, 0.7)" stroke-width="1.2" stroke-dasharray="4 4"></line>
        <text x="${padding.left}" y="14" fill="#f8fafc" font-size="12" font-weight="700">实时功率</text>
        <text x="${padding.left + 64}" y="14" fill="#f59e0b" font-size="12" font-weight="700">ERG ${Math.round(targetPower)}W</text>
        <text x="${padding.left - 8}" y="${targetY.toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#f59e0b" font-size="10">${Math.round(targetPower)}W</text>
    `;
}

function buildCenteredMessageSvg({ width, height, message, fontSize = 14 }) {
    return `
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="${fontSize}">
            ${message}
        </text>
    `;
}

function getPowerZoneColor(power, ftp) {
    const safeFtp = Math.max(Number(ftp) || 0, 1);
    const ratio = power / safeFtp;
    if (ratio <= 0.55) return "#94a3b8";
    if (ratio <= 0.75) return "#3b82f6";
    if (ratio <= 0.9) return "#22c55e";
    if (ratio <= 1.05) return "#facc15";
    if (ratio <= 1.2) return "#f97316";
    if (ratio <= 1.5) return "#ef4444";
    return "#a855f7";
}

function formatAxisTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}
