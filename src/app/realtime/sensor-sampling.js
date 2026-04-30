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
    const normalizedSamplingState = normalizeSamplingState(samplingState);
    const heartRateFresh = isFresh(normalizedSamplingState.heartRate.timestamp, now, staleThresholdMs);
    const powerFresh = isFresh(normalizedSamplingState.power.timestamp, now, staleThresholdMs);
    const cadenceFresh = isFresh(normalizedSamplingState.cadence.timestamp, now, staleThresholdMs);

    return {
        power: powerFresh ? normalizedSamplingState.power.value : null,
        cadence: cadenceFresh ? normalizedSamplingState.cadence.value : null,
        heartRate: heartRateFresh ? normalizedSamplingState.heartRate.value : null,
        powerSourceType: powerFresh ? normalizedSamplingState.power.sourceType : "none",
        powerTimestamp: normalizedSamplingState.power.timestamp,
        cadenceTimestamp: normalizedSamplingState.cadence.timestamp,
        heartRateTimestamp: normalizedSamplingState.heartRate.timestamp,
        lastUpdated: normalizedSamplingState.lastUpdated,
        powerSignal: {
            observedIntervalMs: powerFresh ? normalizedSamplingState.power.lastIntervalMs : null,
            estimatedIntervalMs: powerFresh ? normalizedSamplingState.power.estimatedIntervalMs : null,
            estimatedHz: powerFresh ? normalizedSamplingState.power.estimatedHz : null,
            jitterMs: powerFresh ? normalizedSamplingState.power.jitterMs : null,
            isStable: powerFresh ? normalizedSamplingState.power.isSignalStable : false,
            intervalSampleCount: powerFresh ? normalizedSamplingState.power.intervalSampleCount : 0
        },
        freshness: {
            power: powerFresh,
            cadence: cadenceFresh,
            heartRate: heartRateFresh
        }
    };
}

function normalizeSamplingState(samplingState) {
    const initial = createInitialSensorSamplingState();

    return {
        ...initial,
        ...samplingState,
        heartRate: {
            ...initial.heartRate,
            ...(samplingState?.heartRate ?? {})
        },
        power: {
            ...initial.power,
            ...(samplingState?.power ?? {})
        },
        cadence: {
            ...initial.cadence,
            ...(samplingState?.cadence ?? {})
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
