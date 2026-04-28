import { buildMetricCardsHtml } from "../../shared/live-metrics.js";

export function createDashboardMetricsRenderer({ elements }) {
    function render({
        metricsData,
        enabledMetricKeys,
        immersiveStreetViewMode = false,
        hasSession = false
    }) {
        if (immersiveStreetViewMode) {
            if (elements.dashboardMetricsGrid) {
                elements.dashboardMetricsGrid.innerHTML = "";
            }
            if (elements.immersiveMetricsGrid) {
                elements.immersiveMetricsGrid.innerHTML = buildImmersiveMetricsHtml(metricsData, hasSession);
            }
            return;
        }

        if (elements.immersiveMetricsGrid) {
            elements.immersiveMetricsGrid.innerHTML = "";
        }
        if (elements.dashboardMetricsGrid) {
            elements.dashboardMetricsGrid.innerHTML = buildDefaultMetricsHtml(metricsData, enabledMetricKeys, hasSession);
        }
    }

    return {
        render
    };
}

function buildDefaultMetricsHtml(metricsData, enabledMetricKeys, hasSession) {
    return buildMetricCardsHtml({
        metricsData,
        metricKeys: enabledMetricKeys,
        hasSession,
        emptyMessage: "还没有选择数据项，请打开自定义面板添加。"
    });
}

function buildImmersiveMetricsHtml(metricsData, hasSession) {
    const immersiveKeys = ["currentSpeed", "currentPower", "currentGrade", "currentCadence", "currentHr"];
    return buildMetricCardsHtml({
        metricsData,
        metricKeys: immersiveKeys,
        hasSession
    });
}
