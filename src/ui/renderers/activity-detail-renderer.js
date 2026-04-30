import { formatDuration, formatNumber } from "../../shared/format.js";

export const POWER_ZONES = [
    { key: "recovery", label: "恢复", min: 0, max: 0.55 },
    { key: "endurance", label: "耐力", min: 0.55, max: 0.75 },
    { key: "tempo", label: "节奏", min: 0.75, max: 0.9 },
    { key: "threshold", label: "阈值", min: 0.9, max: 1.05 },
    { key: "vo2", label: "VO2", min: 1.05, max: 1.2 },
    { key: "anaerobic", label: "无氧", min: 1.2, max: Infinity }
];

export const HEART_RATE_RESERVE_ZONES = [
    { key: "warmup", label: "热身", min: 0, max: 0.6 },
    { key: "easy", label: "轻松", min: 0.6, max: 0.7 },
    { key: "aerobic", label: "有氧", min: 0.7, max: 0.8 },
    { key: "threshold", label: "阈值", min: 0.8, max: 0.9 },
    { key: "max", label: "高强度", min: 0.9, max: Infinity }
];

const MAX_CHART_POINTS = 500;

export function buildActivityDetailHtml(activity, {
    showCloseButton = true,
    actionsHtml = ""
} = {}) {
    if (!activity) {
        return "";
    }

    const session = activity.rawSession ?? {};
    const records = Array.isArray(session.records) ? session.records : [];
    const metrics = session.summary?.metrics ?? {};
    const ride = metrics.ride ?? {};
    const speed = metrics.speed ?? {};
    const power = metrics.power ?? {};
    const heartRate = metrics.heartRate ?? {};
    const load = metrics.load ?? {};
    const energy = metrics.energy ?? {};
    const ftp = Number(session.settings?.ftp ?? session.rawSettings?.ftp);
    const maxHr = Number(session.settings?.maxHr ?? session.rawSettings?.maxHr);
    const restingHr = Number(session.settings?.restingHr ?? session.rawSettings?.restingHr);
    const normalizedPower = numberOrNull(activity.normalizedPower ?? power.normalizedPowerWatts);
    const averagePower = numberOrNull(activity.averagePower ?? power.averageWatts);
    const intensityFactor = numberOrNull(power.intensityFactor) ?? (
        Number.isFinite(ftp) && ftp > 0 && normalizedPower !== null ? normalizedPower / ftp : null
    );

    return `
        <section class="activity-detail-panel">
            <div class="activity-detail-header">
                <div>
                    <p class="eyebrow">Activity Detail</p>
                    <h3>${escapeHtml(activity.name)}</h3>
                    <p class="section-subtitle">${escapeHtml(formatActivityDate(activity.startedAt ?? activity.createdAt))} · ${escapeHtml(activity.sportType)} · ${escapeHtml(activity.source)}</p>
                </div>
                ${showCloseButton ? `<button class="btn ghost compact-btn" data-activity-action="close-details" data-activity-id="${escapeHtml(activity.id)}">关闭</button>` : ""}
            </div>
            <div class="activity-detail-summary">
                ${buildSummaryItem("距离", formatMetric(activity.distanceKm ?? ride.distanceKm, "km", 2))}
                ${buildSummaryItem("时间", formatDuration(numberOrNull(activity.elapsedSeconds ?? ride.elapsedSeconds) ?? 0))}
                ${buildSummaryItem("爬升", formatMetric(activity.ascentMeters ?? ride.ascentMeters, "m", 0))}
                ${buildSummaryItem("均速", formatMetric(speed.averageKph, "km/h", 1))}
                ${buildSummaryItem("均功率", formatMetric(averagePower, "W", 0))}
                ${buildSummaryItem("NP", formatMetric(normalizedPower, "W", 0))}
                ${buildSummaryItem("IF", intensityFactor === null ? "-" : formatNumber(intensityFactor, 2))}
                ${buildSummaryItem("TSS", formatNumber(numberOrNull(activity.estimatedTss ?? load.estimatedTss) ?? 0, 1))}
                ${buildSummaryItem("消耗", formatEnergyMetric(energy))}
                ${buildSummaryItem("均心率", formatMetric(activity.averageHr ?? heartRate.averageBpm, "bpm", 0))}
            </div>
            <div class="activity-detail-insight">
                ${escapeHtml(buildPlainSummary({ activity, records, ftp, averagePower, normalizedPower, intensityFactor }))}
            </div>
            ${actionsHtml}
            <div class="activity-detail-grid">
                <div class="activity-detail-card">
                    <div class="activity-detail-card-title">功率 / 时间</div>
                    <svg class="activity-detail-chart" viewBox="0 0 640 220" preserveAspectRatio="none">${buildTimeSeriesChartSvg(records, {
                        field: "power",
                        color: "var(--primary)",
                        label: "W"
                    })}</svg>
                </div>
                <div class="activity-detail-card">
                    <div class="activity-detail-card-title">心率 / 时间</div>
                    <svg class="activity-detail-chart" viewBox="0 0 640 220" preserveAspectRatio="none">${buildTimeSeriesChartSvg(records, {
                        field: "heartRate",
                        color: "#ef4444",
                        label: "bpm"
                    })}</svg>
                </div>
                <div class="activity-detail-card">
                    <div class="activity-detail-card-title">功率区间</div>
                    ${buildPowerZoneHtml(records, ftp)}
                </div>
                <div class="activity-detail-card">
                    <div class="activity-detail-card-title">心率区间</div>
                    ${buildHeartRateZoneHtml(records, { restingHr, maxHr })}
                </div>
            </div>
        </section>
    `;
}

