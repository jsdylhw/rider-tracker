import {
    DEFAULT_POWER_WINDOW_SECONDS,
    normalizePowerWindows,
    summarizePowerMetrics
} from "./power-metrics.js";

export function buildRideMetrics({
    records = [],
    ftp = null,
    options = {}
} = {}) {
    const powerWindowSeconds = normalizePowerWindows(options.powerWindowSeconds);

    if (!records.length) {
        return createEmptyRideMetrics(powerWindowSeconds);
    }

    const finalRecord = records.at(-1);
    const elapsedSeconds = normalizeFiniteNumber(finalRecord?.elapsedSeconds) ?? 0;
    const distanceKm = normalizeFiniteNumber(finalRecord?.distanceKm) ?? 0;
    const ascentMeters = normalizeFiniteNumber(finalRecord?.ascentMeters) ?? 0;
    const currentGradePercent = normalizeFiniteNumber(finalRecord?.gradePercent) ?? 0;
    const routeProgress = normalizeFiniteNumber(finalRecord?.routeProgress) ?? 0;

    const speedValues = collectFiniteValues(records, "speedKph");
    const heartRateValues = collectFiniteValues(records, "heartRate");
    const cadenceValues = collectFiniteValues(records, "cadence");
    const gradeStats = summarizeGrades(records);
    const powerMetrics = summarizePowerMetrics({
        records,
        powerWindowSeconds
    });
    const intensityFactor = calculateIntensityFactor(powerMetrics.normalizedPowerWatts, ftp);
    const variabilityIndex = calculateVariabilityIndex(powerMetrics.normalizedPowerWatts, powerMetrics.averageWatts);
    const energyMetrics = calculateEnergyMetrics(records);

    return {
        ride: {
            elapsedSeconds,
            distanceKm,
            ascentMeters,
            currentGradePercent,
            routeProgress,
            currentTargetPowerWatts: normalizeFiniteNumber(finalRecord?.targetPowerWatts),
            currentTargetFtpPercent: normalizeFiniteNumber(finalRecord?.targetFtpPercent),
            currentTargetStepLabel: finalRecord?.targetStepLabel ?? null
        },
        speed: {
            currentKph: normalizeFiniteNumber(finalRecord?.speedKph) ?? 0,
            averageKph: elapsedSeconds > 0 ? (distanceKm / elapsedSeconds) * 3600 : 0,
            maxKph: maxOrDefault(speedValues, 0)
        },
        power: {
            currentWatts: normalizeFiniteNumber(finalRecord?.power) ?? 0,
            averageWatts: powerMetrics.averageWatts,
            maxWatts: powerMetrics.maxWatts,
            rolling3sWatts: powerMetrics.rolling3sWatts,
            rolling10sWatts: powerMetrics.rolling10sWatts,
            windows: powerMetrics.windows,
            normalizedPowerWatts: powerMetrics.normalizedPowerWatts,
            intensityFactor,
            variabilityIndex
        },
        heartRate: {
            currentBpm: normalizeFiniteNumber(finalRecord?.heartRate) ?? 0,
            averageBpm: roundAverage(heartRateValues),
            maxBpm: maxOrDefault(heartRateValues, 0)
        },
        cadence: {
            currentRpm: normalizeFiniteNumber(finalRecord?.cadence),
            averageRpm: roundAverageOrNull(cadenceValues),
            maxRpm: maxOrDefaultOrNull(cadenceValues)
        },
        grade: gradeStats,
        load: {
            estimatedTss: calculateEstimatedTss({
                intensityFactor,
                elapsedSeconds
            })
        },
        energy: energyMetrics
    };
}

