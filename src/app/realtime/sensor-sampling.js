export const SENSOR_STALE_THRESHOLD_MS = 4000;

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
            average: null
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

    return {
        ...samplingState,
        power: {
            value: powerValue,
            timestamp,
            sourceType,
            sampleCount: nextSampleCount,
            total: nextTotal,
            average: nextSampleCount > 0 ? Math.round(nextTotal / nextSampleCount) : null
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
            average: null
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
