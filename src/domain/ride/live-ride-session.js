import { getRouteSampleAtDistance, getSegmentAtDistance } from "../route/route-builder.js";
import { simulateStep } from "../physics/cycling-model.js";
import {
    advanceLiveHeartRateState,
    createInitialLiveHeartRateState
} from "../physiology/heart-rate-model.js";
import { buildRideMetrics, createEmptyRideMetrics } from "../metrics/ride-metrics.js";
import { DEFAULT_POWER_WINDOW_SECONDS, summarizePowerMetrics } from "../metrics/power-metrics.js";

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

    const previousRecord = records.at(-1) ?? null;
    const nextRecords = [...records, record];
    const nextSummary = buildIncrementalSummary({
        previousSummary: summary,
        previousRecord,
        record,
        records: nextRecords,
        settings: session.settings
    });

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
    return createSummary(metrics, buildSummaryStatsFromRecords(records));
}

function buildIncrementalSummary({
    previousSummary,
    previousRecord,
    record,
    records,
    settings = {}
}) {
    const stats = updateSummaryStats(
        previousSummary?.stats ?? buildSummaryStatsFromRecords(records.slice(0, -1)),
        record,
        previousRecord
    );
    const powerMetrics = summarizePowerMetrics({
        records,
        powerWindowSeconds: DEFAULT_POWER_WINDOW_SECONDS
    });
    const intensityFactor = calculateIntensityFactor(powerMetrics.normalizedPowerWatts, settings.ftp);
    const variabilityIndex = calculateVariabilityIndex(powerMetrics.normalizedPowerWatts, stats.power.averageWatts);
    const elapsedSeconds = normalizeFiniteNumber(record?.elapsedSeconds) ?? 0;
    const metrics = {
        ride: {
            elapsedSeconds,
            distanceKm: normalizeFiniteNumber(record?.distanceKm) ?? 0,
            ascentMeters: normalizeFiniteNumber(record?.ascentMeters) ?? 0,
            currentGradePercent: normalizeFiniteNumber(record?.gradePercent) ?? 0,
            routeProgress: normalizeFiniteNumber(record?.routeProgress) ?? 0,
            currentTargetPowerWatts: normalizeFiniteNumber(record?.targetPowerWatts),
            currentTargetFtpPercent: normalizeFiniteNumber(record?.targetFtpPercent),
            currentTargetStepLabel: record?.targetStepLabel ?? null
        },
        speed: {
            currentKph: normalizeFiniteNumber(record?.speedKph) ?? 0,
            averageKph: elapsedSeconds > 0 ? ((normalizeFiniteNumber(record?.distanceKm) ?? 0) / elapsedSeconds) * 3600 : 0,
            maxKph: stats.speed.maxKph
        },
        power: {
            currentWatts: normalizeFiniteNumber(record?.power) ?? 0,
            averageWatts: stats.power.averageWatts,
            maxWatts: stats.power.maxWatts,
            rolling3sWatts: powerMetrics.rolling3sWatts,
            rolling10sWatts: powerMetrics.rolling10sWatts,
            windows: powerMetrics.windows,
            normalizedPowerWatts: powerMetrics.normalizedPowerWatts,
            intensityFactor,
            variabilityIndex
        },
        heartRate: {
            currentBpm: normalizeFiniteNumber(record?.heartRate) ?? 0,
            averageBpm: stats.heartRate.averageBpm,
            maxBpm: stats.heartRate.maxBpm
        },
        cadence: {
            currentRpm: normalizeFiniteNumber(record?.cadence),
            averageRpm: stats.cadence.averageRpm,
            maxRpm: stats.cadence.maxRpm
        },
        grade: stats.grade.metrics,
        load: {
            estimatedTss: calculateEstimatedTss({
                intensityFactor,
                elapsedSeconds
            })
        },
        energy: {
            mechanicalWorkKj: stats.energy.joules / 1000,
            estimatedCaloriesKcal: stats.energy.joules / 1000,
            method: "power"
        }
    };

    return createSummary(metrics, stats);
}

function createEmptySummary(metrics = createEmptyRideMetrics()) {
    return createSummary(metrics, createEmptySummaryStats());
}

function createSummary(metrics, stats = createEmptySummaryStats()) {
    return {
        metrics,
        stats
    };
}

function createEmptySummaryStats() {
    return {
        power: {
            sumWatts: 0,
            count: 0,
            maxWatts: 0,
            averageWatts: 0
        },
        heartRate: {
            sumBpm: 0,
            count: 0,
            maxBpm: 0,
            averageBpm: 0
        },
        cadence: {
            sumRpm: 0,
            count: 0,
            maxRpm: null,
            averageRpm: null
        },
        speed: {
            maxKph: 0
        },
        grade: {
            sumPercent: 0,
            count: 0,
            positiveSumPercent: 0,
            positiveCount: 0,
            negativeSumPercent: 0,
            negativeCount: 0,
            maxPositivePercent: 0,
            maxNegativePercent: 0,
            metrics: {
                currentPercent: 0,
                averagePercent: 0,
                averagePositivePercent: 0,
                averageNegativePercent: 0,
                maxPositivePercent: 0,
                maxNegativePercent: 0
            }
        },
        energy: {
            joules: 0
        }
    };
}

