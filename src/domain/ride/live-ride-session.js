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

export function advanceLiveRideSession({
    session,
    records = session.records ?? [],
    summary = session.summary ?? createEmptySummary(),
    power,
    heartRate,
    cadence,
    workoutTarget = null,
    dt = 1
}) {
    const elapsedSeconds = (summary.metrics?.ride?.elapsedSeconds ?? 0) + dt;
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

    const nextRecords = [...records, record];
    const nextSummary = buildSummary(nextRecords, session.settings);

    return {
        ...session,
        records: nextRecords,
        physicsState: nextState,
        heartRateState: nextHeartRateState,
        summary: nextSummary
    };
}

export function stripLiveRideSessionHistory(session) {
    if (!session) return null;

    const { records, summary, ...currentSession } = session;
    return currentSession;
}

export function buildRideActivitySession({ session, records = [], summary = null }) {
    if (!session) return null;

    return {
        ...session,
        records,
        summary: summary ?? buildSummary(records, session.settings)
    };
}

function buildSummary(records, settings = {}) {
    const metrics = records.length > 0
        ? buildRideMetrics({
            records,
            ftp: settings.ftp ?? null
        })
        : createEmptyRideMetrics();
    return createSummary(metrics);
}

function createEmptySummary(metrics = createEmptyRideMetrics()) {
    return {
        metrics
    };
}

function createSummary(metrics) {
    return {
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
