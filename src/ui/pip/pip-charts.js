import { formatDuration, formatNumber } from "../../shared/format.js";
import { buildPipElevationChartSvg } from "./pip-elevation-chart.js";

const SERIES_WIDTH = 320;
const SERIES_HEIGHT = 88;
const SERIES_PADDING = {
    top: 14,
    right: 24,
    bottom: 18,
    left: 24
};

const POWER_ZONE_COLORS = ["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444", "#a855f7"];

export function buildPipChartsHtml({ chartKeys = [], route, currentRecord, records = [], ftp = null } = {}) {
    const html = chartKeys.map((key) => {
        if (key === "elevation") {
            return buildChartCard("坡度图", buildPipElevationChartSvg(route, currentRecord));
        }
        if (key === "powerHeartRate") {
            return buildChartCard("功率 / 心率", buildDualSeriesChartSvg(records, {
                left: { field: "heartRate", label: "bpm", color: "#fb7185" },
                right: { field: "power", label: "W", color: "#22c55e" }
            }));
        }
        if (key === "speedCadence") {
            return buildChartCard("速度 / 踏频", buildDualSeriesChartSvg(records, {
                left: { field: "speedKph", label: "km/h", color: "#38bdf8" },
                right: { field: "cadence", label: "rpm", color: "#fbbf24" }
            }));
        }
        if (key === "powerZone") {
            return buildChartCard("功率区间", buildPowerZoneChartSvg(records, ftp));
        }

        return "";
    }).join("");

    return html || `<p class="pip-empty">请在 PiP 显示中选择图表。</p>`;
}

function buildChartCard(title, svgContent) {
    return `
        <div class="pip-chart-card">
            <div class="pip-chart-title">${title}</div>
            <svg class="pip-chart-svg" viewBox="0 0 ${SERIES_WIDTH} ${SERIES_HEIGHT}" preserveAspectRatio="none">${svgContent}</svg>
        </div>
    `;
}

export function buildDualSeriesChartSvg(records, { left, right }) {
    const leftPoints = buildSeriesPoints(records, left.field);
    const rightPoints = buildSeriesPoints(records, right.field);
    const allTimes = [...leftPoints, ...rightPoints].map((point) => point.x);

    if (allTimes.length < 2 || (leftPoints.length < 2 && rightPoints.length < 2)) {
        return buildEmptyChartSvg("等待曲线数据");
    }

    const maxX = Math.max(...allTimes, 1);
    const leftScale = buildScale(leftPoints);
    const rightScale = buildScale(rightPoints);
    const leftPath = buildPolyline(leftPoints, { maxX, scale: leftScale });
    const rightPath = buildPolyline(rightPoints, { maxX, scale: rightScale });

    return `
        ${buildChartFrame({ maxX, leftLabel: left.label, rightLabel: right.label, leftScale, rightScale })}
        ${leftPath ? `<polyline points="${leftPath}" fill="none" stroke="${left.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ""}
        ${rightPath ? `<polyline points="${rightPath}" fill="none" stroke="${right.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ""}
        <circle cx="16" cy="9" r="3" fill="${left.color}" />
        <text x="22" y="12" fill="#cbd5e1" font-size="8">${left.label}</text>
        <circle cx="74" cy="9" r="3" fill="${right.color}" />
        <text x="80" y="12" fill="#cbd5e1" font-size="8">${right.label}</text>
    `;
}

export function buildPowerZoneChartSvg(records, ftp) {
    if (!Number.isFinite(ftp) || ftp <= 0) {
        return buildEmptyChartSvg("缺少 FTP");
    }

    const zones = Array.from({ length: 6 }, () => 0);
    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        const elapsed = Number(current?.elapsedSeconds);
        const previousElapsed = Number(previous?.elapsedSeconds);
        const power = Number(current?.power);
        if (!Number.isFinite(elapsed) || !Number.isFinite(previousElapsed) || elapsed <= previousElapsed || !Number.isFinite(power)) {
            continue;
        }
        zones[getPowerZoneIndex(power, ftp)] += elapsed - previousElapsed;
    }

    const totalSeconds = zones.reduce((sum, seconds) => sum + seconds, 0);
    if (totalSeconds <= 0) {
        return buildEmptyChartSvg("等待功率区间");
    }

    let x = SERIES_PADDING.left;
    const y = 34;
    const width = SERIES_WIDTH - SERIES_PADDING.left - SERIES_PADDING.right;
    const segments = zones.map((seconds, index) => {
        const segmentWidth = (seconds / totalSeconds) * width;
        const rect = `<rect x="${formatNumber(x, 2)}" y="${y}" width="${formatNumber(segmentWidth, 2)}" height="18" fill="${POWER_ZONE_COLORS[index]}" />`;
        x += segmentWidth;
        return rect;
    }).join("");
    const labels = zones.map((seconds, index) => {
        const percent = Math.round((seconds / totalSeconds) * 100);
        return `<text x="${SERIES_PADDING.left + index * 48}" y="72" fill="#cbd5e1" font-size="8">Z${index + 1} ${percent}%</text>`;
    }).join("");

    return `
        <rect x="${SERIES_PADDING.left}" y="${y}" width="${width}" height="18" fill="#1f2937" rx="4" />
        ${segments}
        ${labels}
        <text x="${SERIES_PADDING.left}" y="18" fill="#94a3b8" font-size="9">${formatDuration(totalSeconds)}</text>
    `;
}

