import { buildRouteFromTrackPoints, getRouteSampleAtDistance } from "./route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "./track-route.js";

const MIN_REMAINING_DISTANCE_METERS = 10;

export function buildRouteContinuation(route, resumeDistanceMeters) {
    const originalTotalDistanceMeters = Number(route?.totalDistanceMeters) || 0;
    const startDistanceMeters = Math.max(0, Math.min(Number(resumeDistanceMeters) || 0, originalTotalDistanceMeters));
    if (!Array.isArray(route?.points) || route.points.length < 2 || startDistanceMeters <= 0) {
        return { ...route, routeLibraryResumeDistanceMeters: 0, continuation: null };
    }
    if (originalTotalDistanceMeters - startDistanceMeters < MIN_REMAINING_DISTANCE_METERS) {
        throw new Error("路线已接近终点，请从起点重新开始。");
    }

    const start = getRouteSampleAtDistance(route, startDistanceMeters);
    const remainingPoints = [
        {
            ...start,
            distanceMeters: 0,
            name: "继续起点"
        },
        ...route.points
            .filter((point) => point.distanceMeters > startDistanceMeters)
            .map((point) => ({
                ...point,
                distanceMeters: point.distanceMeters - startDistanceMeters
            }))
    ];
    const segments = buildSummarySegmentsFromTrackPoints(remainingPoints, {
        hasElevationData: route.hasElevationData === true,
        namePrefix: "剩余路线"
    });
    const continuedRoute = buildRouteFromTrackPoints({
        source: "gpx",
        name: route.name,
        points: remainingPoints,
        segments,
        hasElevationData: route.hasElevationData === true
    });

    return {
        ...continuedRoute,
        importFileName: route.importFileName,
        libraryRouteId: route.libraryRouteId,
        routeLibraryResumeDistanceMeters: startDistanceMeters,
        continuation: {
            originalTotalDistanceMeters,
            startDistanceMeters
        }
    };
}

export function getRouteLibraryCompletionDistance(route, sessionDistanceMeters) {
    const startDistanceMeters = Number(route?.continuation?.startDistanceMeters) || 0;
    return Math.min(
        Number(route?.continuation?.originalTotalDistanceMeters) || Number(route?.totalDistanceMeters) || 0,
        startDistanceMeters + Math.max(0, Number(sessionDistanceMeters) || 0)
    );
}
