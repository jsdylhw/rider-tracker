import { getRouteSampleAtDistance, getSegmentAtDistance } from "../route/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";
import { estimateHeartRate } from "../physiology/heart-rate-model.js";
import { buildRideMetrics, createEmptyRideMetrics } from "../metrics/ride-metrics.js";

export function simulateRide({ route, settings }) {
    const records = [];
    const maxSimulationSeconds = 24 * 60 * 60;
    const finishedAt = new Date().toISOString();

    if (!route || route.totalDistanceMeters <= 0) {
        const metrics = createEmptyRideMetrics();
        return {
            createdAt: finishedAt,
            startedAt: finishedAt,
            finishedAt,
            route,
            settings,
            records,
            summary: createSummary(metrics)
        };
    }

    let state = {
        speed: 0,
        distanceMeters: 0,
        elevationMeters: 0,
        ascentMeters: 0
    };
    let currentHeartRate = settings.restingHr;

    for (let elapsedSeconds = 1; elapsedSeconds <= maxSimulationSeconds; elapsedSeconds += 1) {
        const routeSample = getRouteSampleAtDistance(route, state.distanceMeters);
        const gradePercent = routeSample.gradePercent ?? 0;

        const previousState = state;
        state = simulateStep({
            ...state,
            power: settings.power,
            gradePercent,
            elapsedSeconds,
            settings,
            durationSeconds: maxSimulationSeconds,
            dt: 1
        });
        state = clampStateToRouteFinish({
            previousState,
            nextState: state,
            route
        });
        currentHeartRate = estimateHeartRate({
            currentHeartRate,
            power: settings.power,
            elapsedSeconds,
            durationSeconds: maxSimulationSeconds,
            restingHr: settings.restingHr,
            maxHr: settings.maxHr,
            dt: 1
        });

        const progressRatio = route.totalDistanceMeters > 0
            ? Math.min(1, state.distanceMeters / route.totalDistanceMeters)
            : 0;
        const nextRouteSample = getRouteSampleAtDistance(route, state.distanceMeters);
        const elevationMeters = nextRouteSample.elevationMeters ?? state.elevationMeters;

        records.push({
            elapsedSeconds,
            elapsedLabel: formatDuration(elapsedSeconds),
            power: settings.power,
            speedKph: state.speed * 3.6,
            distanceKm: state.distanceMeters / 1000,
            heartRate: Math.round(currentHeartRate),
            gradePercent,
            elevationMeters,
            ascentMeters: state.ascentMeters,
            segmentName: getSegmentAtDistance(route, state.distanceMeters)?.name ?? "终点后",
            routeProgress: progressRatio,
            positionLat: nextRouteSample.latitude,
            positionLong: nextRouteSample.longitude
        });

        if (route.totalDistanceMeters > 0 && state.distanceMeters >= route.totalDistanceMeters) {
            break;
        }
    }

    const metrics = buildRideMetrics({
        records,
        ftp: settings.ftp ?? null
    });
    const startedAt = new Date(new Date(finishedAt).getTime() - metrics.ride.elapsedSeconds * 1000).toISOString();

    return {
        createdAt: finishedAt,
        startedAt,
        finishedAt,
        route,
        settings,
        records,
        summary: createSummary(metrics)
    };
}

function createSummary(metrics) {
    return {
        metrics
    };
}

function clampStateToRouteFinish({ previousState, nextState, route }) {
    const totalDistanceMeters = route?.totalDistanceMeters ?? 0;
    if (totalDistanceMeters <= 0 || nextState.distanceMeters <= totalDistanceMeters) {
        return nextState;
    }

    const previousDistanceMeters = previousState?.distanceMeters ?? 0;
    const stepDistanceMeters = nextState.distanceMeters - previousDistanceMeters;
    const completionRatio = stepDistanceMeters > 0
        ? Math.min(1, Math.max(0, (totalDistanceMeters - previousDistanceMeters) / stepDistanceMeters))
        : 0;
    const routeSample = getRouteSampleAtDistance(route, totalDistanceMeters);

    return {
        ...nextState,
        distanceMeters: totalDistanceMeters,
        elevationMeters: routeSample.elevationMeters ?? interpolateNumber(previousState?.elevationMeters, nextState.elevationMeters, completionRatio),
        ascentMeters: interpolateNumber(previousState?.ascentMeters, nextState.ascentMeters, completionRatio)
    };
}

function interpolateNumber(start, end, ratio) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0);
    }

    return start + (end - start) * ratio;
}

function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
