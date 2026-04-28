export const METRIC_OPTIONS = [
    { key: "currentHr", label: "当前心率", group: "心率" },
    { key: "avgHr", label: "平均心率", group: "心率" },
    { key: "maxHr", label: "最大心率", group: "心率" },
    { key: "currentPower", label: "实时功率", group: "功率" },
    { key: "avg3sPower", label: "3秒均功率", group: "功率" },
    { key: "avgPower", label: "平均功率", group: "功率" },
    { key: "maxPower", label: "最大功率", group: "功率" },
    { key: "avg10sPower", label: "10秒均功率", group: "功率" },
    { key: "normalizedPower", label: "标准化功率", group: "功率" },
    { key: "powerPerKg", label: "实时 W/kg", group: "功率" },
    { key: "avgPowerPerKg", label: "平均 W/kg", group: "功率" },
    { key: "powerZone", label: "功率区间", group: "功率" },
    { key: "currentCadence", label: "实时踏频", group: "踏频" },
    { key: "avgCadence", label: "平均踏频", group: "踏频" },
    { key: "maxCadence", label: "最大踏频", group: "踏频" },
    { key: "hrZone", label: "心率区间", group: "心率" },
    { key: "currentSpeed", label: "当前速度", group: "基础" },
    { key: "avgSpeed", label: "平均速度", group: "基础" },
    { key: "maxSpeed", label: "最高速度", group: "基础" },
    { key: "distanceKm", label: "骑行距离", group: "基础" },
    { key: "remainingKm", label: "剩余距离", group: "基础" },
    { key: "elapsedTime", label: "骑行时间", group: "基础" },
    { key: "routeProgress", label: "路线进度", group: "基础" },
    { key: "ascentMeters", label: "累计爬升", group: "基础" },
    { key: "pushedGrade", label: "推送坡度", group: "基础" },
    { key: "currentGrade", label: "当前坡度", group: "基础" },
    { key: "lookaheadGrade", label: "前方坡度", group: "基础" },
    { key: "avgGrade", label: "平均坡度", group: "基础" },
    { key: "maxClimbGrade", label: "最大爬坡", group: "基础" },
    { key: "maxDescentGrade", label: "最大下坡", group: "基础" },
    { key: "targetControl", label: "目标控制值", group: "基础" },
    { key: "intensityFactor", label: "强度系数 IF", group: "强度" },
    { key: "variabilityIndex", label: "变异指数 VI", group: "强度" },
    { key: "tss", label: "预估 TSS", group: "强度" },
    { key: "powerSource", label: "功率来源", group: "设备" },
    { key: "powerSignalHz", label: "功率频率", group: "设备" },
    { key: "powerSignalJitter", label: "功率抖动", group: "设备" },
    { key: "powerSignalStatus", label: "功率信号", group: "设备" }
];

export const METRIC_LABELS = Object.fromEntries(METRIC_OPTIONS.map((option) => [option.key, option]));

export const DEFAULT_METRIC_SELECTION = {
    currentPower: true,
    avg3sPower: true,
    currentHr: true,
    currentSpeed: true,
    currentCadence: true,
    pushedGrade: true,
    avgPower: false,
    maxPower: false,
    avg10sPower: false,
    normalizedPower: false,
    powerPerKg: false,
    avgPowerPerKg: false,
    powerZone: false,
    avgHr: false,
    maxHr: false,
    hrZone: false,
    avgCadence: false,
    maxCadence: false,
    currentGrade: true,
    avgSpeed: false,
    maxSpeed: false,
    distanceKm: false,
    remainingKm: false,
    elapsedTime: false,
    routeProgress: false,
    ascentMeters: false,
    lookaheadGrade: false,
    avgGrade: false,
    maxClimbGrade: false,
    maxDescentGrade: false,
    targetControl: false,
    intensityFactor: false,
    variabilityIndex: false,
    tss: false,
    powerSource: false,
    powerSignalHz: false,
    powerSignalJitter: false,
    powerSignalStatus: false
};

export const DEFAULT_PIP_METRIC_SELECTION = {
    ...DEFAULT_METRIC_SELECTION,
    avg3sPower: false,
    pushedGrade: false,
    distanceKm: true,
    remainingKm: true,
    currentGrade: true,
    lookaheadGrade: true,
    targetControl: true
};

export function normalizeMetricSelection(selection, fallbackSelection = DEFAULT_METRIC_SELECTION) {
    const normalized = { ...fallbackSelection };

    Object.keys(selection ?? {}).forEach((key) => {
        if (Object.hasOwn(normalized, key)) {
            normalized[key] = selection[key] === true;
        }
    });

    return normalized;
}

export function getEnabledMetricKeys(selection) {
    return Object.entries(selection)
        .filter(([, isEnabled]) => isEnabled)
        .map(([key]) => key);
}

export function buildMetricCardsHtml({
    metricsData,
    metricKeys,
    hasSession = true,
    itemClass = "data-item",
    labelClass = "data-label",
    valueClass = "data-display",
    unitClass = "unit",
    emptyMessage = "还没有选择数据项。"
}) {
    const html = metricKeys
        .map((key) => {
            const metric = metricsData[key];
            if (!metric) return "";

            return `
                <div class="${itemClass}">
                    <div class="${labelClass}">${metric.label}</div>
                    <div class="${valueClass} ${metric.color}">${hasSession ? metric.value : "--"} <span class="${unitClass}">${metric.unit}</span></div>
                </div>
            `;
        })
        .join("");

    return html || `<p class="section-subtitle">${emptyMessage}</p>`;
}