export function buildActivityDetailPageHtml(activity) {
    if (!activity) {
        return `
            <section class="activity-detail-page-empty">
                <p class="eyebrow">Activity Detail</p>
                <h2>未选择活动</h2>
                <p class="section-subtitle">从历史记录选择一条活动，或在骑行结束后查看本页。</p>
            </section>
        `;
    }

    return buildActivityDetailHtml(activity, {
        showCloseButton: false,
        actionsHtml: buildActivityActionsHtml(activity)
    });
}

function buildActivityActionsHtml(activity) {
    const hasFitFile = Boolean(activity.fitFilePath);
    const fitStatus = hasFitFile
        ? `FIT 已保存：${activity.fitFilePath}`
        : "FIT 暂未归档；上传 Strava 时会自动生成并保存。";
    const fitSize = Number.isFinite(activity.fitFileSizeBytes)
        ? ` · ${formatNumber(activity.fitFileSizeBytes / 1024, 1)} KB`
        : "";

    return `
        <div class="activity-action-panel">
            <div>
                <p class="eyebrow">Sync</p>
                <h4>活动文件与上传</h4>
                <p class="section-subtitle">${escapeHtml(fitStatus)}${escapeHtml(fitSize)}</p>
            </div>
            <div class="activity-action-buttons">
                <button class="btn secondary compact-btn" data-activity-page-action="connect-strava">连接 Strava</button>
                <button class="btn primary compact-btn" data-activity-page-action="upload-strava" data-activity-id="${escapeHtml(activity.id)}">上传 Strava</button>
            </div>
        </div>
    `;
}

export function buildTimeSeriesChartSvg(records, { field, color, label }) {
    const points = downsamplePoints(records
        .map((record) => ({
            x: numberOrNull(record.elapsedSeconds),
            y: numberOrNull(record[field])
        }))
        .filter((point) => point.x !== null && point.y !== null));

    if (points.length < 2) {
        return buildEmptyChartSvg("暂无曲线数据");
    }

    const width = 640;
    const height = 220;
    const padding = 34;
    const maxX = Math.max(...points.map((point) => point.x), 1);
    const maxY = Math.max(...points.map((point) => point.y), 1);
    const minY = Math.min(0, ...points.map((point) => point.y));
    const yRange = Math.max(maxY - minY, 1);
    const polyline = points.map((point) => {
        const x = padding + (point.x / maxX) * (width - padding * 2);
        const y = height - padding - ((point.y - minY) / yRange) * (height - padding * 2);
        return `${formatNumber(x, 2)},${formatNumber(y, 2)}`;
    }).join(" ");

    return `
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
        <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
        <text x="${padding}" y="${height - 10}" fill="#64748b" font-size="12">0:00</text>
        <text x="${width - padding}" y="${height - 10}" fill="#64748b" font-size="12" text-anchor="end">${escapeHtml(formatDuration(maxX))}</text>
        <text x="${padding - 8}" y="${height - padding}" fill="#64748b" font-size="12" text-anchor="end">${formatNumber(minY, 0)}</text>
        <text x="${padding - 8}" y="${padding}" fill="#64748b" font-size="12" text-anchor="end">${formatNumber(maxY, 0)} ${escapeHtml(label)}</text>
    `;
}

