export function createActivityDetailView({
    onSetUiMode,
    onConnectStrava,
    onUploadActivityFit
}) {
    const elements = {
        viewActivityDetail: document.getElementById("view-activity-detail"),
        activityDetailContent: document.getElementById("activityDetailContent"),
        activityDetailBackBtn: document.getElementById("activityDetailBackBtn")
    };

    bind(elements.activityDetailBackBtn, "click", () => onSetUiMode("home"));
    bind(elements.activityDetailContent, "click", (event) => {
        const action = event.target?.dataset?.activityPageAction;
        if (!action) {
            return;
        }

        if (action === "connect-strava") {
            onConnectStrava();
        }
        if (action === "upload-strava") {
            onUploadActivityFit();
        }
    });
    bind(elements.activityDetailContent, "pointermove", (event) => {
        const target = event.target?.closest?.("[data-chart-tooltip]");
        if (!target || !elements.activityDetailContent?.contains(target)) {
            hideChartTooltip(elements.activityDetailContent);
            return;
        }

        showChartTooltip(elements.activityDetailContent, target.dataset.chartTooltip, event);
    });
    bind(elements.activityDetailContent, "pointerleave", () => {
        hideChartTooltip(elements.activityDetailContent);
    });

    return { elements };
}

function showChartTooltip(root, text, event) {
    if (!root || !text) {
        return;
    }

    const tooltip = getChartTooltip(root);
    tooltip.textContent = text;
    tooltip.hidden = false;

    const offset = 12;
    const margin = 8;
    const tooltipRect = tooltip.getBoundingClientRect();
    const maxLeft = window.innerWidth - tooltipRect.width - margin;
    const maxTop = window.innerHeight - tooltipRect.height - margin;
    const left = Math.min(maxLeft, Math.max(margin, event.clientX + offset));
    const top = Math.min(maxTop, Math.max(margin, event.clientY + offset));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

function hideChartTooltip(root) {
    const tooltip = root?.querySelector?.("[data-activity-chart-tooltip]");
    if (tooltip) {
        tooltip.hidden = true;
    }
}

function getChartTooltip(root) {
    let tooltip = root.querySelector("[data-activity-chart-tooltip]");
    if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.className = "activity-chart-tooltip";
        tooltip.dataset.activityChartTooltip = "true";
        tooltip.hidden = true;
        root.appendChild(tooltip);
    }
    return tooltip;
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}
