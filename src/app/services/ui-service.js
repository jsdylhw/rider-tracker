export function createUiService({ store }) {
    function setUiMode(mode) {
        store.setState((state) => ({
            ...state,
            uiMode: mode
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

    return {
        setUiMode,
        enterSimulationMode,
        enterLiveMode,
        updatePipConfig
    };
}
