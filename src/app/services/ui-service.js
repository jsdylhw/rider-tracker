export function createUiService({ store }) {
    function setUiMode(mode) {
        store.setState((state) => ({
            ...state,
            uiMode: mode
        }));
    }

    function openActivityDetail(activity) {
        store.setState((state) => ({
            ...state,
            uiMode: "activity-detail",
            selectedActivity: activity,
            session: activity?.rawSession ?? state.session,
            statusText: activity?.name ? `已打开活动详情：${activity.name}` : "已打开活动详情。"
        }));
    }

    function enterSimulationMode() {
        store.setState((state) => ({
            ...state,
            uiMode: "simulation",
            statusText: "已进入模拟骑行，请选择路线并设置模拟参数。"
        }));
    }

    function enterLiveMode() {
        store.setState((state) => ({
            ...state,
            uiMode: "live",
            statusText: "已进入虚拟骑行，请选择路线并连接骑行设备。"
        }));
    }

    function updatePipConfig(key, checked) {
        store.setState((state) => ({
            ...state,
            pipConfig: {
                ...state.pipConfig,
                [key]: checked
            }
        }));
    }

    function updatePipLayout(layout) {
        store.setState((state) => ({
            ...state,
            pipLayout: ["compact", "grid", "wide"].includes(layout) ? layout : "grid"
        }));
    }

    return {
        setUiMode,
        openActivityDetail,
        enterSimulationMode,
        enterLiveMode,
        updatePipConfig,
        updatePipLayout
    };
}
