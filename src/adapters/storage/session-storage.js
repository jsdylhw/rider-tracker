const STORAGE_KEY = "rider-tracker:last-session";

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
