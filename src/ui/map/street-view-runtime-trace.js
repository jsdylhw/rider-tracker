const DEFAULT_MAX_ENTRIES = 1600;

export function createStreetViewRuntimeTrace({
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = () => Date.now()
} = {}) {
    const entries = [];
    const startedAt = now();
    const safeMaxEntries = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES));
    let sequence = 0;

    function record(entry = {}) {
        const at = Number.isFinite(entry.at) ? entry.at : now();
        entries.push({
            sequence: ++sequence,
            at,
            elapsedMs: Math.max(0, at - startedAt),
            ...entry,
            at
        });
        if (entries.length > safeMaxEntries) {
            entries.splice(0, entries.length - safeMaxEntries);
        }
    }

    function snapshot() {
        return {
            schemaVersion: 1,
            startedAt: new Date(startedAt).toISOString(),
            exportedAt: new Date(now()).toISOString(),
            environment: getEnvironment(),
            entries: [...entries]
        };
    }

    function clear() {
        entries.length = 0;
        sequence = 0;
    }

    return { record, snapshot, clear };
}

function getEnvironment() {
    if (typeof navigator === "undefined") return {};
    const connection = navigator.connection;
    return {
        userAgent: navigator.userAgent ?? "",
        connection: connection ? {
            effectiveType: connection.effectiveType ?? null,
            downlinkMbps: connection.downlink ?? null,
            rttMs: connection.rtt ?? null,
            saveData: connection.saveData === true
        } : null
    };
}
