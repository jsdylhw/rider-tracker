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
            summary: {
                elapsedSeconds: metrics.ride.elapsedSeconds,
                distanceKm: metrics.ride.distanceKm,
                averageSpeedKph: metrics.speed.averageKph,
                maxSpeedKph: metrics.speed.maxKph,
                averageHeartRate: settings.restingHr,
                maxHeartRate: metrics.heartRate.maxBpm,
                averagePower: metrics.power.averageWatts,
                maxPower: metrics.power.maxWatts,
                rolling3sPower: metrics.power.rolling3sWatts,
                rolling10sPower: metrics.power.rolling10sWatts,
                normalizedPower: metrics.power.normalizedPowerWatts,
                intensityFactor: metrics.power.intensityFactor,
                variabilityIndex: metrics.power.variabilityIndex,
                averageCadence: metrics.cadence.averageRpm,
                maxCadence: metrics.cadence.maxRpm,
                averageGradePercent: metrics.grade.averagePercent,
                averagePositiveGradePercent: metrics.grade.averagePositivePercent,
                averageNegativeGradePercent: metrics.grade.averageNegativePercent,
                maxPositiveGradePercent: metrics.grade.maxPositivePercent,
                maxNegativeGradePercent: metrics.grade.maxNegativePercent,
                estimatedTss: metrics.load.estimatedTss,
                ascentMeters: metrics.ride.ascentMeters,
                currentGradePercent: metrics.ride.currentGradePercent,
                routeProgress: metrics.ride.routeProgress,
                currentSpeedKph: metrics.speed.currentKph,
                currentPower: metrics.power.currentWatts,
                currentHeartRate: settings.restingHr,
                currentCadence: metrics.cadence.currentRpm,
                currentTargetPowerWatts: metrics.ride.currentTargetPowerWatts,
                currentTargetFtpPercent: metrics.ride.currentTargetFtpPercent,
                currentTargetStepLabel: metrics.ride.currentTargetStepLabel,
                metrics
            }
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

        state = simulateStep({
            ...state,
            power: settings.power,
            gradePercent,
            elapsedSeconds,
            settings,
            durationSeconds: maxSimulationSeconds,
            dt: 1
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
    const averageHeartRate = records.length > 0 ? metrics.heartRate.averageBpm : settings.restingHr;

    const startedAt = new Date(new Date(finishedAt).getTime() - metrics.ride.elapsedSeconds * 1000).toISOString();

    return {
        createdAt: finishedAt,
        startedAt,
        finishedAt,
        route,
        settings,
        records,
        summary: {
            elapsedSeconds: metrics.ride.elapsedSeconds,
            distanceKm: metrics.ride.distanceKm,
            averageSpeedKph: metrics.speed.averageKph,
            maxSpeedKph: metrics.speed.maxKph,
            averageHeartRate,
            maxHeartRate: metrics.heartRate.maxBpm,
            averagePower: metrics.power.averageWatts,
            maxPower: metrics.power.maxWatts,
            rolling3sPower: metrics.power.rolling3sWatts,
            rolling10sPower: metrics.power.rolling10sWatts,
            normalizedPower: metrics.power.normalizedPowerWatts,
            intensityFactor: metrics.power.intensityFactor,
            variabilityIndex: metrics.power.variabilityIndex,
            averageCadence: metrics.cadence.averageRpm,
            maxCadence: metrics.cadence.maxRpm,
            averageGradePercent: metrics.grade.averagePercent,
            averagePositiveGradePercent: metrics.grade.averagePositivePercent,
            averageNegativeGradePercent: metrics.grade.averageNegativePercent,
            maxPositiveGradePercent: metrics.grade.maxPositivePercent,
            maxNegativeGradePercent: metrics.grade.maxNegativePercent,
            estimatedTss: metrics.load.estimatedTss,
            ascentMeters: metrics.ride.ascentMeters,
            currentGradePercent: metrics.ride.currentGradePercent,
            routeProgress: metrics.ride.routeProgress,
            currentSpeedKph: metrics.speed.currentKph,
            currentPower: metrics.power.currentWatts,
            currentHeartRate: metrics.heartRate.currentBpm,
            currentCadence: metrics.cadence.currentRpm,
            currentTargetPowerWatts: metrics.ride.currentTargetPowerWatts,
            currentTargetFtpPercent: metrics.ride.currentTargetFtpPercent,
            currentTargetStepLabel: metrics.ride.currentTargetStepLabel,
            metrics
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
