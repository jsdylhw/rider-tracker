export const DEFAULT_POWER_WINDOW_SECONDS = [3, 10];

export function normalizePowerWindows(powerWindowSeconds) {
    const source = Array.isArray(powerWindowSeconds) && powerWindowSeconds.length > 0
        ? powerWindowSeconds
        : DEFAULT_POWER_WINDOW_SECONDS;

    return [...new Set(source
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0))]
        .sort((left, right) => left - right);
}

export function summarizePowerMetrics({
    records = [],
    powerWindowSeconds = DEFAULT_POWER_WINDOW_SECONDS
} = {}) {
    const normalizedWindows = normalizePowerWindows(powerWindowSeconds);

    if (!records.length) {
        return {
            averageWatts: 0,
            maxWatts: 0,
            rolling3sWatts: 0,
            rolling10sWatts: 0,
            windows: Object.fromEntries(normalizedWindows.map((windowSeconds) => [`${windowSeconds}s`, 0])),
            normalizedPowerWatts: 0
        };
    }

    const recordsWithPower = records.map((record) => ({
        elapsedSeconds: normalizeFiniteNumber(record?.elapsedSeconds),
        power: normalizeFiniteNumber(record?.power) ?? 0
    }));

    const powerValues = recordsWithPower.map((record) => record.power);
    const windowAverages = calculateWindowAverages(recordsWithPower, normalizedWindows);

    return {
        averageWatts: roundAverage(powerValues),
        maxWatts: powerValues.length ? Math.max(...powerValues) : 0,
        rolling3sWatts: windowAverages.get(3) ?? 0,
        rolling10sWatts: windowAverages.get(10) ?? 0,
        windows: Object.fromEntries(normalizedWindows.map((windowSeconds) => [`${windowSeconds}s`, windowAverages.get(windowSeconds) ?? 0])),
        normalizedPowerWatts: calculateNormalizedPower(recordsWithPower)
    };
}

function calculateWindowAverages(records, windowSecondsList) {
    const stateByWindow = new Map(
        windowSecondsList.map((windowSeconds) => [windowSeconds, {
            sum: 0,
            startIndex: 0,
            average: 0
        }])
    );

    records.forEach((record, index) => {
        for (const windowSeconds of windowSecondsList) {
            const state = stateByWindow.get(windowSeconds);
            state.sum += record.power;

            while (
                state.startIndex <= index
                && shouldAdvanceWindowStart(records[state.startIndex], record, windowSeconds)
            ) {
                state.sum -= records[state.startIndex].power;
                state.startIndex += 1;
            }

            const sampleCount = index - state.startIndex + 1;
            state.average = sampleCount > 0 ? Math.round(state.sum / sampleCount) : 0;
        }
    });

    return new Map(
        [...stateByWindow.entries()].map(([windowSeconds, state]) => [windowSeconds, state.average])
    );
}

function calculateNormalizedPower(records) {
    if (!records.length) {
        return 0;
    }

    const windowSeconds = 30;
    let startIndex = 0;
    let rollingSum = 0;
    let fourthPowerSum = 0;
    let sampleCount = 0;

    records.forEach((record, index) => {
        rollingSum += record.power;

        while (
            startIndex <= index
            && shouldAdvanceWindowStart(records[startIndex], record, windowSeconds)
        ) {
            rollingSum -= records[startIndex].power;
            startIndex += 1;
        }

        const windowSampleCount = index - startIndex + 1;
        const rollingAverage = windowSampleCount > 0 ? rollingSum / windowSampleCount : 0;

        if (rollingAverage > 0) {
            fourthPowerSum += rollingAverage ** 4;
            sampleCount += 1;
        }
    });

    if (sampleCount === 0) {
        return 0;
    }

    return Math.round((fourthPowerSum / sampleCount) ** 0.25);
}

function shouldAdvanceWindowStart(startRecord, currentRecord, windowSeconds) {
    if (!Number.isFinite(startRecord?.elapsedSeconds) || !Number.isFinite(currentRecord?.elapsedSeconds)) {
        return false;
    }

    return startRecord.elapsedSeconds <= currentRecord.elapsedSeconds - windowSeconds;
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
