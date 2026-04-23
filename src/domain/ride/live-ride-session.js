import { getRouteSampleAtDistance, getSegmentAtDistance } from "../route/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";
import {
    advanceLiveHeartRateState,
    createInitialLiveHeartRateState
} from "../physiology/heart-rate-model.js";

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
    if (records.length === 0) {
        return createEmptySummary();
    }

    const finalRecord = records.at(-1);
    const averageHeartRate = Math.round(records.reduce((sum, record) => sum + (record.heartRate ?? 0), 0) / records.length);
    const averagePower = Math.round(records.reduce((sum, record) => sum + (record.power ?? 0), 0) / records.length);
    const maxPower = Math.max(...records.map((record) => record.power ?? 0), 0);
    const cadenceValues = records.filter((record) => typeof record.cadence === "number");
    const averageCadence = cadenceValues.length > 0
        ? Math.round(cadenceValues.reduce((sum, record) => sum + record.cadence, 0) / cadenceValues.length)
        : null;
    const estimatedTss = calculateEstimatedTss({
        averagePower,
        elapsedSeconds: finalRecord.elapsedSeconds,
        ftp: settings.ftp ?? null
    });

    return {
        elapsedSeconds: finalRecord.elapsedSeconds,
        distanceKm: finalRecord.distanceKm,
        averageSpeedKph: finalRecord.elapsedSeconds > 0 ? (finalRecord.distanceKm / finalRecord.elapsedSeconds) * 3600 : 0,
        averageHeartRate,
        averagePower,
        maxPower,
        averageCadence,
        estimatedTss,
        ascentMeters: finalRecord.ascentMeters,
        currentGradePercent: finalRecord.gradePercent,
        routeProgress: finalRecord.routeProgress,
        currentSpeedKph: finalRecord.speedKph,
        currentPower: finalRecord.power,
        currentHeartRate: finalRecord.heartRate,
        currentTargetPowerWatts: finalRecord.targetPowerWatts ?? null,
        currentTargetFtpPercent: finalRecord.targetFtpPercent ?? null,
        currentTargetStepLabel: finalRecord.targetStepLabel ?? null
    };
}

function createEmptySummary() {
    return {
        elapsedSeconds: 0,
        distanceKm: 0,
        averageSpeedKph: 0,
        averageHeartRate: 0,
        averagePower: 0,
        maxPower: 0,
        averageCadence: null,
        estimatedTss: 0,
        ascentMeters: 0,
        currentGradePercent: 0,
        routeProgress: 0,
        currentSpeedKph: 0,
        currentPower: 0,
        currentHeartRate: 0,
        currentTargetPowerWatts: null,
        currentTargetFtpPercent: null,
        currentTargetStepLabel: null
    };
}

function calculateEstimatedTss({ averagePower, elapsedSeconds, ftp }) {
    if (!ftp || ftp <= 0 || elapsedSeconds <= 0) {
        return 0;
    }

    const intensityFactor = averagePower / ftp;
    const durationHours = elapsedSeconds / 3600;
    return durationHours * intensityFactor * intensityFactor * 100;
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
