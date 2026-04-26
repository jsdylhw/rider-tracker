import { formatNumber } from "../../../shared/format.js";

const DEFAULT_ROUTE_CHART_WIDTH = 640;
const DEFAULT_ROUTE_CHART_HEIGHT = 180;
const ROUTE_CHART_COLORS = {
    background: "#111827",
    surface: "rgba(31, 41, 55, 0.36)",
    text: "#cbd5e1",
    muted: "#94a3b8",
    dim: "#64748b",
    grid: "rgba(148, 163, 184, 0.16)",
    gridStrong: "rgba(148, 163, 184, 0.28)",
    routeArea: "rgba(34, 197, 94, 0.11)",
    routeLine: "rgba(132, 204, 22, 0.58)",
    detailArea: "rgba(34, 197, 94, 0.18)",
    current: "#f59e0b",
    currentSoft: "rgba(245, 158, 11, 0.2)",
    currentText: "#f8fafc",
    descent: "#22c55e"
};

export function buildRouteChartEmptyStateSvg(message) {
    return buildCenteredMessageSvg({
        width: DEFAULT_ROUTE_CHART_WIDTH,
        height: DEFAULT_ROUTE_CHART_HEIGHT,
        message
    });
}

export function buildGradeChartSvg(route, currentRecord) {
    const width = DEFAULT_ROUTE_CHART_WIDTH;
    const height = DEFAULT_ROUTE_CHART_HEIGHT;
    const totalDist = Math.max(route.totalDistanceMeters, 1);
    const currentDistanceMeters = clamp(
        typeof currentRecord?.distanceKm === "number" ? currentRecord.distanceKm * 1000 : 0,
        0,
        totalDist
    );
    const allGrades = route.points.map((point) => point.gradePercent ?? 0);
    const overviewMinGrade = Math.min(...allGrades, -5);
    const overviewMaxGrade = Math.max(...allGrades, 5);
    const mainChart = { x: 40, y: 40, width: 430, height: 86 };
    const insetCard = { x: 488, y: 20, width: 126, height: 104 };
    const insetPlot = { x: insetCard.x + 10, y: insetCard.y + 28, width: insetCard.width - 20, height: insetCard.height - 42 };
    const detailWindowSpan = currentRecord
        ? Math.min(totalDist, Math.max(1600, Math.min(totalDist * 0.18, 8000)))
        : totalDist;
    const detailWindowStart = currentRecord
        ? clamp(currentDistanceMeters - detailWindowSpan / 2, 0, Math.max(totalDist - detailWindowSpan, 0))
        : 0;
    const detailWindowEnd = currentRecord ? Math.min(detailWindowStart + detailWindowSpan, totalDist) : totalDist;
    const currentPoint = getPointAtDistance(route.points, currentDistanceMeters);
    const detailSourcePoints = currentRecord
        ? getPointsWithinDistanceRange(route.points, detailWindowStart, detailWindowEnd)
        : route.points;
    const detailGrades = detailSourcePoints.map((point) => point.gradePercent ?? 0);
    const detailMinGrade = Math.min(...detailGrades, -5);
    const detailMaxGrade = Math.max(...detailGrades, 5);
    const detailPoints = detailSourcePoints.map((point) => ({
        ...point,
        x: insetPlot.x + ((point.distanceMeters - detailWindowStart) / Math.max(detailWindowEnd - detailWindowStart, 1)) * insetPlot.width,
        y: mapValueToY(point.gradePercent ?? 0, detailMinGrade, detailMaxGrade, insetPlot.y, insetPlot.height)
    }));
    const overviewPoints = route.points.map((point) => ({
        ...point,
        x: mainChart.x + (point.distanceMeters / totalDist) * mainChart.width,
        y: mapValueToY(point.gradePercent ?? 0, overviewMinGrade, overviewMaxGrade, mainChart.y, mainChart.height)
    }));
    const currentOverviewX = mainChart.x + (currentDistanceMeters / totalDist) * mainChart.width;
    const currentOverviewY = mapValueToY(currentPoint.gradePercent ?? 0, overviewMinGrade, overviewMaxGrade, mainChart.y, mainChart.height);
    const currentDetailX = currentRecord
        ? insetPlot.x + ((currentDistanceMeters - detailWindowStart) / Math.max(detailWindowEnd - detailWindowStart, 1)) * insetPlot.width
        : null;
    const currentDetailY = currentRecord
        ? mapValueToY(currentPoint.gradePercent ?? 0, detailMinGrade, detailMaxGrade, insetPlot.y, insetPlot.height)
        : null;
    const currentPillX = currentRecord
        ? clamp(currentDetailX - 46, insetCard.x + 6, insetCard.x + insetCard.width - 98)
        : null;
    const xTicks = getDistanceTickValues(totalDist, 4);
    const zeroY = mapValueToY(0, overviewMinGrade, overviewMaxGrade, mainChart.y, mainChart.height);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${ROUTE_CHART_COLORS.background}"></rect>
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${ROUTE_CHART_COLORS.surface}"></rect>
        <text x="${mainChart.x}" y="${mainChart.y - 12}" fill="${ROUTE_CHART_COLORS.text}" font-size="12" font-weight="700">全程概览</text>
        <text x="${mainChart.x + mainChart.width}" y="${mainChart.y - 12}" text-anchor="end" fill="${ROUTE_CHART_COLORS.dim}" font-size="10.5">x 轴: 距离 / y 轴: 坡度</text>
        <line x1="${mainChart.x}" y1="${zeroY.toFixed(1)}" x2="${mainChart.x + mainChart.width}" y2="${zeroY.toFixed(1)}" stroke="rgba(148, 163, 184, 0.22)" stroke-width="1" stroke-dasharray="4 5"></line>
        ${buildGradeGuideLines(mainChart, overviewMinGrade, overviewMaxGrade)}
        <path d="${buildAreaPath(overviewPoints, mainChart.y + mainChart.height)}" fill="${ROUTE_CHART_COLORS.routeArea}"></path>
        <polyline points="${buildPolylineString(overviewPoints)}" fill="none" stroke="${ROUTE_CHART_COLORS.routeLine}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${currentRecord ? `<rect x="${(mainChart.x + (detailWindowStart / totalDist) * mainChart.width).toFixed(1)}" y="${(mainChart.y + 2).toFixed(1)}" width="${Math.max((detailWindowSpan / totalDist) * mainChart.width, 8).toFixed(1)}" height="${(mainChart.height - 4).toFixed(1)}" rx="8" fill="rgba(248, 250, 252, 0.1)" stroke="rgba(226, 232, 240, 0.28)" stroke-width="1"></rect>` : ""}
        ${currentRecord ? `<circle cx="${currentOverviewX.toFixed(1)}" cy="${currentOverviewY.toFixed(1)}" r="4.6" fill="#f8fafc" stroke="${ROUTE_CHART_COLORS.current}" stroke-width="2"></circle>` : ""}
        ${xTicks.map((tickValue) => `
            <line x1="${(mainChart.x + (tickValue / totalDist) * mainChart.width).toFixed(1)}" y1="${mainChart.y + mainChart.height}" x2="${(mainChart.x + (tickValue / totalDist) * mainChart.width).toFixed(1)}" y2="${mainChart.y + mainChart.height + 4}" stroke="rgba(148, 163, 184, 0.4)" stroke-width="1"></line>
            <text x="${(mainChart.x + (tickValue / totalDist) * mainChart.width).toFixed(1)}" y="${height - 14}" text-anchor="middle" fill="#94a3b8" font-size="10.5">${formatNumber(tickValue / 1000, 1)} km</text>
        `).join("")}
        <text x="${mainChart.x + mainChart.width / 2}" y="${height - 2}" text-anchor="middle" fill="${ROUTE_CHART_COLORS.dim}" font-size="10.5">距离</text>

        <rect x="${insetCard.x}" y="${insetCard.y}" width="${insetCard.width}" height="${insetCard.height}" rx="14" fill="rgba(15, 23, 42, 0.78)" stroke="rgba(148, 163, 184, 0.24)" stroke-width="1"></rect>
        <text x="${insetCard.x + 10}" y="${insetCard.y + 14}" fill="${ROUTE_CHART_COLORS.currentText}" font-size="11" font-weight="700">${currentRecord ? "当前位置跟随" : "局部视图"}</text>
        <text x="${insetCard.x + 10}" y="${insetCard.y + 25}" fill="#94a3b8" font-size="9.5">${currentRecord ? `${formatNumber(detailWindowStart / 1000, 1)} - ${formatNumber(detailWindowEnd / 1000, 1)} km` : `${formatNumber(totalDist / 1000, 1)} km`}</text>
        <line x1="${insetPlot.x}" y1="${mapValueToY(0, detailMinGrade, detailMaxGrade, insetPlot.y, insetPlot.height).toFixed(1)}" x2="${insetPlot.x + insetPlot.width}" y2="${mapValueToY(0, detailMinGrade, detailMaxGrade, insetPlot.y, insetPlot.height).toFixed(1)}" stroke="rgba(148, 163, 184, 0.18)" stroke-width="1" stroke-dasharray="3 4"></line>
        <path d="${buildAreaPath(detailPoints, insetPlot.y + insetPlot.height)}" fill="${ROUTE_CHART_COLORS.detailArea}"></path>
        <polyline points="${buildPolylineString(detailPoints)}" fill="none" stroke="rgba(226, 232, 240, 0.28)" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${buildColoredSegments(detailPoints)}
        ${currentRecord ? `<line x1="${currentDetailX.toFixed(1)}" y1="${(insetPlot.y - 2).toFixed(1)}" x2="${currentDetailX.toFixed(1)}" y2="${(insetPlot.y + insetPlot.height + 2).toFixed(1)}" stroke="${ROUTE_CHART_COLORS.current}" stroke-width="1.4" stroke-dasharray="4 5"></line>` : ""}
        ${currentRecord ? `<circle cx="${currentDetailX.toFixed(1)}" cy="${currentDetailY.toFixed(1)}" r="8" fill="${ROUTE_CHART_COLORS.currentSoft}"></circle>` : ""}
        ${currentRecord ? `<circle cx="${currentDetailX.toFixed(1)}" cy="${currentDetailY.toFixed(1)}" r="5.4" fill="#f8fafc" stroke="${ROUTE_CHART_COLORS.current}" stroke-width="2.2"></circle>` : ""}
        ${currentRecord ? `<rect x="${currentPillX.toFixed(1)}" y="${(insetCard.y + insetCard.height - 24).toFixed(1)}" width="92" height="18" rx="9" fill="rgba(15, 23, 42, 0.9)" stroke="rgba(148, 163, 184, 0.32)" stroke-width="1"></rect>` : ""}
        ${currentRecord ? `<text x="${(currentPillX + 46).toFixed(1)}" y="${(insetCard.y + insetCard.height - 11).toFixed(1)}" text-anchor="middle" fill="#f8fafc" font-size="10" font-weight="700">${formatSignedNumber(currentPoint.gradePercent ?? 0)}%</text>` : ""}
    `;
}

export function buildElevationProfileSvg(route, currentRecord) {
    const width = DEFAULT_ROUTE_CHART_WIDTH;
    const height = DEFAULT_ROUTE_CHART_HEIGHT;
    const paddingLeft = 40;
    const paddingRight = 16;
    const paddingTop = 18;
    const paddingBottom = 28;
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;
    const totalDist = Math.max(route.totalDistanceMeters, 1);
    const elevations = route.points.map((point) => point.elevationMeters ?? 0);
    const minElevation = Math.min(...elevations);
    const maxElevation = Math.max(...elevations);
    const elevationRange = Math.max(maxElevation - minElevation, 10);
    const baseY = height - paddingBottom;
    const toX = (distanceMeters) => paddingLeft + (distanceMeters / totalDist) * innerWidth;
    const toY = (elevationMeters) => paddingTop + (1 - ((elevationMeters - minElevation) / elevationRange)) * innerHeight;
    const polyline = route.points
        .map((point) => `${toX(point.distanceMeters).toFixed(1)},${toY(point.elevationMeters ?? 0).toFixed(1)}`)
        .join(" ");
    const areaPath = `M ${toX(route.points[0].distanceMeters).toFixed(1)} ${baseY} L ${polyline.replaceAll(" ", " L ")} L ${toX(route.points.at(-1).distanceMeters).toFixed(1)} ${baseY} Z`;
    const distanceKm = totalDist / 1000;
    const currentDistanceMeters = clamp(
        typeof currentRecord?.distanceKm === "number" ? currentRecord.distanceKm * 1000 : 0,
        0,
        totalDist
    );
    const currentPoint = getPointAtDistance(route.points, currentDistanceMeters);
    const currentX = toX(currentDistanceMeters);
    const currentY = toY(currentPoint.elevationMeters ?? 0);
    const currentPillX = clamp(currentX - 46, paddingLeft + 6, width - paddingRight - 94);
    const guideElevations = getDistinctValues([maxElevation, (maxElevation + minElevation) / 2, minElevation]);

    return `
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="#0f172a"></rect>
        <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="${ROUTE_CHART_COLORS.surface}"></rect>
        ${guideElevations.map((value) => `
            <line x1="${paddingLeft}" y1="${toY(value).toFixed(1)}" x2="${width - paddingRight}" y2="${toY(value).toFixed(1)}" stroke="rgba(148, 163, 184, 0.16)" stroke-width="1" stroke-dasharray="4 6"></line>
        `).join("")}
        <line x1="${paddingLeft}" y1="${baseY}" x2="${width - paddingRight}" y2="${baseY}" stroke="rgba(148, 163, 184, 0.28)" stroke-width="1"></line>
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${baseY}" stroke="rgba(148, 163, 184, 0.28)" stroke-width="1"></line>
        <path d="${areaPath}" fill="${ROUTE_CHART_COLORS.routeArea}"></path>
        <polyline points="${polyline}" fill="none" stroke="${ROUTE_CHART_COLORS.routeLine}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${currentRecord ? `<line x1="${currentX.toFixed(1)}" y1="${paddingTop}" x2="${currentX.toFixed(1)}" y2="${baseY}" stroke="${ROUTE_CHART_COLORS.current}" stroke-width="1.5" stroke-dasharray="4 4"></line>` : ""}
        ${currentRecord ? `<circle cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="7.8" fill="${ROUTE_CHART_COLORS.currentSoft}"></circle>` : ""}
        ${currentRecord ? `<circle cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="4.8" fill="#f8fafc" stroke="${ROUTE_CHART_COLORS.current}" stroke-width="2"></circle>` : ""}
        ${currentRecord ? `<rect x="${currentPillX.toFixed(1)}" y="${(paddingTop + 4).toFixed(1)}" width="94" height="24" rx="12" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(148, 163, 184, 0.4)" stroke-width="1"></rect>` : ""}
        ${currentRecord ? `<text x="${(currentPillX + 47).toFixed(1)}" y="${(paddingTop + 20).toFixed(1)}" text-anchor="middle" fill="#f8fafc" font-size="11" font-weight="700">${Math.round(currentPoint.elevationMeters ?? 0)} m</text>` : ""}
        <text x="${paddingLeft}" y="${height - 8}" fill="#94a3b8" font-size="12">0 km</text>
        <text x="${width - paddingRight}" y="${height - 8}" text-anchor="end" fill="#94a3b8" font-size="12">${formatNumber(distanceKm, 1)} km</text>
        <text x="${paddingLeft - 8}" y="${paddingTop + 4}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(maxElevation)} m</text>
        <text x="${paddingLeft - 8}" y="${(paddingTop + innerHeight / 2 + 4).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="11">${Math.round((maxElevation + minElevation) / 2)} m</text>
        <text x="${paddingLeft - 8}" y="${baseY}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(minElevation)} m</text>
        <text x="${paddingLeft}" y="${paddingTop - 4}" fill="${ROUTE_CHART_COLORS.text}" font-size="12" font-weight="700">距离 - 海拔</text>
    `;
}

function buildCenteredMessageSvg({ width, height, message }) {
    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(15, 23, 42, 0.04)" rx="10"></rect>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
            ${message}
        </text>
    `;
}

