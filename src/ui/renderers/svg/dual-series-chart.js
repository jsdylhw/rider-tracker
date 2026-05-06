import { formatDuration, formatNumber } from "../../../shared/format.js";

export const DEFAULT_DUAL_SERIES_CHART_SIZE = {
    width: 320,
    height: 88,
    padding: {
        top: 14,
        right: 24,
        bottom: 18,
        left: 24
    }
};

export function buildDualSeriesChartSvg(records, {
    left,
    right,
    width = DEFAULT_DUAL_SERIES_CHART_SIZE.width,
    height = DEFAULT_DUAL_SERIES_CHART_SIZE.height,
    padding = DEFAULT_DUAL_SERIES_CHART_SIZE.padding,
    emptyMessage = "等待曲线数据"
} = {}) {
    const leftPoints = buildSeriesPoints(records, left?.field);
    const rightPoints = buildSeriesPoints(records, right?.field);
    const allTimes = [...leftPoints, ...rightPoints].map((point) => point.x);

    if (allTimes.length < 2 || (leftPoints.length < 2 && rightPoints.length < 2)) {
        return buildEmptyChartSvg(emptyMessage);
    }

    const maxX = Math.max(...allTimes, 1);
    const leftScale = buildScale(leftPoints);
    const rightScale = buildScale(rightPoints);
    const leftPath = buildPolyline(leftPoints, { maxX, scale: leftScale, width, height, padding });
    const rightPath = buildPolyline(rightPoints, { maxX, scale: rightScale, width, height, padding });

    return `
        ${buildChartFrame({ maxX, leftLabel: left.label, rightLabel: right.label, leftScale, rightScale, width, height, padding })}
        ${leftPath ? `<polyline points="${leftPath}" fill="none" stroke="${left.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ""}
        ${rightPath ? `<polyline points="${rightPath}" fill="none" stroke="${right.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ""}
        <circle cx="16" cy="9" r="3" fill="${left.color}" />
        <text x="22" y="12" fill="#cbd5e1" font-size="8">${left.label}</text>
        <circle cx="74" cy="9" r="3" fill="${right.color}" />
        <text x="80" y="12" fill="#cbd5e1" font-size="8">${right.label}</text>
    `;
}

function buildSeriesPoints(records, field) {
    if (!field) {
        return [];
    }

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

function buildPolyline(points, { maxX, scale, width, height, padding }) {
    if (points.length < 2) {
        return "";
    }

    return points.map((point) => {
        const x = padding.left + (point.x / maxX) * (width - padding.left - padding.right);
        const y = toY(point.y, { scale, height, padding });
        return `${formatNumber(x, 2)},${formatNumber(y, 2)}`;
    }).join(" ");
}

function buildChartFrame({ maxX, leftLabel, rightLabel, leftScale, rightScale, width, height, padding }) {
    const bottomY = height - padding.bottom;
    return `
        <line x1="${padding.left}" y1="${bottomY}" x2="${width - padding.right}" y2="${bottomY}" stroke="#334155" stroke-width="1" />
        <text x="${padding.left}" y="${height - 5}" fill="#94a3b8" font-size="8">0:00</text>
        <text x="${width - padding.right}" y="${height - 5}" fill="#94a3b8" font-size="8" text-anchor="end">${formatDuration(maxX)}</text>
        <text x="${padding.left - 4}" y="${padding.top + 4}" fill="#94a3b8" font-size="8" text-anchor="end">${formatNumber(leftScale.max, 0)}</text>
        <text x="${width - padding.right + 4}" y="${padding.top + 4}" fill="#94a3b8" font-size="8">${formatNumber(rightScale.max, 0)}</text>
        <text x="${padding.left - 4}" y="${bottomY}" fill="#94a3b8" font-size="8" text-anchor="end">${leftLabel}</text>
        <text x="${width - padding.right + 4}" y="${bottomY}" fill="#94a3b8" font-size="8">${rightLabel}</text>
    `;
}

function toY(value, { scale, height, padding }) {
    const innerHeight = height - padding.top - padding.bottom;
    const ratio = (value - scale.min) / Math.max(scale.max - scale.min, 1);
    return height - padding.bottom - ratio * innerHeight;
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
