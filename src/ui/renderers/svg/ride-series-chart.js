import { formatDuration, formatNumber } from "../../../shared/format.js";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 220;

const CHART_COLORS = {
    background: "#0f172a",
    surface: "rgba(15, 23, 42, 0.74)",
    plot: "rgba(30, 41, 59, 0.52)",
    axis: "rgba(148, 163, 184, 0.34)",
    grid: "rgba(148, 163, 184, 0.16)",
    gridStrong: "rgba(148, 163, 184, 0.28)",
    text: "#f8fafc",
    muted: "#94a3b8",
    dim: "#64748b",
    cursor: "#f59e0b",
    cursorSoft: "rgba(245, 158, 11, 0.16)",
    fill: "rgba(56, 189, 248, 0.12)"
};

export const RIDE_SERIES_X_FIELDS = [
    {
        key: "elapsedSeconds",
        label: "时间",
        unit: "",
        minBaseline: 0,
        format: (value) => formatDuration(value)
    },
    {
        key: "distanceKm",
        label: "距离",
        unit: "km",
        minBaseline: 0,
        format: (value) => `${formatNumber(value, value >= 10 ? 1 : 2)} km`
    }
];

export const RIDE_SERIES_Y_FIELDS = [
    {
        key: "power",
        label: "功率",
        unit: "W",
        minBaseline: 0,
        color: "#38bdf8",
        format: (value) => `${Math.round(value)}W`
    },
    {
        key: "heartRate",
        label: "心率",
        unit: "bpm",
        color: "#fb7185",
        format: (value) => `${Math.round(value)} bpm`
    },
    {
        key: "cadence",
        label: "踏频",
        unit: "rpm",
        minBaseline: 0,
        color: "#a78bfa",
        format: (value) => `${Math.round(value)} rpm`
    },
    {
        key: "speedKph",
        label: "速度",
        unit: "km/h",
        minBaseline: 0,
        color: "#22c55e",
        format: (value) => `${formatNumber(value, 1)} km/h`
    },
    {
        key: "gradePercent",
        label: "坡度",
        unit: "%",
        includeZeroLine: true,
        color: "#f59e0b",
        format: (value) => `${formatSignedNumber(value, 1)}%`
    },
    {
        key: "ascentMeters",
        label: "累计爬升",
        unit: "m",
        minBaseline: 0,
        color: "#84cc16",
        format: (value) => `${Math.round(value)} m`
    },
    {
        key: "routeProgress",
        label: "路线进度",
        unit: "%",
        minBaseline: 0,
        maxBaseline: 100,
        color: "#2dd4bf",
        value: (record) => normalizeRouteProgress(record?.routeProgress),
        format: (value) => `${Math.round(value)}%`
    }
];

export function getRideSeriesAxisFields(axis) {
    if (axis === "x") return RIDE_SERIES_X_FIELDS;
    if (axis === "y") return RIDE_SERIES_Y_FIELDS;
    return [];
}

