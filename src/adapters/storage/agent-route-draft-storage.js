const STORAGE_KEY = "rider-tracker:agent-route-draft:v1";

export function createAgentRouteDraftStorage({ storage = getLocalStorage() } = {}) {
    function load() {
        try {
            const value = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
            return value?.schemaVersion === 1 && value?.draft?.planId ? value.draft : null;
        } catch {
            return null;
        }
    }

    function save(draft) {
        if (!draft?.planId) return;
        try {
            storage?.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, draft }));
        } catch {
            // Persistence is a convenience; the in-memory draft remains usable.
        }
    }

    function clear() {
        try {
            storage?.removeItem(STORAGE_KEY);
        } catch {
            // Ignore unavailable browser storage.
        }
    }

    return { load, save, clear };
}

function getLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