export function createEmptyRideMetrics(powerWindowSeconds = DEFAULT_POWER_WINDOW_SECONDS) {
    const normalizedWindows = normalizePowerWindows(powerWindowSeconds);

    return {
        ride: {
            elapsedSeconds: 0,
            distanceKm: 0,
            ascentMeters: 0,
            currentGradePercent: 0,
            routeProgress: 0,
            currentTargetPowerWatts: null,
            currentTargetFtpPercent: null,
            currentTargetStepLabel: null
        },
        speed: {
            currentKph: 0,
            averageKph: 0,
            maxKph: 0
        },
        power: {
            currentWatts: 0,
            averageWatts: 0,
            maxWatts: 0,
            rolling3sWatts: 0,
            rolling10sWatts: 0,
            windows: Object.fromEntries(normalizedWindows.map((windowSeconds) => [`${windowSeconds}s`, 0])),
            normalizedPowerWatts: 0,
            intensityFactor: null,
            variabilityIndex: null
        },
        heartRate: {
            currentBpm: 0,
            averageBpm: 0,
            maxBpm: 0
        },
        cadence: {
            currentRpm: null,
            averageRpm: null,
            maxRpm: null
        },
        grade: {
            currentPercent: 0,
            averagePercent: 0,
            averagePositivePercent: 0,
            averageNegativePercent: 0,
            maxPositivePercent: 0,
            maxNegativePercent: 0
        },
        load: {
            estimatedTss: 0
        },
        energy: {
            mechanicalWorkKj: 0,
            estimatedCaloriesKcal: 0,
            method: "power"
        }
    };
}

export function resolveRideMetrics({
    summary = null,
    records = [],
    ftp = null,
    options = {}
} = {}) {
    if (summary?.metrics) {
        return summary.metrics;
    }

    if (records.length > 0) {
        return buildRideMetrics({
            records,
            ftp,
            options
        });
    }

    return createEmptyRideMetrics(options.powerWindowSeconds);
}

function collectFiniteValues(records, key) {
    return records
        .map((record) => normalizeFiniteNumber(record?.[key]))
        .filter((value) => value !== null);
}

function normalizeFiniteNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function roundAverage(values) {
    if (!values.length) {
        return 0;
    }

    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundAverageOrNull(values) {
    if (!values.length) {
        return null;
    }

    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maxOrDefault(values, defaultValue) {
    return values.length ? Math.max(...values) : defaultValue;
}

function maxOrDefaultOrNull(values) {
    return values.length ? Math.max(...values) : null;
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

function calculateEnergyMetrics(records) {
    if (!records.length) {
        return {
            mechanicalWorkKj: 0,
            estimatedCaloriesKcal: 0,
            method: "power"
        };
    }

    let joules = 0;
    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        const power = normalizeFiniteNumber(current?.power);
        const elapsed = normalizeFiniteNumber(current?.elapsedSeconds);
        const previousElapsed = normalizeFiniteNumber(previous?.elapsedSeconds);
        if (power === null || elapsed === null || previousElapsed === null || elapsed <= previousElapsed) {
            continue;
        }
        joules += power * (elapsed - previousElapsed);
    }

    const mechanicalWorkKj = joules / 1000;
    return {
        mechanicalWorkKj,
        estimatedCaloriesKcal: mechanicalWorkKj,
        method: "power"
    };
}

function summarizeGrades(records) {
    if (!records.length) {
        return {
            currentPercent: 0,
            averagePercent: 0,
            averagePositivePercent: 0,
            averageNegativePercent: 0,
            maxPositivePercent: 0,
            maxNegativePercent: 0
        };
    }

    const gradeValues = records.map((record) => normalizeFiniteNumber(record?.gradePercent) ?? 0);
    const positiveGrades = gradeValues.filter((grade) => grade > 0);
    const negativeGrades = gradeValues.filter((grade) => grade < 0);

    return {
        currentPercent: gradeValues.at(-1) ?? 0,
        averagePercent: averageOrDefault(gradeValues, 0),
        averagePositivePercent: averageOrDefault(positiveGrades, 0),
        averageNegativePercent: averageOrDefault(negativeGrades, 0),
        maxPositivePercent: positiveGrades.length > 0 ? Math.max(...positiveGrades) : 0,
        maxNegativePercent: negativeGrades.length > 0 ? Math.min(...negativeGrades) : 0
    };
}

function averageOrDefault(values, defaultValue) {
    if (!values.length) {
        return defaultValue;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