export function downsamplePoints(points, maxPoints = MAX_CHART_POINTS) {
    if (points.length <= maxPoints) {
        return points;
    }

    const result = [];
    const lastIndex = points.length - 1;
    const step = lastIndex / (maxPoints - 1);
    let previousIndex = -1;

    for (let index = 0; index < maxPoints; index += 1) {
        const sourceIndex = index === maxPoints - 1
            ? lastIndex
            : Math.round(index * step);
        if (sourceIndex !== previousIndex) {
            result.push(points[sourceIndex]);
            previousIndex = sourceIndex;
        }
    }

    return result;
}

export function summarizePowerZones(records, ftp) {
    const safeFtp = Number.isFinite(ftp) && ftp > 0 ? ftp : null;
    const zones = POWER_ZONES.map((zone) => ({ ...zone, seconds: 0 }));
    if (!safeFtp || records.length < 2) {
        return zones;
    }

    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        const power = numberOrNull(current.power);
        const elapsed = numberOrNull(current.elapsedSeconds);
        const previousElapsed = numberOrNull(previous.elapsedSeconds);
        if (power === null || elapsed === null || previousElapsed === null || elapsed <= previousElapsed) {
            continue;
        }
        const ratio = power / safeFtp;
        const zone = zones.find((candidate) => ratio >= candidate.min && ratio < candidate.max) ?? zones.at(-1);
        zone.seconds += elapsed - previousElapsed;
    }

    return zones;
}

export function summarizeHeartRateZones(records, { restingHr, maxHr } = {}) {
    const safeRestingHr = Number.isFinite(restingHr) && restingHr > 0 ? restingHr : null;
    const safeMaxHr = Number.isFinite(maxHr) && maxHr > 0 ? maxHr : null;
    const heartRateReserve = safeRestingHr !== null && safeMaxHr !== null ? safeMaxHr - safeRestingHr : null;
    const zones = HEART_RATE_RESERVE_ZONES.map((zone) => ({ ...zone, seconds: 0 }));
    if (!safeRestingHr || !safeMaxHr || !heartRateReserve || heartRateReserve <= 0 || records.length < 2) {
        return zones;
    }

    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        const heartRate = numberOrNull(current.heartRate);
        const elapsed = numberOrNull(current.elapsedSeconds);
        const previousElapsed = numberOrNull(previous.elapsedSeconds);
        if (heartRate === null || elapsed === null || previousElapsed === null || elapsed <= previousElapsed) {
            continue;
        }
        const ratio = (heartRate - safeRestingHr) / heartRateReserve;
        const zone = zones.find((candidate) => ratio >= candidate.min && ratio < candidate.max) ?? zones.at(-1);
        zone.seconds += elapsed - previousElapsed;
    }

    return zones;
}

export function buildPowerZoneHtml(records, ftp) {
    const zones = summarizePowerZones(records, ftp);
    const totalSeconds = zones.reduce((sum, zone) => sum + zone.seconds, 0);
    if (!Number.isFinite(ftp) || ftp <= 0) {
        return `<div class="activity-history-empty">缺少 FTP，无法计算功率区间。</div>`;
    }
    if (totalSeconds <= 0) {
        return `<div class="activity-history-empty">暂无功率区间数据。</div>`;
    }

    return buildZoneListHtml(zones, totalSeconds, {
        rangeFormatter: formatPowerZoneRange,
        trackClass: "power-zone-track"
    });
}

