import { formatDuration, formatNumber } from "../../../shared/format.js";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 220;
const DEFAULT_PADDING = {
    left: 54,
    right: 24,
    top: 34,
    bottom: 40
};

const CHART_THEMES = {
    dark: {
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
        fill: "rgba(56, 189, 248, 0.12)",
        markerFill: "#f8fafc",
        labelBackground: "rgba(15, 23, 42, 0.9)",
        labelStroke: "rgba(148, 163, 184, 0.36)"
    },
    light: {
        background: "#ffffff",
        surface: "#ffffff",
        plot: "#f8fafc",
        axis: "#cbd5e1",
        grid: "rgba(100, 116, 139, 0.16)",
        gridStrong: "rgba(100, 116, 139, 0.28)",
        text: "#0f172a",
        muted: "#64748b",
        dim: "#64748b",
        cursor: "#f59e0b",
        cursorSoft: "rgba(245, 158, 11, 0.16)",
        fill: "rgba(14, 165, 233, 0.08)",
        markerFill: "#ffffff",
        labelBackground: "#ffffff",
        labelStroke: "rgba(148, 163, 184, 0.45)"
    }
};

export const RIDE_SERIES_X_FIELDS = [
    {
        key: "elapsedSeconds",
        label: "时间",
        unit: "分:秒",
        minBaseline: 0,
        domainPadding: 0,
        tickFormat: (value) => formatDuration(value),
        format: (value) => formatDuration(value)
    },
    {
        key: "distanceKm",
        label: "距离",
        unit: "km",
        minBaseline: 0,
        domainPadding: 0,
        tickFormat: (value) => formatNumber(value, value >= 10 ? 1 : 2),
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
        tickFormat: (value) => formatNumber(value, 0),
        format: (value) => `${Math.round(value)}W`
    },
    {
        key: "heartRate",
        label: "心率",
        unit: "bpm",
        color: "#fb7185",
        tickFormat: (value) => formatNumber(value, 0),
        format: (value) => `${Math.round(value)} bpm`
    },
    {
        key: "cadence",
        label: "踏频",
        unit: "rpm",
        minBaseline: 0,
        color: "#a78bfa",
        tickFormat: (value) => formatNumber(value, 0),
        format: (value) => `${Math.round(value)} rpm`
    },
    {
        key: "speedKph",
        label: "速度",
        unit: "km/h",
        minBaseline: 0,
        color: "#22c55e",
        tickFormat: (value) => formatNumber(value, 1),
        format: (value) => `${formatNumber(value, 1)} km/h`
    },
    {
        key: "gradePercent",
        label: "坡度",
        unit: "%",
        includeZeroLine: true,
        color: "#f59e0b",
        tickFormat: (value) => formatSignedNumber(value, 1),
        format: (value) => `${formatSignedNumber(value, 1)}%`
    },
    {
        key: "ascentMeters",
        label: "累计爬升",
        unit: "m",
        minBaseline: 0,
        color: "#84cc16",
        tickFormat: (value) => formatNumber(value, 0),
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
        tickFormat: (value) => formatNumber(value, 0),
        format: (value) => `${Math.round(value)}%`
    }
];

export function getRideSeriesAxisFields(axis) {
    if (axis === "x") return RIDE_SERIES_X_FIELDS;
    if (axis === "y") return RIDE_SERIES_Y_FIELDS;
    return [];
}

export function getRideSeriesField(axis, key) {
    return getRideSeriesAxisFields(axis).find((field) => field.key === key) ?? null;
}

export function buildRideSeriesChartGeometry({
    records = [],
    xKey = "elapsedSeconds",
    yKey = "power",
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    padding = DEFAULT_PADDING
} = {}) {
    const xField = getRideSeriesField("x", xKey);
    const yField = getRideSeriesField("y", yKey);

    if (!xField || !yField) {
        return null;
    }

    const points = collectSeriesPoints(records, xField, yField);
    if (points.length < 2) {
        return null;
    }

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

    return {
        width,
        height,
        padding,
        plot,
        xField,
        yField,
        xDomain,
        yDomain,
        points,
        plottedPoints,
        toX,
        toY
    };
}