function buildSeriesPoints(records, field) {
    return records
        .map((record) => ({
            x: numberOrNull(record?.elapsedSeconds),
            y: numberOrNull(record?.[field])
        }))
        .filter((point) => point.x !== null && point.y !== null);
}

function buildScale(points) {
    if (points.length === 0) {
        return { min: 0, max: 1 };
    }

    const max = Math.max(...points.map((point) => point.y), 1);
    const min = Math.min(0, ...points.map((point) => point.y));
    return { min, max: Math.max(max, min + 1) };
}

function buildPolyline(points, { maxX, scale }) {
    if (points.length < 2) {
        return "";
    }

    return points.map((point) => {
        const x = SERIES_PADDING.left + (point.x / maxX) * (SERIES_WIDTH - SERIES_PADDING.left - SERIES_PADDING.right);
        const y = toY(point.y, scale);
        return `${formatNumber(x, 2)},${formatNumber(y, 2)}`;
    }).join(" ");
}

function buildChartFrame({ maxX, leftLabel, rightLabel, leftScale, rightScale }) {
    const bottomY = SERIES_HEIGHT - SERIES_PADDING.bottom;
    return `
        <line x1="${SERIES_PADDING.left}" y1="${bottomY}" x2="${SERIES_WIDTH - SERIES_PADDING.right}" y2="${bottomY}" stroke="#334155" stroke-width="1" />
        <text x="${SERIES_PADDING.left}" y="${SERIES_HEIGHT - 5}" fill="#94a3b8" font-size="8">0:00</text>
        <text x="${SERIES_WIDTH - SERIES_PADDING.right}" y="${SERIES_HEIGHT - 5}" fill="#94a3b8" font-size="8" text-anchor="end">${formatDuration(maxX)}</text>
        <text x="${SERIES_PADDING.left - 4}" y="${SERIES_PADDING.top + 4}" fill="#94a3b8" font-size="8" text-anchor="end">${formatNumber(leftScale.max, 0)}</text>
        <text x="${SERIES_WIDTH - SERIES_PADDING.right + 4}" y="${SERIES_PADDING.top + 4}" fill="#94a3b8" font-size="8">${formatNumber(rightScale.max, 0)}</text>
        <text x="${SERIES_PADDING.left - 4}" y="${bottomY}" fill="#94a3b8" font-size="8" text-anchor="end">${leftLabel}</text>
        <text x="${SERIES_WIDTH - SERIES_PADDING.right + 4}" y="${bottomY}" fill="#94a3b8" font-size="8">${rightLabel}</text>
    `;
}

function toY(value, scale) {
    const height = SERIES_HEIGHT - SERIES_PADDING.top - SERIES_PADDING.bottom;
    const ratio = (value - scale.min) / Math.max(scale.max - scale.min, 1);
    return SERIES_HEIGHT - SERIES_PADDING.bottom - ratio * height;
}

function getPowerZoneIndex(power, ftp) {
    const ratio = power / ftp;
    if (ratio < 0.55) return 0;
    if (ratio < 0.75) return 1;
    if (ratio < 0.9) return 2;
    if (ratio < 1.05) return 3;
    if (ratio < 1.2) return 4;
    return 5;
}

function buildEmptyChartSvg(message) {
    return `
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="10">
            ${message}
        </text>
    `;
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}
