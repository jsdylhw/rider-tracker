export const ROUTE_ELEVATION_SOURCES = Object.freeze({
    NONE: "none",
    GPX_EMBEDDED: "gpx_embedded",
    STRAVA_ROUTE: "strava_route",
    GOOGLE_ESTIMATED: "google_estimated",
    MANUAL_DEFINED: "manual_defined"
});

const GRADE_SIMULATION_SOURCES = new Set([
    ROUTE_ELEVATION_SOURCES.GPX_EMBEDDED,
    ROUTE_ELEVATION_SOURCES.STRAVA_ROUTE
]);

export function resolveElevationSource({ source, hasElevationData, elevationSource } = {}) {
    if (hasElevationData !== true) return ROUTE_ELEVATION_SOURCES.NONE;
    if (Object.values(ROUTE_ELEVATION_SOURCES).includes(elevationSource)) return elevationSource;
    if (source === "strava") return ROUTE_ELEVATION_SOURCES.STRAVA_ROUTE;
    if (source === "gpx") return ROUTE_ELEVATION_SOURCES.GPX_EMBEDDED;
    if (source === "manual") return ROUTE_ELEVATION_SOURCES.MANUAL_DEFINED;
    return ROUTE_ELEVATION_SOURCES.NONE;
}

export function supportsGradeSimulation(route) {
    return route?.hasElevationData === true
        && GRADE_SIMULATION_SOURCES.has(resolveElevationSource(route));
}

export function resolveRideGradePercent(route, routeSample) {
    if (!supportsGradeSimulation(route)) return 0;
    const gradePercent = Number(routeSample?.gradePercent);
    return Number.isFinite(gradePercent) ? gradePercent : 0;
}
