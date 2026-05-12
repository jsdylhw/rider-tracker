import { formatNumber } from "../../../shared/format.js";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 260;
const MAX_ROUTE_MAP_POINTS = 1200;
const COLORS = {
    background: "#ffffff",
    routeLine: "#2563eb",
    text: "#0f172a",
    muted: "#64748b",
    border: "#e2e8f0",
    current: "#f59e0b",
    currentSoft: "rgba(245, 158, 11, 0.18)",
    start: "#16a34a",
    end: "#dc2626"
};

export function buildRouteMapSvg({
    route = null,
    records = [],
    currentRecord = null,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    title = "路线平面图"
} = {}) {
    const points = collectRouteMapPoints({ route, records });
    if (points.length < 2) {
        return buildCenteredMessageSvg({ width, height, message: "暂无轨迹数据" });
    }

    const geometry = buildRouteMapGeometry({ route, records, width, height, points });
    const { padding, plottedPoints, totalDistanceMeters } = geometry;
    const start = plottedPoints[0];
    const end = plottedPoints.at(-1);
    const markerSvg = buildRouteMapMarkerSvg({
        route,
        records,
        currentRecord: currentRecord ?? records.at(-1) ?? null,
        width,
        height,
        geometry
    });

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${COLORS.background}" stroke="${COLORS.border}" stroke-width="1"></rect>
        <text x="${padding.left}" y="21" fill="${COLORS.text}" font-size="13" font-weight="800">${escapeHtml(title)}</text>
        <text x="${width - padding.right}" y="21" text-anchor="end" fill="${COLORS.muted}" font-size="11">${escapeHtml(formatDistanceLabel(totalDistanceMeters))}</text>
        <polyline data-role="route-map-line" points="${buildPolyline(plottedPoints)}" fill="none" stroke="${COLORS.routeLine}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"></polyline>
        <circle data-role="route-map-start" cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="4.4" fill="${COLORS.start}"></circle>
        <circle data-role="route-map-end" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="4.4" fill="${COLORS.end}"></circle>
        <g data-role="route-map-marker-layer">${markerSvg}</g>
        <text x="${padding.left}" y="${height - 12}" fill="${COLORS.muted}" font-size="10.5">起点</text>
        <text x="${width - padding.right}" y="${height - 12}" text-anchor="end" fill="${COLORS.muted}" font-size="10.5">终点</text>
    `;
}

export function buildRouteMapMarkerSvg({
    route = null,
    records = [],
    currentRecord = null,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    geometry = null
} = {}) {
    const resolvedGeometry = geometry ?? buildRouteMapGeometry({ route, records, width, height });
    if (!resolvedGeometry) {
        return "";
    }

    const { points, projection, plot, totalDistanceMeters } = resolvedGeometry;
    const currentPoint = resolveCurrentPoint({
        points,
        currentRecord: currentRecord ?? records.at(-1) ?? null,
        totalDistanceMeters
    });
    const currentX = projection.toX(currentPoint);
    const currentY = projection.toY(currentPoint);
    const currentPillX = clamp(currentX - 48, plot.x + 4, plot.x + plot.width - 96);
    const currentLabel = formatDistanceLabel(currentPoint.distanceMeters ?? 0);

    return `
        <circle data-role="route-map-current-halo" cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="8" fill="${COLORS.currentSoft}"></circle>
        <circle data-role="route-map-current" cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="4.8" fill="#ffffff" stroke="${COLORS.current}" stroke-width="2.2"></circle>
        <rect x="${currentPillX.toFixed(1)}" y="${height - 28}" width="96" height="21" rx="6" fill="#ffffff" stroke="${COLORS.border}" stroke-width="1"></rect>
        <text data-role="route-map-current-label" x="${(currentPillX + 48).toFixed(1)}" y="${height - 14}" text-anchor="middle" fill="${COLORS.text}" font-size="10.5" font-weight="800">${escapeHtml(currentLabel)}</text>
    `;
}

export function buildRouteMapGeometry({
    route = null,
    records = [],
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    points = null
} = {}) {
    const sourcePoints = points ?? collectRouteMapPoints({ route, records });
    if (sourcePoints.length < 2) {
        return null;
    }

    const padding = { left: 28, right: 28, top: 36, bottom: 30 };
    const plot = {
        x: padding.left,
        y: padding.top,
        width: width - padding.left - padding.right,
        height: height - padding.top - padding.bottom
    };
    const projection = buildProjection(sourcePoints, plot);
    const plottedPoints = sourcePoints.map((point) => ({
        ...point,
        x: projection.toX(point),
        y: projection.toY(point)
    }));
    const totalDistanceMeters = Math.max(
        numberOrNull(route?.totalDistanceMeters) ?? sourcePoints.at(-1)?.distanceMeters ?? 0,
        sourcePoints.at(-1)?.distanceMeters ?? 0,
        1
    );

    return {
        padding,
        plot,
        points: sourcePoints,
        plottedPoints,
        projection,
        totalDistanceMeters
    };
}

export function collectRouteMapPoints({ route = null, records = [] } = {}) {
    const routePoints = downsampleMapPoints((route?.points ?? [])
        .filter((point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude))
        .map((point, index) => ({
            latitude: point.latitude,
            longitude: point.longitude,
            distanceMeters: numberOrNull(point.distanceMeters) ?? index
        })));

    if (routePoints.length >= 2) {
        return routePoints;
    }

    return downsampleMapPoints((records ?? [])
        .filter((record) => Number.isFinite(record?.positionLat) && Number.isFinite(record?.positionLong))
        .map((record, index) => ({
            latitude: record.positionLat,
            longitude: record.positionLong,
            distanceMeters: numberOrNull(record.distanceKm) !== null ? record.distanceKm * 1000 : index
        })));
}

function downsampleMapPoints(points, maxPoints = MAX_ROUTE_MAP_POINTS) {
    if (points.length <= maxPoints) {
        return points;
    }

    const result = [];
    const lastIndex = points.length - 1;
    const step = lastIndex / (maxPoints - 1);
    let previousIndex = -1;

    for (let index = 0; index < maxPoints; index += 1) {
        const sourceIndex = index === maxPoints - 1 ? lastIndex : Math.round(index * step);
        if (sourceIndex !== previousIndex) {
            result.push(points[sourceIndex]);
            previousIndex = sourceIndex;
        }
    }

    return result;
}

function buildProjection(points, plot) {
    const origin = {
        latitude: Math.min(...points.map((point) => point.latitude)),
        longitude: Math.min(...points.map((point) => point.longitude))
    };
    const referenceLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
    const projectedPoints = points.map((point) => projectPoint(point, { origin, referenceLatitude }));
    const xs = projectedPoints.map((point) => point.x);
    const ys = projectedPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const xRange = Math.max(maxX - minX, 1e-9);
    const yRange = Math.max(maxY - minY, 1e-9);
    const scale = Math.min(plot.width / xRange, plot.height / yRange);
    const contentWidth = xRange * scale;
    const contentHeight = yRange * scale;
    const offsetX = plot.x + (plot.width - contentWidth) / 2;
    const offsetY = plot.y + (plot.height - contentHeight) / 2;

    return {
        toX(point) {
            const projected = projectPoint(point, { origin, referenceLatitude });
            return offsetX + (projected.x - minX) * scale;
        },
        toY(point) {
            const projected = projectPoint(point, { origin, referenceLatitude });
            return offsetY + contentHeight - (projected.y - minY) * scale;
        }
    };
}

function projectPoint(point, { origin, referenceLatitude }) {
    const latRadians = referenceLatitude * Math.PI / 180;
    return {
        x: (point.longitude - origin.longitude) * Math.cos(latRadians),
        y: point.latitude - origin.latitude
    };
}

function resolveCurrentPoint({ points, currentRecord, totalDistanceMeters }) {
    if (Number.isFinite(currentRecord?.positionLat) && Number.isFinite(currentRecord?.positionLong)) {
        return {
            latitude: currentRecord.positionLat,
            longitude: currentRecord.positionLong,
            distanceMeters: numberOrNull(currentRecord.distanceKm) !== null
                ? currentRecord.distanceKm * 1000
                : totalDistanceMeters
        };
    }

    const currentDistanceMeters = clamp(
        numberOrNull(currentRecord?.distanceKm) !== null ? currentRecord.distanceKm * 1000 : totalDistanceMeters,
        0,
        totalDistanceMeters
    );
    return getRoutePointAtDistance(points, currentDistanceMeters);
}

function getRoutePointAtDistance(points, distanceMeters) {
    const boundedDistance = clamp(distanceMeters, 0, points.at(-1)?.distanceMeters ?? distanceMeters);
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

function buildPolyline(points) {
    return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function buildCenteredMessageSvg({ width, height, message }) {
    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${COLORS.background}" stroke="${COLORS.border}" stroke-width="1"></rect>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="${COLORS.muted}" font-size="14">
            ${escapeHtml(message)}
        </text>
    `;
}

function formatDistanceLabel(distanceMeters) {
    return `${formatNumber(distanceMeters / 1000, 1)} km`;
}

function interpolate(start, end, ratio) {
    return start + (end - start) * ratio;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