export function buildRideSeriesChartSvg({
    records = [],
    xKey = "elapsedSeconds",
    yKey = "power",
    currentRecord = null,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    title = null
} = {}) {
    const xField = findField(RIDE_SERIES_X_FIELDS, xKey);
    const yField = findField(RIDE_SERIES_Y_FIELDS, yKey);

    if (!xField || !yField) {
        return buildCenteredMessageSvg({ width, height, message: "不支持的图表字段" });
    }

    const points = collectSeriesPoints(records, xField, yField);
    if (points.length < 2) {
        return buildCenteredMessageSvg({ width, height, message: "暂无足够图表数据" });
    }

    const padding = {
        left: 54,
        right: 24,
        top: 34,
        bottom: 40
    };
    const plot = {
        x: padding.left,
        y: padding.top,
        width: width - padding.left - padding.right,
        height: height - padding.top - padding.bottom
    };
    const xDomain = buildDomain(points.map((point) => point.xValue), xField);
    const yDomain = buildDomain(points.map((point) => point.yValue), yField);
    const toX = (value) => plot.x + ((value - xDomain.min) / Math.max(xDomain.max - xDomain.min, 1e-9)) * plot.width;
    const toY = (value) => plot.y + (1 - ((value - yDomain.min) / Math.max(yDomain.max - yDomain.min, 1e-9))) * plot.height;
    const plottedPoints = points.map((point) => ({
        ...point,
        x: toX(point.xValue),
        y: toY(point.yValue)
    }));
    const xTicks = buildTicks(xDomain.min, xDomain.max, 4);
    const yTicks = buildTicks(yDomain.min, yDomain.max, 3);
    const currentPoint = resolveCurrentPoint({
        currentRecord,
        xField,
        yField,
        points,
        xDomain,
        yDomain,
        toX,
        toY
    });
    const chartTitle = title ?? `${xField.label} - ${yField.label}`;
    const zeroY = yField.includeZeroLine && yDomain.min < 0 && yDomain.max > 0 ? toY(0) : null;
    const lastPoint = points.at(-1);
    const latestLabel = yField.format(lastPoint.yValue);
    const latestXLabel = xField.format(lastPoint.xValue);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${CHART_COLORS.background}"></rect>
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${CHART_COLORS.surface}"></rect>
        <text x="${padding.left}" y="18" fill="${CHART_COLORS.text}" font-size="13" font-weight="800">${escapeHtml(chartTitle)}</text>
        <text x="${width - padding.right}" y="18" text-anchor="end" fill="${CHART_COLORS.muted}" font-size="11">x 轴: ${escapeHtml(xField.label)} / y 轴: ${escapeHtml(yField.label)}</text>
        <rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}" rx="12" fill="${CHART_COLORS.plot}"></rect>
        ${yTicks.map((tick) => buildYTick({ tick, plot, y: toY(tick), field: yField })).join("")}
        ${xTicks.map((tick) => buildXTick({ tick, plot, x: toX(tick), height, field: xField })).join("")}
        ${zeroY === null ? "" : `<line data-role="zero-line" x1="${plot.x}" y1="${zeroY.toFixed(1)}" x2="${plot.x + plot.width}" y2="${zeroY.toFixed(1)}" stroke="${CHART_COLORS.gridStrong}" stroke-width="1.2" stroke-dasharray="6 5"></line>`}
        <line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${CHART_COLORS.axis}" stroke-width="1"></line>
        <line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="${CHART_COLORS.axis}" stroke-width="1"></line>
        <path data-role="series-area" d="${buildAreaPath(plottedPoints, plot.y + plot.height)}" fill="${CHART_COLORS.fill}"></path>
        <polyline data-role="series-line" points="${buildPolyline(plottedPoints)}" fill="none" stroke="${yField.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${currentPoint ? buildCurrentMarker(currentPoint, yField, plot) : ""}
        <text x="${padding.left}" y="${height - 8}" fill="${CHART_COLORS.dim}" font-size="11">${escapeHtml(xField.label)}</text>
        <text x="${width - padding.right}" y="${height - 8}" text-anchor="end" fill="${CHART_COLORS.dim}" font-size="11">${escapeHtml(latestXLabel)}</text>
        <text x="${padding.left}" y="${padding.top - 9}" fill="${yField.color}" font-size="11" font-weight="700">${escapeHtml(yField.label)} ${escapeHtml(latestLabel)}</text>
    `;
}

export function collectSeriesPoints(records, xField, yField) {
    return (records ?? [])
        .map((record, index) => {
            const xValue = readFieldValue(record, xField);
            const yValue = readFieldValue(record, yField);
            return {
                record,
                index,
                xValue,
                yValue
            };
        })
        .filter((point) => Number.isFinite(point.xValue) && Number.isFinite(point.yValue))
        .sort((left, right) => left.xValue - right.xValue || left.index - right.index);
}

function resolveCurrentPoint({ currentRecord, xField, yField, points, xDomain, yDomain, toX, toY }) {
    const source = currentRecord ?? points.at(-1)?.record;
    const xValue = readFieldValue(source, xField);
    const yValue = readFieldValue(source, yField);
    if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) {
        return null;
    }

    const boundedX = clamp(xValue, xDomain.min, xDomain.max);
    const boundedY = clamp(yValue, yDomain.min, yDomain.max);
    return {
        x: toX(boundedX),
        y: toY(boundedY),
        xLabel: xField.format(xValue),
        yLabel: yField.format(yValue)
    };
}

function findField(fields, key) {
    return fields.find((field) => field.key === key) ?? null;
}

function readFieldValue(record, field) {
    if (!record || !field) return null;
    const rawValue = typeof field.value === "function" ? field.value(record) : record[field.key];
    return Number.isFinite(rawValue) ? rawValue : null;
}

function buildDomain(values, field) {
    const safeValues = values.filter(Number.isFinite);
    let min = Math.min(...safeValues);
    let max = Math.max(...safeValues);

    if (Number.isFinite(field.minBaseline)) {
        min = Math.min(min, field.minBaseline);
    }
    if (Number.isFinite(field.maxBaseline)) {
        max = Math.max(max, field.maxBaseline);
    }
    if (field.includeZeroLine) {
        min = Math.min(min, 0);
        max = Math.max(max, 0);
    }

    const range = max - min;
    const padding = range > 0 ? range * 0.08 : Math.max(Math.abs(max || min) * 0.1, 1);
    min -= padding;
    max += padding;

    if (Number.isFinite(field.minBaseline)) {
        min = Math.max(min, field.minBaseline);
    }
    if (Number.isFinite(field.maxBaseline)) {
        max = Math.min(max, field.maxBaseline);
    }

    return { min, max };
}

function buildTicks(min, max, segments) {
    const safeSegments = Math.max(1, segments);
    return Array.from({ length: safeSegments + 1 }, (_, index) => min + ((max - min) / safeSegments) * index);
}

function buildYTick({ tick, plot, y, field }) {
    return `
        <line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${plot.x + plot.width}" y2="${y.toFixed(1)}" stroke="${CHART_COLORS.grid}" stroke-width="1" stroke-dasharray="4 6"></line>
        <text x="${plot.x - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${CHART_COLORS.muted}" font-size="11">${escapeHtml(field.format(tick))}</text>
    `;
}

function buildXTick({ tick, plot, x, height, field }) {
    return `
        <line x1="${x.toFixed(1)}" y1="${plot.y}" x2="${x.toFixed(1)}" y2="${plot.y + plot.height}" stroke="${CHART_COLORS.grid}" stroke-width="1" stroke-dasharray="3 8"></line>
        <text x="${x.toFixed(1)}" y="${height - 22}" text-anchor="middle" fill="${CHART_COLORS.muted}" font-size="11">${escapeHtml(field.format(tick))}</text>
    `;
}

function buildCurrentMarker(point, yField, plot) {
    const pillX = clamp(point.x - 54, plot.x + 4, plot.x + plot.width - 108);
    const pillY = clamp(point.y - 34, plot.y + 2, plot.y + plot.height - 24);
    const labelX = pillX + 54;
    const labelY = pillY + 16;

    return `
        <line data-role="current-cursor" x1="${point.x.toFixed(1)}" y1="${plot.y}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${CHART_COLORS.cursor}" stroke-width="1.4" stroke-dasharray="5 5"></line>
        <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="9" fill="${CHART_COLORS.cursorSoft}"></circle>
        <circle data-role="current-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="#f8fafc" stroke="${CHART_COLORS.cursor}" stroke-width="2"></circle>
        <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="108" height="24" rx="12" fill="rgba(15, 23, 42, 0.9)" stroke="rgba(148, 163, 184, 0.36)" stroke-width="1"></rect>
        <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="${yField.color}" font-size="11" font-weight="800">${escapeHtml(point.yLabel)}</text>
    `;
}

function buildPolyline(points) {
    return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function buildAreaPath(points, baseY) {
    if (!points.length) return "";
    const first = points[0];
    const last = points.at(-1);
    return `M ${first.x.toFixed(1)} ${baseY.toFixed(1)} L ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} L ${last.x.toFixed(1)} ${baseY.toFixed(1)} Z`;
}

function buildCenteredMessageSvg({ width, height, message }) {
    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${CHART_COLORS.background}"></rect>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="${CHART_COLORS.muted}" font-size="14">
            ${escapeHtml(message)}
        </text>
    `;
}

function normalizeRouteProgress(value) {
    if (!Number.isFinite(value)) return null;
    const percent = value <= 1 ? value * 100 : value;
    return clamp(percent, 0, 100);
}

function formatSignedNumber(value, digits = 1) {
    const fixed = formatNumber(value, digits);
    return value > 0 ? `+${fixed}` : fixed;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
