export const SENSOR_STALE_THRESHOLD_MS = 4000;
const SIGNAL_ESTIMATE_ALPHA = 0.35;
const MIN_STABLE_INTERVAL_SAMPLES = 4;

export function createInitialSensorSamplingState() {
    return {
        heartRate: {
            value: null,
            timestamp: null
        },
        power: {
            value: null,
            timestamp: null,
            sourceType: "none",
            sampleCount: 0,
            total: 0,
            average: null,
            lastIntervalMs: null,
            intervalSampleCount: 0,
            estimatedIntervalMs: null,
            estimatedHz: null,
            jitterMs: null,
            isSignalStable: false
        },
        cadence: {
            value: null,
            timestamp: null,
            sourceType: "none"
        },
        lastUpdated: null
    };
}

export function ingestHeartRateSample(samplingState, data) {
    const timestamp = resolveTimestamp(data?.timestamp);

    return {
        ...samplingState,
        heartRate: {
            value: normalizeFiniteNumber(data?.heartRate),
            timestamp
        },
        lastUpdated: timestamp
    };
}

export function clearHeartRateSample(samplingState) {
    return {
        ...samplingState,
        heartRate: {
            value: null,
            timestamp: null
        },
        lastUpdated: Date.now()
    };
}

export function ingestPowerSample(samplingState, data) {
    const timestamp = resolveTimestamp(data?.timestamp);
    const sourceType = data?.sourceType ?? "none";
    const powerValue = sourceType === "none" ? null : normalizeFiniteNumber(data?.power);
    const cadenceValue = sourceType === "none" ? null : normalizeFiniteNumber(data?.cadence);

    if (sourceType === "none") {
        return clearPowerSample({
            ...samplingState,
            lastUpdated: timestamp
        });
    }

    const hasPowerSample = powerValue !== null;
    const nextSampleCount = hasPowerSample ? samplingState.power.sampleCount + 1 : samplingState.power.sampleCount;
    const nextTotal = hasPowerSample ? samplingState.power.total + powerValue : samplingState.power.total;
    const signalStats = buildNextSignalStats({
        previousPowerState: samplingState.power,
        timestamp,
        sourceType
    });

    return {
        ...samplingState,
        power: {
            value: powerValue,
            timestamp,
            sourceType,
            sampleCount: nextSampleCount,
            total: nextTotal,
            average: nextSampleCount > 0 ? Math.round(nextTotal / nextSampleCount) : null,
            ...signalStats
        },
        cadence: {
            value: cadenceValue,
            timestamp,
            sourceType
        },
        lastUpdated: timestamp
    };
}

export function clearPowerSample(samplingState) {
    return {
        ...samplingState,
        power: {
            value: null,
            timestamp: null,
            sourceType: "none",
            sampleCount: 0,
            total: 0,
            average: null,
            lastIntervalMs: null,
            intervalSampleCount: 0,
            estimatedIntervalMs: null,
            estimatedHz: null,
            jitterMs: null,
            isSignalStable: false
        },
        cadence: {
            value: null,
            timestamp: null,
            sourceType: "none"
        },
        lastUpdated: Date.now()
    };
}

export function buildEffectiveSensorSnapshot(
    samplingState = createInitialSensorSamplingState(),
    {
        now = Date.now(),
        staleThresholdMs = SENSOR_STALE_THRESHOLD_MS
    } = {}
) {
    const heartRateFresh = isFresh(samplingState.heartRate.timestamp, now, staleThresholdMs);
    const powerFresh = isFresh(samplingState.power.timestamp, now, staleThresholdMs);
    const cadenceFresh = isFresh(samplingState.cadence.timestamp, now, staleThresholdMs);

    return {
        power: powerFresh ? samplingState.power.value : null,
        cadence: cadenceFresh ? samplingState.cadence.value : null,
        heartRate: heartRateFresh ? samplingState.heartRate.value : null,
        averagePower: powerFresh ? samplingState.power.average : null,
        powerSourceType: powerFresh ? samplingState.power.sourceType : "none",
        powerTimestamp: samplingState.power.timestamp,
        cadenceTimestamp: samplingState.cadence.timestamp,
        heartRateTimestamp: samplingState.heartRate.timestamp,
        lastUpdated: samplingState.lastUpdated,
        powerSignal: {
            observedIntervalMs: powerFresh ? samplingState.power.lastIntervalMs : null,
            estimatedIntervalMs: powerFresh ? samplingState.power.estimatedIntervalMs : null,
            estimatedHz: powerFresh ? samplingState.power.estimatedHz : null,
            jitterMs: powerFresh ? samplingState.power.jitterMs : null,
            isStable: powerFresh ? samplingState.power.isSignalStable : false,
            intervalSampleCount: powerFresh ? samplingState.power.intervalSampleCount : 0
        },
        freshness: {
            power: powerFresh,
            cadence: cadenceFresh,
            heartRate: heartRateFresh
        }
    };
}

function isFresh(timestamp, now, staleThresholdMs) {
    return Number.isFinite(timestamp) && now - timestamp <= staleThresholdMs;
}

function resolveTimestamp(input) {
    return Number.isFinite(input) ? input : Date.now();
}

function normalizeFiniteNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function buildNextSignalStats({ previousPowerState, timestamp, sourceType }) {
    const previousTimestamp = previousPowerState?.timestamp;
    const sourceChanged = previousPowerState?.sourceType !== sourceType;

    if (
        sourceChanged
        || !Number.isFinite(previousTimestamp)
        || !Number.isFinite(timestamp)
        || timestamp <= previousTimestamp
        || timestamp - previousTimestamp > SENSOR_STALE_THRESHOLD_MS
    ) {
        return createInitialSignalStats();
    }

    const lastIntervalMs = timestamp - previousTimestamp;
    const intervalSampleCount = (previousPowerState.intervalSampleCount ?? 0) + 1;
    const previousEstimate = previousPowerState.estimatedIntervalMs;
    const estimatedIntervalMs = Number.isFinite(previousEstimate)
        ? blendValue(previousEstimate, lastIntervalMs, SIGNAL_ESTIMATE_ALPHA)
        : lastIntervalMs;
    const jitterSample = Number.isFinite(previousEstimate)
        ? Math.abs(lastIntervalMs - previousEstimate)
        : 0;
    const previousJitter = previousPowerState.jitterMs;
    const jitterMs = Number.isFinite(previousJitter)
        ? blendValue(previousJitter, jitterSample, SIGNAL_ESTIMATE_ALPHA)
        : jitterSample;
    const estimatedHz = estimatedIntervalMs > 0 ? 1000 / estimatedIntervalMs : null;
    const jitterRatio = estimatedIntervalMs > 0 ? jitterMs / estimatedIntervalMs : 1;

    return {
        lastIntervalMs,
        intervalSampleCount,
        estimatedIntervalMs,
        estimatedHz,
        jitterMs,
        isSignalStable: intervalSampleCount >= MIN_STABLE_INTERVAL_SAMPLES && jitterRatio <= 0.35
    };
}

function createInitialSignalStats() {
    return {
        lastIntervalMs: null,
        intervalSampleCount: 0,
        estimatedIntervalMs: null,
        estimatedHz: null,
        jitterMs: null,
        isSignalStable: false
    };
}

function blendValue(previousValue, nextValue, alpha) {
    return (previousValue * (1 - alpha)) + (nextValue * alpha);
}
