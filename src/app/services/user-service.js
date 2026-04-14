import { sanitizeSettings } from "../store/initial-state.js";

export function createUserService({ store }) {
    function updateSettings(partialSettings) {
        store.setState((state) => {
            const mergedSettings = { ...state.settings, ...partialSettings };
            return {
                ...state,
                settings: sanitizeSettings(mergedSettings),
                statusText: "设置已更新。"
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
                    statusText: "已加载本地用户配置 user-profile.json"
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