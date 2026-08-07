import { sanitizeSettings } from "../store/initial-state.js";

export function createUserService({ store }) {
    function updateSettings(partialSettings) {
        store.setState((state) => {
            const mergedSettings = { ...state.settings, ...partialSettings };
            const nextSettings = sanitizeSettings(mergedSettings);
            saveUserProfile(nextSettings);
            return {
                ...state,
                settings: nextSettings
            };
        });
    }

    function loadUserProfile() {
        fetch("/api/user-profile")
            .then((response) => {
                if (!response.ok) {
                    throw new Error("Local profile not found");
                }
                return response.json();
            })
            .then((payload) => {
                const profile = payload?.profile ?? payload;
                store.setState((state) => ({
                    ...state,
                    settings: sanitizeSettings({ ...state.settings, ...profile })
                }));
            })
            .catch((error) => {
                console.info("未能加载本地用户设置，使用默认设置。", error);
            });
    }

    return {
        updateSettings,
        loadUserProfile
    };
}

function saveUserProfile(settings) {
    fetch("/api/user-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
    }).catch((error) => {
        console.error("保存根目录 user-profile.json 失败", error);
    });
}