function buildSummaryStatsFromRecords(records = []) {
    return records.reduce((stats, record, index) => (
        updateSummaryStats(stats, record, records[index - 1] ?? null)
    ), createEmptySummaryStats());
}

function updateSummaryStats(previousStats, record, previousRecord) {
    const stats = cloneSummaryStats(previousStats);
    const power = normalizeFiniteNumber(record?.power);
    if (power !== null) {
        stats.power.sumWatts += power;
        stats.power.count += 1;
        stats.power.maxWatts = Math.max(stats.power.maxWatts, power);
        stats.power.averageWatts = Math.round(stats.power.sumWatts / stats.power.count);
    }

    const heartRate = normalizeFiniteNumber(record?.heartRate);
    if (heartRate !== null) {
        stats.heartRate.sumBpm += heartRate;
        stats.heartRate.count += 1;
        stats.heartRate.maxBpm = Math.max(stats.heartRate.maxBpm, heartRate);
        stats.heartRate.averageBpm = Math.round(stats.heartRate.sumBpm / stats.heartRate.count);
    }

    const cadence = normalizeFiniteNumber(record?.cadence);
    if (cadence !== null) {
        stats.cadence.sumRpm += cadence;
        stats.cadence.count += 1;
        stats.cadence.maxRpm = stats.cadence.maxRpm === null
            ? cadence
            : Math.max(stats.cadence.maxRpm, cadence);
        stats.cadence.averageRpm = Math.round(stats.cadence.sumRpm / stats.cadence.count);
    }

    const speed = normalizeFiniteNumber(record?.speedKph);
    if (speed !== null) {
        stats.speed.maxKph = Math.max(stats.speed.maxKph, speed);
    }

    updateGradeStats(stats.grade, record);
    updateEnergyStats(stats.energy, record, previousRecord);

    return stats;
}

function cloneSummaryStats(stats = createEmptySummaryStats()) {
    return {
        power: { ...stats.power },
        heartRate: { ...stats.heartRate },
        cadence: { ...stats.cadence },
        speed: { ...stats.speed },
        grade: {
            ...stats.grade,
            metrics: { ...stats.grade.metrics }
        },
        energy: { ...stats.energy }
    };
}

function updateGradeStats(gradeStats, record) {
    const grade = normalizeFiniteNumber(record?.gradePercent) ?? 0;
    gradeStats.sumPercent += grade;
    gradeStats.count += 1;

    if (grade > 0) {
        gradeStats.positiveSumPercent += grade;
        gradeStats.positiveCount += 1;
        gradeStats.maxPositivePercent = Math.max(gradeStats.maxPositivePercent, grade);
    }

    if (grade < 0) {
        gradeStats.negativeSumPercent += grade;
        gradeStats.negativeCount += 1;
        gradeStats.maxNegativePercent = Math.min(gradeStats.maxNegativePercent, grade);
    }

    gradeStats.metrics = {
        currentPercent: grade,
        averagePercent: gradeStats.count > 0 ? gradeStats.sumPercent / gradeStats.count : 0,
        averagePositivePercent: gradeStats.positiveCount > 0 ? gradeStats.positiveSumPercent / gradeStats.positiveCount : 0,
        averageNegativePercent: gradeStats.negativeCount > 0 ? gradeStats.negativeSumPercent / gradeStats.negativeCount : 0,
        maxPositivePercent: gradeStats.maxPositivePercent,
        maxNegativePercent: gradeStats.maxNegativePercent
    };
}

function updateEnergyStats(energyStats, record, previousRecord) {
    const power = normalizeFiniteNumber(record?.power);
    const elapsed = normalizeFiniteNumber(record?.elapsedSeconds);
    const previousElapsed = normalizeFiniteNumber(previousRecord?.elapsedSeconds);
    if (power === null || elapsed === null || previousElapsed === null || elapsed <= previousElapsed) {
        return;
    }

    energyStats.joules += power * (elapsed - previousElapsed);
}

function normalizeFiniteNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function calculateIntensityFactor(normalizedPowerWatts, ftp) {
    if (!Number.isFinite(ftp) || ftp <= 0 || !Number.isFinite(normalizedPowerWatts) || normalizedPowerWatts <= 0) {
        return null;
    }

    return normalizedPowerWatts / ftp;
}

function calculateVariabilityIndex(normalizedPowerWatts, averagePowerWatts) {
    if (!Number.isFinite(normalizedPowerWatts) || normalizedPowerWatts <= 0 || !Number.isFinite(averagePowerWatts) || averagePowerWatts <= 0) {
        return null;
    }

    return normalizedPowerWatts / averagePowerWatts;
}

function calculateEstimatedTss({ intensityFactor, elapsedSeconds }) {
    if (!Number.isFinite(intensityFactor) || intensityFactor <= 0 || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
        return 0;
    }

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
