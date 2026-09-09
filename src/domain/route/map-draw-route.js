import {
    buildCoordinateRoute,
    COORDINATE_ROUTE_SAMPLE_SPACING_METERS
} from "./coordinate-route.js";

export const MAP_DRAW_SAMPLE_SPACING_METERS = COORDINATE_ROUTE_SAMPLE_SPACING_METERS;

/** Preserve the map-selection API while delegating route assembly to the shared domain builder. */
export function buildMapDrawRoute(input = {}) {
    return buildCoordinateRoute({
        ...input,
        source: "map-drawn",
        name: "地图绘制路线",
        routeProvider: "google-routes"
    });
}
