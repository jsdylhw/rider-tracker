import { buildDistanceTimeChartSvg } from "./svg/session-charts.js";
import { resolveSessionRenderData } from "./session-render-data.js";

export function createSessionChartRenderer({ elements, routeRenderer }) {
    let lastRenderedAt = 0;

    function render(state) {
        const now = Date.now();
        if (state.liveRide.isActive && now - lastRenderedAt < 1000) return;
        lastRenderedAt = now;

        const { records, session } = resolveSessionRenderData(state);
        if (elements.distanceChart) {
            elements.distanceChart.innerHTML = buildDistanceTimeChartSvg(records);
        }

        const route = state.liveRide.isActive ? (session?.route ?? state.route) : state.route;
        const currentRecord = state.liveRide.isActive
            ? (session?.currentRecord ?? records.at(-1) ?? null)
            : null;
        routeRenderer.renderElevationChart(route, currentRecord);
    }

    return { render };
}
