import {
    buildRideSeriesChartGeometry,
    buildRideSeriesInteractionLayerSvg,
    findNearestRideSeriesPointInGeometry,
    getRideSeriesValueAtChartX
} from "../renderers/svg/ride-series-chart.js";
import { buildRouteMapGeometry, buildRouteMapMarkerSvg } from "../renderers/svg/route-map-chart.js";
import { openUploadModal } from "./export-view.js";

export function createActivityDetailView({
    onSetUiMode,
    onConnectStrava,
    onUploadActivityFit,
    onUpdateExportMetadata,
    getExportMetadata
}) {
    const elements = {
        viewActivityDetail: document.getElementById("view-activity-detail"),
        activityDetailContent: document.getElementById("activityDetailContent"),
        activityDetailBackBtn: document.getElementById("activityDetailBackBtn")
    };
    let currentActivity = null;
    let activeHoverIndex = null;
    let pendingSeriesPointer = null;
    let pendingSeriesFrame = null;

    bind(elements.activityDetailBackBtn, "click", () => onSetUiMode("home"));
    bind(elements.activityDetailContent, "click", (event) => {
        const actionButton = event.target?.closest?.("[data-activity-page-action]");
        if (!actionButton || !elements.activityDetailContent?.contains(actionButton)) {
            return;
        }

        const action = actionButton.dataset.activityPageAction;
        if (!action) {
            return;
        }

        if (action === "connect-strava") {
            onConnectStrava();
        }
        if (action === "upload-strava") {
            const initialName = currentActivity?.name || currentActivity?.rawSession?.exportMetadata?.activityName;
            openUploadModal({
                onUpload: onUploadActivityFit,
                onUpdateExportMetadata,
                getExportMetadata,
                initialValues: { activityName: initialName }
            });
        }
    });
    bind(elements.activityDetailContent, "click", (event) => {
        const button = event.target?.closest?.("[data-activity-map-toggle]");
        if (!button || !elements.activityDetailContent?.contains(button)) {
            return;
        }

        const layout = button.closest(".activity-detail-analysis-layout");
        const isHidden = !layout?.classList.contains("is-map-hidden");
        layout?.classList.toggle("is-map-hidden", isHidden);
        button.textContent = isHidden ? "显示" : "隐藏";
    });
    bind(elements.activityDetailContent, "pointermove", (event) => {
        const chart = event.target?.closest?.("[data-activity-series-chart]");
        if (chart && elements.activityDetailContent?.contains(chart)) {
            pendingSeriesPointer = {
                target: event.target,
                clientX: event.clientX
            };
            if (!pendingSeriesFrame) {
                pendingSeriesFrame = requestAnimationFrame(() => {
                    pendingSeriesFrame = null;
                    const pointer = pendingSeriesPointer;
                    pendingSeriesPointer = null;
                    handleSeriesPointerMove({
                        root: elements.activityDetailContent,
                        activity: currentActivity,
                        event: pointer,
                        activeHoverIndex,
                        onHoverIndexChange(index) {
                            activeHoverIndex = index;
                        }
                    });
                });
            }
            hideChartTooltip(elements.activityDetailContent);
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
        if (pendingSeriesFrame) {
            cancelAnimationFrame(pendingSeriesFrame);
            pendingSeriesFrame = null;
            pendingSeriesPointer = null;
        }
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

    const geometry = getCachedSeriesGeometry(chart, records);
    if (!geometry) {
        return false;
    }

    const chartX = getSvgChartX(chart, event);
    const xValue = getRideSeriesValueAtChartX(chartX, geometry);
    const nearest = findNearestRideSeriesPointInGeometry(geometry, xValue);
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
        const overlay = chart.querySelector("[data-role='series-interaction-layer']");
        if (!overlay) {
            return;
        }

        overlay.innerHTML = buildRideSeriesInteractionLayerSvg({
            records,
            xKey: chart.dataset.xKey || "elapsedSeconds",
            yKey,
            currentRecord: hoverRecord,
            theme: "light",
            height: chart.viewBox?.baseVal?.height || 180,
            padding: getSeriesChartPadding(chart),
            showXAxis: chart.dataset.showXAxis !== "false",
            xDomain: readChartXDomain(chart),
            geometry: getCachedSeriesGeometry(chart, records)
        });
    });

    const routeMap = root.querySelector("[data-activity-route-map]");
    if (routeMap) {
        const markerLayer = routeMap.querySelector("[data-role='route-map-marker-layer']");
        if (!markerLayer) {
            return;
        }
        markerLayer.innerHTML = buildRouteMapMarkerSvg({
            route,
            records,
            currentRecord: hoverRecord ?? records.at(-1) ?? null,
            width: routeMap.viewBox?.baseVal?.width || 640,
            height: routeMap.viewBox?.baseVal?.height || 260,
            geometry: getCachedRouteMapGeometry(routeMap, route, records)
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

function readChartXDomain(chart) {
    const min = Number(chart?.dataset?.xDomainMin);
    const max = Number(chart?.dataset?.xDomainMax);
    return Number.isFinite(min) && Number.isFinite(max) && max > min
        ? { min, max }
        : null;
}

function getSeriesChartPadding(chart) {
    const showXAxis = chart?.dataset?.showXAxis !== "false";
    return {
        left: 54,
        right: 16,
        top: 24,
        bottom: showXAxis ? 34 : 18
    };
}

function getCachedSeriesGeometry(chart, records) {
    const cache = chart?._rideSeriesGeometryCache;
    const xKey = chart?.dataset?.xKey || "elapsedSeconds";
    const yKey = chart?.dataset?.yKey || "power";
    const height = chart?.viewBox?.baseVal?.height || 150;
    const xDomain = readChartXDomain(chart);
    if (
        cache
        && cache.records === records
        && cache.xKey === xKey
        && cache.yKey === yKey
        && cache.height === height
        && cache.xDomain?.min === xDomain?.min
        && cache.xDomain?.max === xDomain?.max
    ) {
        return cache.geometry;
    }

    const geometry = buildRideSeriesChartGeometry({
        records,
        xKey,
        yKey,
        height,
        padding: getSeriesChartPadding(chart),
        xDomain
    });
    chart._rideSeriesGeometryCache = {
        records,
        xKey,
        yKey,
        height,
        xDomain,
        geometry
    };
    return geometry;
}

function getCachedRouteMapGeometry(routeMap, route, records) {
    const width = routeMap?.viewBox?.baseVal?.width || 640;
    const height = routeMap?.viewBox?.baseVal?.height || 260;
    const cache = routeMap?._routeMapGeometryCache;
    if (cache && cache.route === route && cache.records === records && cache.width === width && cache.height === height) {
        return cache.geometry;
    }

    const geometry = buildRouteMapGeometry({
        route,
        records,
        width,
        height
    });
    routeMap._routeMapGeometryCache = {
        route,
        records,
        width,
        height,
        geometry
    };
    return geometry;
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
