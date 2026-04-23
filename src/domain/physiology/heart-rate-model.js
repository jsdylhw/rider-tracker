export function createInitialLiveHeartRateState({
    initialHeartRate = null,
    restingHr = 58
} = {}) {
    const currentHeartRate = normalizeHeartRate(initialHeartRate, restingHr);

    return {
        currentHeartRate,
        source: Number.isFinite(initialHeartRate) ? "sensor" : "baseline"
    };
}

export function advanceLiveHeartRateState({
    currentState,
    sampledHeartRate = null,
    restingHr = 58
}) {
    if (Number.isFinite(sampledHeartRate)) {
        return {
            currentHeartRate: Math.round(sampledHeartRate),
            source: "sensor"
        };
    }

    if (Number.isFinite(currentState?.currentHeartRate)) {
        return {
            currentHeartRate: Math.round(currentState.currentHeartRate),
            source: currentState.source ?? "carry-forward"
        };
    }

    return {
        currentHeartRate: normalizeHeartRate(null, restingHr),
        source: "baseline"
    };
}

export function estimateHeartRate({
    currentHeartRate,
    power,
    elapsedSeconds,
    durationSeconds,
    restingHr,
    maxHr,
    dt
}) {
    const normalizedCurrentHeartRate = normalizeHeartRate(currentHeartRate, restingHr);
    const fatigueRatio = durationSeconds > 0 ? elapsedSeconds / durationSeconds : 0;
    const hrTarget = Math.min(
        maxHr,
        restingHr + power * 0.32 + 18 * fatigueRatio
    );

    return normalizedCurrentHeartRate + (hrTarget - normalizedCurrentHeartRate) * Math.min(1, dt / 18);
}

function normalizeHeartRate(value, fallback) {
    return Number.isFinite(value) ? Math.round(value) : Math.round(fallback);
}
