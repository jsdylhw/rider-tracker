import { buildRouteFromTrackPoints, getRouteSampleAtDistance } from "./route-builder.js";
import { buildSummarySegmentsFromTrackPoints } from "./track-route.js";

const MIN_REMAINING_DISTANCE_METERS = 10;

export function buildRouteContinuation(route, resumeDistanceMeters) {
    const originalTotalDistanceMeters = Number(route?.totalDistanceMeters) || 0;
    const startDistanceMeters = Math.max(
        0,
        Math.min(Number(resumeDistanceMeters) || 0, originalTotalDistanceMeters)
    );
    if (!Array.isArray(route?.points) || route.points.length < 2 || startDistanceMeters <= 0) {
        return { ...route, savedRouteResumeDistanceMeters: 0, continuation: null };
    }
    if (originalTotalDistanceMeters - startDistanceMeters < MIN_REMAINING_DISTANCE_METERS) {
        throw new Error("路线已接近终点，请从起点重新开始。");
    }

    const start = getRouteSampleAtDistance(route, startDistanceMeters);
    const remainingPoints = [
        { ...start, distanceMeters: 0, name: "继续起点" },
        ...route.points
            .filter((point) => point.distanceMeters > startDistanceMeters)
            .map((point) => ({
                ...point,
                distanceMeters: point.distanceMeters - startDistanceMeters
            }))
    ];
    const hasElevationData = route.hasElevationData === true;
    const continued = buildRouteFromTrackPoints({
        source: route.source,
        name: route.name,
        points: remainingPoints,
        segments: buildSummarySegmentsFromTrackPoints(remainingPoints, {
            hasElevationData,
            namePrefix: "剩余路线"
        }),
        hasElevationData
    });
    return {
        ...route,
        ...continued,
        savedRouteId: route.savedRouteId,
        savedRouteResumeDistanceMeters: startDistanceMeters,
        continuation: {
            originalTotalDistanceMeters,
            startDistanceMeters
        }
    };
}

export function getSavedRouteCompletionDistance(route, sessionDistanceMeters) {
    const startDistanceMeters = Number(route?.continuation?.startDistanceMeters) || 0;
    const originalTotalDistanceMeters = Number(route?.continuation?.originalTotalDistanceMeters)
        || Number(route?.totalDistanceMeters) || 0;
    return Math.min(
        originalTotalDistanceMeters,
        startDistanceMeters + Math.max(0, Number(sessionDistanceMeters) || 0)
    );
}
