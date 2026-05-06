import { formatDuration, formatNumber } from "../../shared/format.js";
import { buildDualSeriesChartSvg } from "../renderers/svg/dual-series-chart.js";
import { buildPipElevationChartSvg } from "./pip-elevation-chart.js";

const SERIES_WIDTH = 320;
const SERIES_HEIGHT = 88;
const SERIES_PADDING = { top: 14, right: 24, bottom: 18, left: 24 };

const POWER_ZONE_COLORS = ["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444", "#a855f7"];

const PIP_CHART_RENDERERS = {
    elevation: {
        title: "坡度图",
        render: ({ route, currentRecord }) => buildPipElevationChartSvg(route, currentRecord)
    },
    powerHeartRate: {
        title: "功率 / 心率",
        render: ({ records }) => buildDualSeriesChartSvg(records, {
            left: { field: "heartRate", label: "bpm", color: "#fb7185" },
            right: { field: "power", label: "W", color: "#22c55e" }
        })
    },
    speedCadence: {
        title: "速度 / 踏频",
        render: ({ records }) => buildDualSeriesChartSvg(records, {
            left: { field: "speedKph", label: "km/h", color: "#38bdf8" },
            right: { field: "cadence", label: "rpm", color: "#fbbf24" }
        })
    },
    powerZone: {
        title: "功率区间",
        render: ({ records, ftp }) => buildPowerZoneChartSvg(records, ftp)
    }
};

export function buildPipChartsHtml({ chartKeys = [], route, currentRecord, records = [], ftp = null } = {}) {
    const html = chartKeys.map((key) => {
        const renderer = PIP_CHART_RENDERERS[key];
        return renderer ? buildChartCard(renderer.title, renderer.render({ route, currentRecord, records, ftp })) : "";
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
