import { sanitizeSettings } from "../store/initial-state.js";

export function createUserService({ store }) {
    function updateSettings(partialSettings) {
        store.setState((state) => {
            const mergedSettings = { ...state.settings, ...partialSettings };
            const nextSettings = sanitizeSettings(mergedSettings);
            saveUserProfile(nextSettings);
            return {
                ...state,
                settings: nextSettings,
                statusText: "设置已更新，并将写入根目录 user-profile.json。"
            };
        });
    }

    function loadUserProfile() {
        fetch("user-profile.json")
            .then((response) => {
                if (!response.ok) {
                    throw new Error("Local profile not found");
                }
                return response.json();
            })
            .then((profile) => {
                store.setState((state) => ({
                    ...state,
                    settings: sanitizeSettings({ ...state.settings, ...profile }),
                    statusText: "已加载根目录 user-profile.json"
                }));
            })
            .catch((error) => {
                console.info("未能加载本地 user-profile.json，使用默认设置。", error);
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
