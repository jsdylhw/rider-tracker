import { getRouteSampleAtDistance, getSegmentAtDistance } from "../route/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";

export function simulateRide({ route, settings }) {
    const records = [];
    const maxSimulationSeconds = 24 * 60 * 60;
    const finishedAt = new Date().toISOString();

    if (!route || route.totalDistanceMeters <= 0) {
        return {
            createdAt: finishedAt,
            startedAt: finishedAt,
            finishedAt,
            route,
            settings,
            records,
            summary: {
                elapsedSeconds: 0,
                distanceKm: 0,
                averageSpeedKph: 0,
                averageHeartRate: settings.restingHr,
                ascentMeters: 0,
                currentGradePercent: 0,
                routeProgress: 0
            }
        };
    }

    let state = {
        speed: 0,
        distanceMeters: 0,
        elevationMeters: 0,
        ascentMeters: 0,
        heartRate: settings.restingHr
    };

    for (let elapsedSeconds = 1; elapsedSeconds <= maxSimulationSeconds; elapsedSeconds += 1) {
        const routeSample = getRouteSampleAtDistance(route, state.distanceMeters);
        const gradePercent = routeSample.gradePercent ?? 0;

        state = simulateStep({
            ...state,
            power: settings.power,
            gradePercent,
            elapsedSeconds,
            settings,
            durationSeconds: maxSimulationSeconds,
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
            heartRate: Math.round(state.heartRate),
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

    const finalRecord = records.at(-1) ?? createEmptyRecord(settings);
    const elapsedSeconds = finalRecord.elapsedSeconds ?? 0;
    const averageHeartRate = records.length > 0
        ? Math.round(records.reduce((sum, record) => sum + record.heartRate, 0) / records.length)
        : settings.restingHr;

    const startedAt = new Date(new Date(finishedAt).getTime() - elapsedSeconds * 1000).toISOString();

    return {
        createdAt: finishedAt,
        startedAt,
        finishedAt,
        route,
        settings,
        records,
        summary: {
            elapsedSeconds,
            distanceKm: finalRecord.distanceKm,
            averageSpeedKph: elapsedSeconds > 0 ? (finalRecord.distanceKm / elapsedSeconds) * 3600 : 0,
            averageHeartRate,
            ascentMeters: finalRecord.ascentMeters,
            currentGradePercent: finalRecord.gradePercent,
            routeProgress: finalRecord.routeProgress
        }
    };
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

function createEmptyRecord(settings) {
    return {
        elapsedSeconds: 0,
        elapsedLabel: "00:00",
        power: settings.power,
        speedKph: 0,
        distanceKm: 0,
        heartRate: settings.restingHr,
        gradePercent: 0,
        elevationMeters: 0,
        ascentMeters: 0,
        segmentName: "未开始",
        routeProgress: 0
    };
}
