const STORAGE_KEY = "rider-tracker:google-maps-api-key";

export function createGoogleMapsConfigService({ storage = getLocalStorage() } = {}) {
    let config = {
        apiKey: readStoredApiKey(storage)
    };
    let activeApiKey = "";
    const listeners = new Set();

    function getConfig() {
        return { ...config, apiKeyLocked: Boolean(activeApiKey) };
    }

    function updateConfig(partial = {}) {
        const apiKey = typeof partial.apiKey === "string" ? partial.apiKey.trim() : config.apiKey;
        if (activeApiKey && apiKey !== activeApiKey) {
            throw new Error("Google Maps 已使用当前 Key 初始化；如需更换 Key，请刷新页面后重试。");
        }

        config = {
            apiKey
        };
        persistApiKey(storage, apiKey);
        notify();
        return getConfig();
    }

    function applyProfileApiKey(apiKey) {
        const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
        if (!normalizedApiKey || activeApiKey) return getConfig();

        config = { apiKey: normalizedApiKey };
        persistApiKey(storage, normalizedApiKey);
        notify();
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

    return { applyProfileApiKey, getConfig, getApiKey, lockApiKey, subscribe, updateConfig };
}

function getLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function readStoredApiKey(storage) {
    try {
        return storage?.getItem(STORAGE_KEY)?.trim() ?? "";
    } catch {
        return "";
    }
}

function persistApiKey(storage, apiKey) {
    try {
        if (apiKey) {
            storage?.setItem(STORAGE_KEY, apiKey);
        } else {
            storage?.removeItem(STORAGE_KEY);
        }
    } catch {
        // Storage is an optional convenience; the in-memory value still works.
    }
}