function buildGradeGuideLines(detail, minGrade, maxGrade) {
    return getDistinctValues([maxGrade, 0, minGrade]).map((value) => {
        const y = mapValueToY(value, minGrade, maxGrade, detail.y, detail.height);
        const isZero = Math.abs(value) < 0.05;
        return `
            <line x1="${detail.x}" y1="${y.toFixed(1)}" x2="${detail.x + detail.width}" y2="${y.toFixed(1)}" stroke="rgba(148, 163, 184, ${isZero ? "0.26" : "0.14"})" stroke-width="1" stroke-dasharray="${isZero ? "5 5" : "3 6"}"></line>
            <text x="${detail.x - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="11">${formatSignedNumber(value)}%</text>
        `;
    }).join("");
}

function buildAreaPath(points, baseY) {
    if (!points.length) return "";
    const [firstPoint] = points;
    const lastPoint = points.at(-1);
    return `M ${firstPoint.x.toFixed(1)} ${baseY.toFixed(1)} L ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} L ${lastPoint.x.toFixed(1)} ${baseY.toFixed(1)} Z`;
}

function buildColoredSegments(points) {
    if (points.length < 2) return "";
    let svg = "";
    for (let index = 1; index < points.length; index += 1) {
        const previousPoint = points[index - 1];
        const currentPoint = points[index];
        const color = getGradeColor((previousPoint.gradePercent + currentPoint.gradePercent) / 2);
        svg += `
            <line x1="${previousPoint.x.toFixed(1)}" y1="${previousPoint.y.toFixed(1)}" x2="${currentPoint.x.toFixed(1)}" y2="${currentPoint.y.toFixed(1)}" stroke="${color}" stroke-width="3.1" stroke-linecap="round"></line>
        `;
    }
    return svg;
}

