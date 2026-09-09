import { buildStreetViewTargetFromRoute } from "../../map/street-view-controller.js";
import { hasRouteMapGeometry } from "../../map/map-controller.js";

export function createDashboardRoutePresentation({ elements, onMapShown = () => {} }) {
    function render({ route, currentRecord, ride, immersiveStreetViewMode }) {
        renderRouteContext(route, currentRecord, immersiveStreetViewMode);
        renderExplorationTurnControls(route, ride);
        syncElevationChartCopy(immersiveStreetViewMode);
    }

    function renderRouteContext(route, currentRecord, immersiveStreetViewMode) {
        const routeName = route?.source === "osm-exploration"
            ? "OSM 自由探索"
            : route?.name ?? "--";
        if (elements.rideRouteContext) {
            elements.rideRouteContext.textContent = `当前路线：${routeName} · 当前位置：${formatRoutePosition(route, currentRecord)}`;
        }

        const hasMappableRoute = hasRouteMapGeometry(route);
        const hideRouteMiniMap = immersiveStreetViewMode && !hasMappableRoute;
        if (elements.rideDashboardMap && Boolean(elements.rideDashboardMap.hidden) !== hideRouteMiniMap) {
            elements.rideDashboardMap.hidden = hideRouteMiniMap;
            if (!hideRouteMiniMap) onMapShown();
        }
    }

    function renderExplorationTurnControls(route, ride) {
        const isExplorationRide = route?.source === "osm-exploration" && ride.isActive;
        if (elements.explorationTurnControls) {
            elements.explorationTurnControls.hidden = !isExplorationRide;
        }
        if (!isExplorationRide) return;

        const pendingIntent = route.exploration?.pendingIntent ?? "straight";
        if (elements.explorationTurnStatus) {
            elements.explorationTurnStatus.textContent = pendingIntent === "left"
                ? "下一路口：左拐"
                : pendingIntent === "right"
                    ? "下一路口：右拐"
                    : "下一路口：默认直行";
        }
        [
            [elements.explorationTurnLeftBtn, "left"],
            [elements.explorationTurnStraightBtn, "straight"],
            [elements.explorationTurnRightBtn, "right"]
        ].forEach(([button, intent]) => {
            if (!button) return;
            button.classList.toggle("is-selected", pendingIntent === intent);
            button.setAttribute("aria-pressed", String(pendingIntent === intent));
        });
    }

    function syncElevationChartCopy(immersiveStreetViewMode) {
        if (elements.rideElevationChartTitle) {
            elements.rideElevationChartTitle.textContent = immersiveStreetViewMode ? "海拔与附近坡度" : "路线海拔剖面";
        }
        elements.rideDashboardElevationChart?.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }

    return { render };
}

function formatRoutePosition(route, currentRecord) {
    const latitude = currentRecord?.positionLat;
    const longitude = currentRecord?.positionLong;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
    const target = buildStreetViewTargetFromRoute(route, currentRecord);
    return target
        ? `${target.latitude.toFixed(5)}, ${target.longitude.toFixed(5)}`
        : "--";
}
