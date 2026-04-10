import { getSegmentAtDistance } from "../course/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";

export function simulateRide({ route, settings }) {
    const durationSeconds = Math.round(settings.durationMinutes * 60);
    const records = [];

    let state = {
        speed: 0,
        distanceMeters: 0,
        elevationMeters: 0,
        ascentMeters: 0,
        heartRate: settings.restingHr
    };

    for (let elapsedSeconds = 1; elapsedSeconds <= durationSeconds; elapsedSeconds += 1) {
        const segment = getSegmentAtDistance(route, state.distanceMeters);
        const gradePercent = segment?.gradePercent ?? 0;

        state = simulateStep({
            ...state,
            power: settings.power,
            gradePercent,
            elapsedSeconds,
            settings,
            durationSeconds,
            dt: 1
        });

        const progressRatio = route.totalDistanceMeters > 0
            ? Math.min(1, state.distanceMeters / route.totalDistanceMeters)
            : 0;

        records.push({
            elapsedSeconds,
            elapsedLabel: formatDuration(elapsedSeconds),
            power: settings.power,
            speedKph: state.speed * 3.6,
            distanceKm: state.distanceMeters / 1000,
            heartRate: Math.round(state.heartRate),
            gradePercent,
            elevationMeters: state.elevationMeters,
            ascentMeters: state.ascentMeters,
            segmentName: segment?.name ?? "终点后",
            routeProgress: progressRatio
        });
    }

    const finalRecord = records.at(-1) ?? createEmptyRecord(settings);
    const averageHeartRate = records.length > 0
        ? Math.round(records.reduce((sum, record) => sum + record.heartRate, 0) / records.length)
        : settings.restingHr;

    return {
        createdAt: new Date().toISOString(),
        route,
        settings,
        records,
        summary: {
            elapsedSeconds: durationSeconds,
            distanceKm: finalRecord.distanceKm,
            averageSpeedKph: durationSeconds > 0 ? (finalRecord.distanceKm / durationSeconds) * 3600 : 0,
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
