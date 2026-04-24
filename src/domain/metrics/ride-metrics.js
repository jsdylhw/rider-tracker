export const DEFAULT_POWER_WINDOW_SECONDS = [3, 10];

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
    const powerValues = collectFiniteValues(records, "power");
    const heartRateValues = collectFiniteValues(records, "heartRate");
    const cadenceValues = collectFiniteValues(records, "cadence");
    const gradeStats = summarizeGrades(records);

    const averagePower = roundAverage(powerValues);
    const normalizedPowerWatts = calculateNormalizedPower(records);
    const intensityFactor = calculateIntensityFactor(normalizedPowerWatts, ftp);
    const variabilityIndex = calculateVariabilityIndex(normalizedPowerWatts, averagePower);

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
            averageWatts: averagePower,
            maxWatts: maxOrDefault(powerValues, 0),
            rolling3sWatts: calculateRollingAverage(records, 3),
            rolling10sWatts: calculateRollingAverage(records, 10),
            windows: Object.fromEntries(
                powerWindowSeconds.map((windowSeconds) => [
                    `${windowSeconds}s`,
                    calculateRollingAverage(records, windowSeconds)
                ])
            ),
            normalizedPowerWatts,
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
        }
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

    return createMetricsFromLegacySummary(summary, options.powerWindowSeconds);
}

function normalizePowerWindows(powerWindowSeconds) {
    const source = Array.isArray(powerWindowSeconds) && powerWindowSeconds.length > 0
        ? powerWindowSeconds
        : DEFAULT_POWER_WINDOW_SECONDS;

    return [...new Set(source
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0))]
        .sort((left, right) => left - right);
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

function calculateRollingAverage(records, windowSeconds) {
    if (!records.length) {
        return 0;
    }

    const finalElapsedSeconds = normalizeFiniteNumber(records.at(-1)?.elapsedSeconds);

    if (!Number.isFinite(finalElapsedSeconds)) {
        return 0;
    }

    const windowStartSeconds = finalElapsedSeconds - windowSeconds;
    const windowValues = records
        .filter((record) => {
            const elapsedSeconds = normalizeFiniteNumber(record?.elapsedSeconds);
            return Number.isFinite(elapsedSeconds) && elapsedSeconds > windowStartSeconds;
        })
        .map((record) => normalizeFiniteNumber(record?.power) ?? 0);

    if (!windowValues.length) {
        return 0;
    }

    return Math.round(windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length);
}

function calculateNormalizedPower(records) {
    if (!records.length) {
        return 0;
    }

    const rolling30s = records.map((_record, index) => {
        const partialRecords = records.slice(0, index + 1);
        return calculateRollingAverage(partialRecords, 30);
    });

    const validRolling = rolling30s.filter((value) => Number.isFinite(value) && value > 0);

    if (!validRolling.length) {
        return 0;
    }

    const fourthPowerAverage = validRolling.reduce((sum, value) => sum + (value ** 4), 0) / validRolling.length;
    return Math.round(fourthPowerAverage ** 0.25);
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

function createMetricsFromLegacySummary(summary, powerWindowSeconds = DEFAULT_POWER_WINDOW_SECONDS) {
    const emptyMetrics = createEmptyRideMetrics(powerWindowSeconds);

    if (!summary) {
        return emptyMetrics;
    }

    return {
        ride: {
            elapsedSeconds: normalizeFiniteNumber(summary.elapsedSeconds) ?? 0,
            distanceKm: normalizeFiniteNumber(summary.distanceKm) ?? 0,
            ascentMeters: normalizeFiniteNumber(summary.ascentMeters) ?? 0,
            currentGradePercent: normalizeFiniteNumber(summary.currentGradePercent) ?? 0,
            routeProgress: normalizeFiniteNumber(summary.routeProgress) ?? 0,
            currentTargetPowerWatts: normalizeFiniteNumber(summary.currentTargetPowerWatts),
            currentTargetFtpPercent: normalizeFiniteNumber(summary.currentTargetFtpPercent),
            currentTargetStepLabel: summary.currentTargetStepLabel ?? null
        },
        speed: {
            currentKph: normalizeFiniteNumber(summary.currentSpeedKph) ?? 0,
            averageKph: normalizeFiniteNumber(summary.averageSpeedKph) ?? 0,
            maxKph: normalizeFiniteNumber(summary.maxSpeedKph) ?? 0
        },
        power: {
            currentWatts: normalizeFiniteNumber(summary.currentPower) ?? 0,
            averageWatts: normalizeFiniteNumber(summary.averagePower) ?? 0,
            maxWatts: normalizeFiniteNumber(summary.maxPower) ?? 0,
            rolling3sWatts: normalizeFiniteNumber(summary.rolling3sPower) ?? 0,
            rolling10sWatts: normalizeFiniteNumber(summary.rolling10sPower) ?? 0,
            windows: {
                ...emptyMetrics.power.windows,
                "3s": normalizeFiniteNumber(summary.rolling3sPower) ?? 0,
                "10s": normalizeFiniteNumber(summary.rolling10sPower) ?? 0
            },
            normalizedPowerWatts: normalizeFiniteNumber(summary.normalizedPower) ?? 0,
            intensityFactor: normalizeFiniteNumber(summary.intensityFactor),
            variabilityIndex: normalizeFiniteNumber(summary.variabilityIndex)
        },
        heartRate: {
            currentBpm: normalizeFiniteNumber(summary.currentHeartRate) ?? 0,
            averageBpm: normalizeFiniteNumber(summary.averageHeartRate) ?? 0,
            maxBpm: normalizeFiniteNumber(summary.maxHeartRate) ?? 0
        },
        cadence: {
            currentRpm: normalizeFiniteNumber(summary.currentCadence),
            averageRpm: normalizeFiniteNumber(summary.averageCadence),
            maxRpm: normalizeFiniteNumber(summary.maxCadence)
        },
        grade: {
            ...emptyMetrics.grade,
            currentPercent: normalizeFiniteNumber(summary.currentGradePercent) ?? 0
        },
        load: {
            estimatedTss: normalizeFiniteNumber(summary.estimatedTss) ?? 0
        }
    };
}