function buildPolylineString(points) {
    return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function getPointsWithinDistanceRange(points, startDistanceMeters, endDistanceMeters) {
    if (!points.length) return [];
    const rangePoints = points.filter((point) => point.distanceMeters >= startDistanceMeters && point.distanceMeters <= endDistanceMeters);
    const startPoint = getPointAtDistance(points, startDistanceMeters);
    const endPoint = getPointAtDistance(points, endDistanceMeters);
    return dedupeByDistance([startPoint, ...rangePoints, endPoint]);
}

function getPointAtDistance(points, distanceMeters) {
    if (!points.length) {
        return {
            distanceMeters,
            gradePercent: 0,
            elevationMeters: 0
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
        gradePercent: interpolate(previousPoint.gradePercent ?? 0, nextPoint.gradePercent ?? 0, ratio),
        elevationMeters: interpolate(previousPoint.elevationMeters ?? 0, nextPoint.elevationMeters ?? 0, ratio),
        latitude: interpolate(previousPoint.latitude ?? 0, nextPoint.latitude ?? 0, ratio),
        longitude: interpolate(previousPoint.longitude ?? 0, nextPoint.longitude ?? 0, ratio)
    };
}

function dedupeByDistance(points) {
    return points.filter((point, index) => {
        const previousPoint = points[index - 1];
        return !previousPoint || Math.abs(previousPoint.distanceMeters - point.distanceMeters) > 0.1;
    });
}

function getDistinctValues(values) {
    return values.filter((value, index) => values.findIndex((candidate) => Math.abs(candidate - value) < 0.05) === index);
}

function getDistanceTickValues(totalDistanceMeters, segments = 4) {
    return Array.from({ length: segments + 1 }, (_, index) => (totalDistanceMeters / segments) * index);
}

function mapValueToY(value, minValue, maxValue, top, height) {
    if (Math.abs(maxValue - minValue) < 1e-9) {
        return top + height / 2;
    }
    const ratio = (value - minValue) / (maxValue - minValue);
    return top + (1 - ratio) * height;
}

function interpolate(start, end, ratio) {
    return start + (end - start) * ratio;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function formatSignedNumber(value) {
    const rounded = Math.round(value * 10) / 10;
    if (rounded > 0) {
        return `+${rounded}`;
    }
    return `${rounded}`;
}

function getGradeColor(grade) {
    if (grade >= 10) return "#e11d48";
    if (grade >= 7) return "#f43f5e";
    if (grade >= 4) return "#f97316";
    if (grade >= 2) return "#fbbf24";
    if (grade > -2) return "#84cc16";
    return ROUTE_CHART_COLORS.descent;
}
