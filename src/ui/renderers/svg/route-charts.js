import { formatNumber } from "../../../shared/format.js";

const DEFAULT_ROUTE_CHART_WIDTH = 640;
const DEFAULT_ROUTE_CHART_HEIGHT = 180;

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
    const paddingBottom = 20;
    const paddingTop = 20;
    const innerHeight = height - paddingTop - paddingBottom;
    const totalDist = Math.max(route.totalDistanceMeters, 1);
    const grades = route.points.map((point) => point.gradePercent ?? 0);
    const maxGrade = Math.max(...grades, 5);
    const minGrade = Math.min(...grades, -5);
    const gradeRange = Math.max(maxGrade - minGrade, 1);
    const zeroY = paddingTop + innerHeight * (maxGrade / gradeRange);
    let svgContent = `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" />`;

    for (let index = 1; index < route.points.length; index += 1) {
        const prevPoint = route.points[index - 1];
        const currentPoint = route.points[index];
        const prevX = (prevPoint.distanceMeters / totalDist) * width;
        const currentX = (currentPoint.distanceMeters / totalDist) * width;
        const prevY = paddingTop + innerHeight * ((maxGrade - (prevPoint.gradePercent ?? 0)) / gradeRange);
        const currentY = paddingTop + innerHeight * ((maxGrade - (currentPoint.gradePercent ?? 0)) / gradeRange);
        const color = getGradeColor(currentPoint.gradePercent ?? 0);

        svgContent += `
            <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${currentX},${currentY} ${currentX},${zeroY}"
                     fill="${color}" opacity="0.8" />
            <line x1="${prevX}" y1="${prevY}" x2="${currentX}" y2="${currentY}"
                  stroke="${color}" stroke-width="1.5" />
        `;
    }

    if (!currentRecord) {
        return svgContent;
    }

    const posX = ((currentRecord.distanceKm * 1000) / totalDist) * width;
    return `${svgContent}
        <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
        <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="2" stroke-dasharray="4 4" />
        <circle cx="${posX}" cy="${zeroY}" r="5" fill="white" stroke="var(--text)" stroke-width="2" />
    `;
}

export function buildElevationProfileSvg(route, currentRecord) {
    const width = DEFAULT_ROUTE_CHART_WIDTH;
    const height = DEFAULT_ROUTE_CHART_HEIGHT;
    const paddingLeft = 40;
    const paddingRight = 12;
    const paddingTop = 16;
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
    let markerSvg = "";

    if (currentRecord) {
        const currentDistanceMeters = currentRecord.distanceKm * 1000;
        const currentPoint = route.points.find((point) => point.distanceMeters >= currentDistanceMeters) ?? route.points.at(-1);
        const currentX = toX(Math.min(currentDistanceMeters, totalDist));
        const currentY = toY(currentPoint.elevationMeters ?? 0);
        markerSvg = `
            <line x1="${currentX.toFixed(1)}" y1="${paddingTop}" x2="${currentX.toFixed(1)}" y2="${baseY}" stroke="#f8fafc" stroke-width="1.5" stroke-dasharray="4 4" />
            <circle cx="${currentX.toFixed(1)}" cy="${currentY.toFixed(1)}" r="4.5" fill="#f8fafc" stroke="#2563eb" stroke-width="2" />
        `;
    }

    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
        <line x1="${paddingLeft}" y1="${baseY}" x2="${width - paddingRight}" y2="${baseY}" stroke="#475569" stroke-width="1" />
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${baseY}" stroke="#475569" stroke-width="1" />
        <path d="${areaPath}" fill="rgba(56, 189, 248, 0.18)"></path>
        <polyline points="${polyline}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${markerSvg}
        <text x="${paddingLeft}" y="${height - 8}" fill="#94a3b8" font-size="12">0 km</text>
        <text x="${width - paddingRight}" y="${height - 8}" text-anchor="end" fill="#94a3b8" font-size="12">${formatNumber(distanceKm, 1)} km</text>
        <text x="${paddingLeft - 6}" y="${paddingTop + 4}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(maxElevation)} m</text>
        <text x="${paddingLeft - 6}" y="${baseY}" text-anchor="end" fill="#94a3b8" font-size="12">${Math.round(minElevation)} m</text>
        <text x="${paddingLeft}" y="${paddingTop - 2}" fill="#cbd5e1" font-size="12">距离 - 海拔</text>
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

function getGradeColor(grade) {
    if (grade >= 10) return "#e11d48";
    if (grade >= 7) return "#f43f5e";
    if (grade >= 4) return "#f97316";
    if (grade >= 2) return "#fbbf24";
    if (grade > -2) return "#2dd4bf";
    return "#38bdf8";
}
