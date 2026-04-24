import { getRouteSampleAtDistance, getSegmentAtDistance } from "../route/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";
import {
    advanceLiveHeartRateState,
    createInitialLiveHeartRateState
} from "../physiology/heart-rate-model.js";
import { buildRideMetrics, createEmptyRideMetrics } from "../metrics/ride-metrics.js";

export function createLiveRideSession({ route, settings, startedAt, initialHeartRate = null }) {
    return {
        createdAt: startedAt,
        startedAt,
        route,
        settings,
        records: [],
        summary: createEmptySummary(),
        physicsState: {
            speed: 0,
            distanceMeters: 0,
            elevationMeters: 0,
            ascentMeters: 0
        },
        heartRateState: createInitialLiveHeartRateState({
            initialHeartRate,
            restingHr: settings.restingHr
        })
    };
}

export function advanceLiveRideSession({ session, power, heartRate, cadence, workoutTarget = null, dt = 1 }) {
    const elapsedSeconds = (session.summary.elapsedSeconds ?? 0) + dt;
    const routeSample = getRouteSampleAtDistance(session.route, session.physicsState.distanceMeters);
    const gradePercent = routeSample.gradePercent ?? 0;
    const nextHeartRateState = advanceLiveHeartRateState({
        currentState: session.heartRateState,
        sampledHeartRate: heartRate,
        restingHr: session.settings.restingHr
    });
    
    const nextState = simulateStep({
        ...session.physicsState,
        power,
        gradePercent,
        elapsedSeconds,
        settings: session.settings,
        durationSeconds: Math.max(elapsedSeconds, dt),
        dt
    });

    const resolvedHeartRate = nextHeartRateState.currentHeartRate;
    const progressRatio = session.route.totalDistanceMeters > 0
        ? Math.min(1, nextState.distanceMeters / session.route.totalDistanceMeters)
        : 0;
    const nextRouteSample = getRouteSampleAtDistance(session.route, nextState.distanceMeters);
    const elevationMeters = nextRouteSample.elevationMeters ?? nextState.elevationMeters;

    const record = {
        elapsedSeconds,
        elapsedLabel: formatDuration(elapsedSeconds),
        power,
        cadence,
        speedKph: nextState.speed * 3.6,
        distanceKm: nextState.distanceMeters / 1000,
        heartRate: resolvedHeartRate,
        gradePercent,
        elevationMeters,
        ascentMeters: nextState.ascentMeters,
        targetPowerWatts: workoutTarget?.targetPowerWatts ?? null,
        targetFtpPercent: workoutTarget?.ftpPercent ?? null,
        targetStepIndex: workoutTarget?.stepIndex ?? null,
        targetStepLabel: workoutTarget?.stepLabel ?? null,
        segmentName: getSegmentAtDistance(session.route, nextState.distanceMeters)?.name ?? "终点后",
        routeProgress: progressRatio,
        positionLat: nextRouteSample.latitude,
        positionLong: nextRouteSample.longitude
    };

    const records = [...session.records, record];

    return {
        ...session,
        records,
        physicsState: nextState,
        heartRateState: nextHeartRateState,
        summary: buildSummary(records, session.settings)
    };
}

function buildSummary(records, settings = {}) {
    const metrics = records.length > 0
        ? buildRideMetrics({
            records,
            ftp: settings.ftp ?? null
        })
        : createEmptyRideMetrics();

    const finalRecord = records.at(-1) ?? null;

    if (!finalRecord) {
        return createEmptySummary(metrics);
    }

    return {
        elapsedSeconds: metrics.ride.elapsedSeconds,
        distanceKm: metrics.ride.distanceKm,
        averageSpeedKph: metrics.speed.averageKph,
        maxSpeedKph: metrics.speed.maxKph,
        averageHeartRate: metrics.heartRate.averageBpm,
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
    };
}

function createEmptySummary(metrics = createEmptyRideMetrics()) {
    return {
        elapsedSeconds: 0,
        distanceKm: 0,
        averageSpeedKph: 0,
        maxSpeedKph: 0,
        averageHeartRate: 0,
        maxHeartRate: 0,
        averagePower: 0,
        maxPower: 0,
        rolling3sPower: 0,
        rolling10sPower: 0,
        normalizedPower: 0,
        intensityFactor: null,
        variabilityIndex: null,
        averageCadence: null,
        maxCadence: null,
        averageGradePercent: 0,
        averagePositiveGradePercent: 0,
        averageNegativeGradePercent: 0,
        maxPositiveGradePercent: 0,
        maxNegativeGradePercent: 0,
        estimatedTss: 0,
        ascentMeters: 0,
        currentGradePercent: 0,
        routeProgress: 0,
        currentSpeedKph: 0,
        currentPower: 0,
        currentHeartRate: 0,
        currentCadence: null,
        currentTargetPowerWatts: null,
        currentTargetFtpPercent: null,
        currentTargetStepLabel: null,
        metrics
    };
}

function formatDuration(totalSeconds) {
    const safeTotalSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(safeTotalSeconds / 3600);
    const minutes = Math.floor((safeTotalSeconds % 3600) / 60);
    const seconds = safeTotalSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
