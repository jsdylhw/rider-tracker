export function createGoogleMapsConfigService({
    fetchImpl = globalThis.fetch
} = {}) {
    let config = {
        apiKey: "",
        source: "none"
    };
    let activeApiKey = "";
    const listeners = new Set();

    function getConfig() {
        return { ...config, apiKeyLocked: Boolean(activeApiKey) };
    }

    async function loadRuntimeConfig() {
        if (typeof fetchImpl !== "function") return getConfig();
        try {
            const response = await fetchImpl("/api/runtime-config/maps");
            if (!response.ok) return getConfig();
            const payload = await response.json();
            const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
            if (!activeApiKey) config = { apiKey, source: apiKey ? "config" : "none" };
            notify();
        } catch {
            // Online map features remain disabled when unified runtime config is unavailable.
        }
        return getConfig();
    }

    function getApiKey() {
        if (!config.apiKey) return "";
        if (activeApiKey && activeApiKey !== config.apiKey) {
            throw new Error("Google Maps Key 已在当前页面锁定，刷新页面后才能更换。");
        }
        return config.apiKey;
    }

    function lockApiKey(apiKey) {
        if (!apiKey) return;
        if (activeApiKey && activeApiKey !== apiKey) {
            throw new Error("Google Maps Key 已在当前页面锁定，刷新页面后才能更换。");
        }
        activeApiKey = apiKey;
        notify();
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notify() {
        const snapshot = getConfig();
        listeners.forEach((listener) => listener(snapshot));
    }

    return { getConfig, getApiKey, loadRuntimeConfig, lockApiKey, subscribe };
}
