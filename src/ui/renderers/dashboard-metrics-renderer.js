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
    return enabledMetricKeys
        .map((key) => {
            const metric = metricsData[key];
            if (!metric) {
                return "";
            }
            return `
                <div class="data-item">
                    <div class="data-label">${metric.label}</div>
                    <div class="data-display ${metric.color}">${hasSession ? metric.value : "--"} <span class="unit">${metric.unit}</span></div>
                </div>
            `;
        })
        .join("");
}

function buildImmersiveMetricsHtml(metricsData, hasSession) {
    const immersiveKeys = ["currentSpeed", "currentPower", "currentGrade", "currentCadence", "currentHr"];
    return immersiveKeys
        .map((key) => {
            const metric = metricsData[key];
            if (!metric) {
                return "";
            }
            return `
                <div class="data-item">
                    <div class="data-label">${metric.label}</div>
                    <div class="data-display ${metric.color}">${hasSession ? metric.value : "--"} <span class="unit">${metric.unit}</span></div>
                </div>
            `;
        })
        .join("");
}
