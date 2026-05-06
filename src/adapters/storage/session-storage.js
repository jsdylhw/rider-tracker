const STORAGE_KEY = "rider-tracker:last-session";
const PIP_PREFERENCES_STORAGE_KEY = "rider-tracker:pip-preferences";

export function loadLastSession() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.error("读取最近模拟失败", error);
        return null;
    }
}

export function saveLastSession(session) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (error) {
        console.error("保存最近模拟失败", error);
    }
}

export function loadPipPreferences() {
    try {
        const raw = localStorage.getItem(PIP_PREFERENCES_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.error("读取 PiP 偏好失败", error);
        return null;
    }
}

export function savePipPreferences(preferences) {
    try {
        localStorage.setItem(PIP_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
        console.error("保存 PiP 偏好失败", error);
    }
}
