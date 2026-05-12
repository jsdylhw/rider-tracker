import {
    buildRideSeriesChartGeometry,
    buildRideSeriesChartSvg,
    findNearestRideSeriesPoint,
    getRideSeriesValueAtChartX
} from "../renderers/svg/ride-series-chart.js";
import { buildRouteMapSvg } from "../renderers/svg/route-map-chart.js";

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
    let currentActivity = null;
    let activeHoverIndex = null;

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
        if (handleSeriesPointerMove({
            root: elements.activityDetailContent,
            activity: currentActivity,
            event,
            activeHoverIndex,
            onHoverIndexChange(index) {
                activeHoverIndex = index;
            }
        })) {
            return;
        }

        const target = event.target?.closest?.("[data-chart-tooltip]");
        if (!target || !elements.activityDetailContent?.contains(target)) {
            hideChartTooltip(elements.activityDetailContent);
            return;
        }

        showChartTooltip(elements.activityDetailContent, target.dataset.chartTooltip, event);
    });
    bind(elements.activityDetailContent, "pointerleave", () => {
        hideChartTooltip(elements.activityDetailContent);
        activeHoverIndex = null;
        renderHoverRecord(elements.activityDetailContent, currentActivity, null);
    });

    return {
        elements,
        setActivity(activity) {
            currentActivity = activity ?? null;
            activeHoverIndex = null;
        }
    };
}

function handleSeriesPointerMove({ root, activity, event, activeHoverIndex, onHoverIndexChange }) {
    const chart = event.target?.closest?.("[data-activity-series-chart]");
    if (!chart || !root?.contains(chart) || !activity) {
        return false;
    }

    const records = getActivityRecords(activity);
    if (records.length < 2) {
        return false;
    }

    const xKey = chart.dataset.xKey || "elapsedSeconds";
    const yKey = chart.dataset.yKey || "power";
    const geometry = buildRideSeriesChartGeometry({
        records,
        xKey,
        yKey
    });
    if (!geometry) {
        return false;
    }

    const chartX = getSvgChartX(chart, event);
    const xValue = getRideSeriesValueAtChartX(chartX, geometry);
    const nearest = findNearestRideSeriesPoint({
        records,
        xKey,
        yKey,
        xValue
    });
    if (!nearest) {
        return false;
    }

    if (nearest.index !== activeHoverIndex) {
        renderHoverRecord(root, activity, nearest.record);
        onHoverIndexChange(nearest.index);
    }
    hideChartTooltip(root);
    return true;
}

function renderHoverRecord(root, activity, hoverRecord) {
    const records = getActivityRecords(activity);
    const route = activity?.rawSession?.route ?? null;
    if (!root || records.length < 2) {
        return;
    }

    root.querySelectorAll("[data-activity-series-chart]").forEach((chart) => {
        const yKey = chart.dataset.yKey || "power";
        const title = chart.dataset.chartTitle || null;
        chart.innerHTML = buildRideSeriesChartSvg({
            records,
            xKey: chart.dataset.xKey || "elapsedSeconds",
            yKey,
            title,
            currentRecord: hoverRecord,
            theme: "light"
        });
    });

    const routeMap = root.querySelector("[data-activity-route-map]");
    if (routeMap) {
        routeMap.innerHTML = buildRouteMapSvg({
            route,
            records,
            currentRecord: hoverRecord ?? records.at(-1) ?? null
        });
    }
}

function getSvgChartX(svg, event) {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox?.baseVal;
    const viewBoxWidth = viewBox?.width || 640;
    if (!rect.width) {
        return 0;
    }
    return ((event.clientX - rect.left) / rect.width) * viewBoxWidth;
}

function getActivityRecords(activity) {
    const records = activity?.rawSession?.records;
    return Array.isArray(records) ? records : [];
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
