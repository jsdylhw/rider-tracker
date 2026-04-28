const PIP_ELEVATION_CHART_WIDTH = 320;
const PIP_ELEVATION_CHART_HEIGHT = 72;
const PIP_ELEVATION_CHART_PADDING_TOP = 10;
const PIP_ELEVATION_CHART_PADDING_BOTTOM = 10;

export function buildPipElevationChartSvg(route, currentRecord) {
    if (!route?.points?.length) {
        return `
            <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">
                暂无路线数据
            </text>
        `;
    }

    const width = PIP_ELEVATION_CHART_WIDTH;
    const height = PIP_ELEVATION_CHART_HEIGHT;
    const innerHeight = height - PIP_ELEVATION_CHART_PADDING_TOP - PIP_ELEVATION_CHART_PADDING_BOTTOM;
    const totalDist = Math.max(route.totalDistanceMeters ?? 0, 1);
    const gradeValues = route.points.map((point) => point.gradePercent ?? 0);
    const maxGrade = Math.max(...gradeValues, 5);
    const minGrade = Math.min(...gradeValues, -5);
    const gradeRange = Math.max(maxGrade - minGrade, 1);
    const zeroY = PIP_ELEVATION_CHART_PADDING_TOP + innerHeight * (maxGrade / gradeRange);

    let svgContent = `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2" />`;

    for (let index = 1; index < route.points.length; index += 1) {
        const prevPoint = route.points[index - 1];
        const currentPoint = route.points[index];
        const prevX = ((prevPoint.distanceMeters ?? 0) / totalDist) * width;
        const curX = ((currentPoint.distanceMeters ?? 0) / totalDist) * width;
        const prevY = PIP_ELEVATION_CHART_PADDING_TOP + innerHeight * ((maxGrade - (prevPoint.gradePercent ?? 0)) / gradeRange);
        const curY = PIP_ELEVATION_CHART_PADDING_TOP + innerHeight * ((maxGrade - (currentPoint.gradePercent ?? 0)) / gradeRange);
        const color = getGradeColor(currentPoint.gradePercent ?? 0);

        svgContent += `
            <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${curX},${curY} ${curX},${zeroY}" fill="${color}" opacity="0.8" />
            <line x1="${prevX}" y1="${prevY}" x2="${curX}" y2="${curY}" stroke="${color}" stroke-width="1" />
        `;
    }

    if (currentRecord) {
        const posX = ((currentRecord.distanceKm ?? 0) * 1000 / totalDist) * width;
        svgContent += `
            <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
            <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="2 2" />
            <circle cx="${posX}" cy="${zeroY}" r="3" fill="white" stroke="var(--text)" stroke-width="1.5" />
        `;
    }

    return svgContent;
}

function getGradeColor(grade) {
    if (grade >= 10) return "#e11d48";
    if (grade >= 7) return "#f43f5e";
    if (grade >= 4) return "#f97316";
    if (grade >= 2) return "#fbbf24";
    if (grade > -2) return "#2dd4bf";
    return "#38bdf8";
}
