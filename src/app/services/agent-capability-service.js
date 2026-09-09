import {
    normalizeAgentCapabilities,
    unavailableAgentCapabilities
} from "../../domain/agent/agent-capabilities.js";

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;

export function createAgentCapabilityService({
    store,
    fetchImpl = fetch,
    schedule = globalThis,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS
}) {
    let timer = null;
    let stopped = false;

    async function refresh() {
        try {
            const response = await fetchImpl("/api/agent/health", { signal: AbortSignal.timeout(2_500) });
            const payload = await response.json().catch(() => ({}));
            const availability = response.ok && payload?.ok === true
                ? normalizeAgentCapabilities(payload)
                : unavailableAgentCapabilities(payload?.error);
            commit(availability);
            return availability;
        } catch (error) {
            const availability = unavailableAgentCapabilities(error?.message);
            commit(availability);
            return availability;
        }
    }

    function commit(agentCapabilities) {
        if (stopped) return;
        store.setState((state) => ({ ...state, agentCapabilities }));
    }

    function start() {
        stopped = false;
        void refresh();
        timer = schedule.setInterval?.(() => void refresh(), refreshIntervalMs) ?? null;
        return stop;
    }

    function stop() {
        stopped = true;
        if (timer !== null) schedule.clearInterval?.(timer);
        timer = null;
    }

    return { start, stop, refresh };
}
