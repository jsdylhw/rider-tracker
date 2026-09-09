import {
    DEFAULT_METRIC_SELECTION,
    METRIC_LABELS,
    METRIC_OPTIONS,
    normalizeMetricSelection
} from "../../../shared/live-metrics.js";

export function createDashboardMetricCustomizer({ elements, onChange = () => {} }) {
    const selection = normalizeMetricSelection(DEFAULT_METRIC_SELECTION);

    function bindEvents() {
        elements.customizeMetricsBtn?.addEventListener("click", () => {
            if (elements.metricsCustomizer) {
                elements.metricsCustomizer.hidden = !elements.metricsCustomizer.hidden;
            }
        });

        elements.addMetricBtn?.addEventListener("click", () => {
            const key = elements.metricAddSelect?.value;
            if (!key || !Object.hasOwn(selection, key)) return;
            selection[key] = true;
            if (elements.metricAddSelect) elements.metricAddSelect.value = "";
            renderControls();
            onChange(selection);
        });

        elements.metricAddSelect?.addEventListener("change", syncAddButton);
        elements.selectedMetricsList?.addEventListener("click", (event) => {
            const removeButton = event.target.closest("[data-remove-metric]");
            const key = removeButton?.dataset.removeMetric;
            if (!key || !Object.hasOwn(selection, key)) return;
            selection[key] = false;
            renderControls();
            onChange(selection);
        });

        renderControls();
    }

    function renderControls() {
        renderSelectedMetrics();
        syncMetricOptions();
        syncAddButton();
    }

    function renderSelectedMetrics() {
        if (!elements.selectedMetricsList) return;
        const enabledOptions = METRIC_OPTIONS.filter((option) => selection[option.key]);
        elements.selectedMetricsList.innerHTML = enabledOptions.length
            ? enabledOptions.map((option) => `
                <span class="metric-chip-item">
                    <span class="metric-chip-group">${option.group}</span>
                    ${option.label}
                    <button type="button" class="metric-chip-remove" data-remove-metric="${option.key}" aria-label="移除${option.label}">×</button>
                </span>
            `).join("")
            : `<p class="section-subtitle">还没有选择数据项，请从上方下拉菜单添加。</p>`;
    }

    function syncMetricOptions() {
        if (!elements.metricAddSelect) return;
        [...elements.metricAddSelect.options].forEach((option) => {
            if (!option.value) return;
            option.disabled = selection[option.value] === true;
            const metric = METRIC_LABELS[option.value];
            if (metric) {
                option.textContent = selection[option.value]
                    ? `${metric.label}（已添加）`
                    : metric.label;
            }
        });
    }

    function syncAddButton() {
        if (elements.addMetricBtn) {
            elements.addMetricBtn.disabled = !elements.metricAddSelect?.value;
        }
    }

    return { bindEvents, selection };
}
