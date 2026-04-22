import { formatDuration, formatNumber } from "../../../shared/format.js";

export function buildDistanceTimeChartSvg(records) {
    if (records.length === 0) {
        return `
            <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                运行模拟后将显示图像
            </text>
        `;
    }

    const width = 640;
    const height = 280;
    const padding = 40;
    const maxTime = Math.max(records[records.length - 1].elapsedSeconds, 1);
    const maxDist = Math.max(records[records.length - 1].distanceKm, 0.001);
    const points = records.map((record) => {
        const x = padding + (record.elapsedSeconds / maxTime) * (width - padding * 2);
        const y = height - padding - (record.distanceKm / maxDist) * (height - padding * 2);
        return `${x},${y}`;
    }).join(" ");

    return `
        <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
        <text x="${padding}" y="${height - padding + 20}" fill="#64748b" font-size="12">0s</text>
        <text x="${width - padding}" y="${height - padding + 20}" fill="#64748b" font-size="12" text-anchor="end">${formatDuration(maxTime)}</text>
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
        <text x="${padding - 10}" y="${height - padding}" fill="#64748b" font-size="12" text-anchor="end">0 km</text>
        <text x="${padding - 10}" y="${padding}" fill="#64748b" font-size="12" text-anchor="end">${formatNumber(maxDist, 1)} km</text>
    `;
}