export function getRideSeriesValueAtChartX(chartX, geometry) {
    if (!Number.isFinite(chartX) || !geometry?.plot || !geometry?.xDomain) {
        return null;
    }

    const { plot, xDomain } = geometry;
    const boundedX = clamp(chartX, plot.x, plot.x + plot.width);
    const ratio = (boundedX - plot.x) / Math.max(plot.width, 1e-9);
    return xDomain.min + ratio * (xDomain.max - xDomain.min);
}

export function findNearestRideSeriesPoint({
    records = [],
    xKey = "elapsedSeconds",
    yKey = "power",
    xValue = null
} = {}) {
    const xField = getRideSeriesField("x", xKey);
    const yField = getRideSeriesField("y", yKey);
    const targetX = Number(xValue);
    if (!xField || !yField || !Number.isFinite(targetX)) {
        return null;
    }

    const points = collectSeriesPoints(records, xField, yField);
    if (points.length === 0) {
        return null;
    }

    return points.reduce((nearest, point) => {
        const nearestDistance = Math.abs(nearest.xValue - targetX);
        const pointDistance = Math.abs(point.xValue - targetX);
        return pointDistance < nearestDistance ? point : nearest;
    }, points[0]);
}

export function buildRideSeriesChartSvg({
    records = [],
    xKey = "elapsedSeconds",
    yKey = "power",
    currentRecord = null,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    title = null,
    theme = "dark"
} = {}) {
    const colors = CHART_THEMES[theme] ?? CHART_THEMES.dark;
    const xField = getRideSeriesField("x", xKey);
    const yField = getRideSeriesField("y", yKey);

    if (!xField || !yField) {
        return buildCenteredMessageSvg({ width, height, message: "不支持的图表字段", colors });
    }

    const geometry = buildRideSeriesChartGeometry({
        records,
        xKey,
        yKey,
        width,
        height
    });

    if (!geometry) {
        return buildCenteredMessageSvg({ width, height, message: "暂无足够图表数据", colors });
    }

    const { padding, plot, xDomain, yDomain, points, plottedPoints, toX, toY } = geometry;
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
    const zeroY = yField.includeZeroLine && yDomain.min < 0 && yDomain.max > 0 ? toY(0) : null;
    const lastPoint = points.at(-1);
    const latestLabel = yField.format(lastPoint.yValue);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${colors.background}"></rect>
        <rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${colors.surface}"></rect>
        <text x="${padding.left}" y="18" fill="${yField.color}" font-size="11" font-weight="700">${escapeHtml(formatAxisLabel(yField))}</text>
        <rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}" rx="8" fill="${colors.plot}"></rect>
        ${yTicks.map((tick) => buildYTick({ tick, plot, y: toY(tick), field: yField, colors })).join("")}
        ${xTicks.map((tick) => buildXTick({ tick, plot, x: toX(tick), height, field: xField, colors })).join("")}
        ${zeroY === null ? "" : `<line data-role="zero-line" x1="${plot.x}" y1="${zeroY.toFixed(1)}" x2="${plot.x + plot.width}" y2="${zeroY.toFixed(1)}" stroke="${colors.gridStrong}" stroke-width="1.2" stroke-dasharray="6 5"></line>`}
        <line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${colors.axis}" stroke-width="1"></line>
        <line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="${colors.axis}" stroke-width="1"></line>
        <path data-role="series-area" d="${buildAreaPath(plottedPoints, plot.y + plot.height)}" fill="${colors.fill}"></path>
        <polyline data-role="series-line" points="${buildPolyline(plottedPoints)}" fill="none" stroke="${yField.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${currentPoint ? buildCurrentMarker(currentPoint, yField, plot, colors) : ""}
        <text x="${padding.left}" y="${height - 8}" fill="${colors.dim}" font-size="11">${escapeHtml(formatAxisLabel(xField))}</text>
        <text x="${width - padding.right}" y="${padding.top - 9}" text-anchor="end" fill="${yField.color}" font-size="11" font-weight="700">${escapeHtml(latestLabel)}</text>
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
    const source = currentRecord;
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
    const paddingRatio = Number.isFinite(field.domainPadding) ? field.domainPadding : 0.08;
    const padding = paddingRatio > 0
        ? (range > 0 ? range * paddingRatio : Math.max(Math.abs(max || min) * 0.1, 1))
        : 0;
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