export function buildHeartRateZoneHtml(records, { restingHr, maxHr }) {
    const zones = summarizeHeartRateZones(records, { restingHr, maxHr });
    const totalSeconds = zones.reduce((sum, zone) => sum + zone.seconds, 0);
    if (!Number.isFinite(restingHr) || restingHr <= 0 || !Number.isFinite(maxHr) || maxHr <= restingHr) {
        return `<div class="activity-history-empty">缺少静息/最大心率，无法计算储备心率区间。</div>`;
    }
    if (totalSeconds <= 0) {
        return `<div class="activity-history-empty">暂无心率区间数据。</div>`;
    }

    return buildZoneListHtml(zones, totalSeconds, {
        rangeFormatter: (zone) => formatHeartRateZoneRange(zone, { restingHr, maxHr }),
        trackClass: "heart-rate-zone-track"
    });
}

function buildZoneListHtml(zones, totalSeconds, { rangeFormatter, trackClass }) {
    const rows = zones.map((zone) => {
        const percent = (zone.seconds / totalSeconds) * 100;
        return `
            <div class="zone-row">
                <div class="zone-label">
                    <strong>${escapeHtml(zone.label)}</strong>
                    <span>${escapeHtml(rangeFormatter(zone))}</span>
                </div>
                <div class="zone-track ${escapeHtml(trackClass)}">
                    <span style="width: ${formatNumber(percent, 2)}%;"></span>
                </div>
                <div class="zone-value">${escapeHtml(formatDuration(zone.seconds))}</div>
            </div>
        `;
    }).join("");

    return `<div class="zone-list">${rows}</div>`;
}

function buildPlainSummary({ activity, records, ftp, averagePower, normalizedPower, intensityFactor }) {
    const distance = formatMetric(activity.distanceKm, "km", 2);
    const duration = formatDuration(numberOrNull(activity.elapsedSeconds) ?? 0);
    const powerText = averagePower === null ? "功率数据不足" : `平均功率 ${Math.round(averagePower)} W`;
    const npText = normalizedPower === null ? "" : `，NP ${Math.round(normalizedPower)} W`;
    const ifText = intensityFactor === null ? "" : `，IF ${formatNumber(intensityFactor, 2)}`;
    const ftpText = Number.isFinite(ftp) && ftp > 0 ? `，FTP ${Math.round(ftp)} W` : "";
    const hrValues = records.map((record) => numberOrNull(record.heartRate)).filter((value) => value !== null);
    const hrText = hrValues.length ? `平均心率 ${Math.round(hrValues.reduce((sum, value) => sum + value, 0) / hrValues.length)} bpm。` : "心率数据不足。";

    return `本次活动 ${distance} / ${duration}，${powerText}${npText}${ifText}${ftpText}。${hrText}`;
}

function buildSummaryItem(label, value) {
    return `
        <div class="summary-card">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function buildEmptyChartSvg(message) {
    return `
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
            ${escapeHtml(message)}
        </text>
    `;
}

function formatPowerZoneRange(zone) {
    if (zone.max === Infinity) {
        return `>${Math.round(zone.min * 100)}% FTP`;
    }
    return `${Math.round(zone.min * 100)}-${Math.round(zone.max * 100)}% FTP`;
}

function formatHeartRateZoneRange(zone, { restingHr, maxHr }) {
    const reserve = maxHr - restingHr;
    const minBpm = Math.round(restingHr + zone.min * reserve);
    if (zone.max === Infinity) {
        return `>${minBpm} bpm`;
    }
    return `${minBpm}-${Math.round(restingHr + zone.max * reserve)} bpm`;
}

function formatMetric(value, unit, digits) {
    const numeric = numberOrNull(value);
    if (numeric === null) {
        return "-";
    }
    return `${formatNumber(numeric, digits)} ${unit}`;
}

function formatEnergyMetric(energy) {
    const calories = numberOrNull(energy?.estimatedCaloriesKcal);
    const work = numberOrNull(energy?.mechanicalWorkKj);
    if (calories === null && work === null) {
        return "-";
    }

    const caloriesText = calories === null ? "-" : `${formatNumber(calories, 0)} kcal`;
    const workText = work === null ? "-" : `${formatNumber(work, 0)} kJ`;
    return `${caloriesText} / ${workText}`;
}

function formatActivityDate(value) {
    if (!value) {
        return "未知时间";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
