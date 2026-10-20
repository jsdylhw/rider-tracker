import { normalizeMetricSelection } from "../../shared/live-metrics.js";

const KEY = "rider.live-metric-preferences";
export function createLiveMetricPreferences({ getStorage = () => globalThis.localStorage } = {}) {
    return {
        load() {
            try {
                const saved = JSON.parse(getStorage()?.getItem(KEY) ?? "null");
                if (saved?.version !== 1 || !saved.selection || typeof saved.selection !== "object" || Array.isArray(saved.selection)) {
                    return normalizeMetricSelection();
                }
                // Ignore invalid values and removed metrics; new metrics keep their defaults.
                const valid = Object.fromEntries(Object.entries(saved.selection).filter(([, value]) => typeof value === "boolean"));
                return normalizeMetricSelection(valid);
            } catch { return normalizeMetricSelection(); }
        },
        save(selection) {
            try {
                getStorage()?.setItem(KEY, JSON.stringify({ version: 1, selection: normalizeMetricSelection(selection) }));
            } catch { /* Restricted storage must not interrupt the ride UI. */ }
        }
    };
}