function buildYTick({ tick, plot, y, field, colors }) {
    return `
        <line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${plot.x + plot.width}" y2="${y.toFixed(1)}" stroke="${colors.grid}" stroke-width="1" stroke-dasharray="4 6"></line>
        <text x="${plot.x - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${colors.muted}" font-size="11">${escapeHtml(formatTickValue(field, tick))}</text>
    `;
}

function buildXTick({ tick, plot, x, height, field, colors }) {
    return `
        <line x1="${x.toFixed(1)}" y1="${plot.y}" x2="${x.toFixed(1)}" y2="${plot.y + plot.height}" stroke="${colors.grid}" stroke-width="1" stroke-dasharray="3 8"></line>
        <text x="${x.toFixed(1)}" y="${height - 22}" text-anchor="middle" fill="${colors.muted}" font-size="11">${escapeHtml(formatTickValue(field, tick))}</text>
    `;
}

function buildCurrentMarker(point, yField, plot, colors) {
    const xLabelWidth = 58;
    const yLabelWidth = 46;
    const xLabelX = clamp(point.x - xLabelWidth / 2, plot.x + 4, plot.x + plot.width - xLabelWidth - 4);
    const xLabelY = plot.y + plot.height + 4;
    const yLabelX = Math.max(4, plot.x - yLabelWidth - 8);
    const yLabelY = clamp(point.y - 9, plot.y + 2, plot.y + plot.height - 20);

    return `
        <line data-role="current-cursor-x" x1="${point.x.toFixed(1)}" y1="${plot.y}" x2="${point.x.toFixed(1)}" y2="${(plot.y + plot.height).toFixed(1)}" stroke="${colors.cursor}" stroke-width="1.3" stroke-dasharray="5 5"></line>
        <line data-role="current-cursor-y" x1="${plot.x}" y1="${point.y.toFixed(1)}" x2="${(plot.x + plot.width).toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${colors.cursor}" stroke-width="1.3" stroke-dasharray="5 5"></line>
        <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="7" fill="${colors.cursorSoft}"></circle>
        <circle data-role="current-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="${colors.markerFill}" stroke="${colors.cursor}" stroke-width="2"></circle>
        <rect data-role="current-x-label" x="${xLabelX.toFixed(1)}" y="${xLabelY.toFixed(1)}" width="${xLabelWidth}" height="18" rx="5" fill="${colors.labelBackground}" stroke="${colors.labelStroke}" stroke-width="1"></rect>
        <text x="${(xLabelX + xLabelWidth / 2).toFixed(1)}" y="${(xLabelY + 12.5).toFixed(1)}" text-anchor="middle" fill="${colors.text}" font-size="10.5" font-weight="800">${escapeHtml(point.xLabel)}</text>
        <rect data-role="current-y-label" x="${yLabelX.toFixed(1)}" y="${yLabelY.toFixed(1)}" width="${yLabelWidth}" height="18" rx="5" fill="${colors.labelBackground}" stroke="${colors.labelStroke}" stroke-width="1"></rect>
        <text x="${(yLabelX + yLabelWidth / 2).toFixed(1)}" y="${(yLabelY + 12.5).toFixed(1)}" text-anchor="middle" fill="${yField.color}" font-size="10.5" font-weight="800">${escapeHtml(point.yLabel)}</text>
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

function buildCenteredMessageSvg({ width, height, message, colors = CHART_THEMES.dark }) {
    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${colors.background}"></rect>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="${colors.muted}" font-size="14">
            ${escapeHtml(message)}
        </text>
    `;
}

function normalizeRouteProgress(value) {
    if (!Number.isFinite(value)) return null;
    const percent = value <= 1 ? value * 100 : value;
    return clamp(percent, 0, 100);
}

function formatAxisLabel(field) {
    return field.unit ? `${field.label} (${field.unit})` : field.label;
}

function formatTickValue(field, value) {
    if (typeof field.tickFormat === "function") {
        return field.tickFormat(value);
    }
    return formatNumber(value, 0);
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
