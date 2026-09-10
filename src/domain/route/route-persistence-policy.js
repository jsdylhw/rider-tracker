const AUTO_SAVE_ON_RIDE_START_SOURCES = new Set([
    "gpx",
    "agent-planned",
    "map-drawn"
]);

const PROGRESS_TRACKING_SOURCES = new Set([
    ...AUTO_SAVE_ON_RIDE_START_SOURCES,
    "strava"
]);

export function shouldAutoSaveRouteOnRideStart(route) {
    return isUsableCoordinateRoute(route)
        && AUTO_SAVE_ON_RIDE_START_SOURCES.has(normalizeSource(route?.source));
}

export function shouldTrackSavedRouteProgress(route) {
    return Boolean(String(route?.savedRouteId ?? "").trim())
        && PROGRESS_TRACKING_SOURCES.has(normalizeSource(route?.source));
}

function isUsableCoordinateRoute(route) {
    return Number(route?.totalDistanceMeters) > 0
        && Array.isArray(route?.points)
        && route.points.filter(hasCoordinate).length >= 2;
}

function hasCoordinate(point) {
    const latitude = Number(point?.latitude ?? point?.lat);
    const longitude = Number(point?.longitude ?? point?.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function normalizeSource(value) {
    return String(value ?? "").trim().toLowerCase();
}
