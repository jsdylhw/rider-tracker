export function createUiService({ store }) {
    function setUiMode(mode) {
        store.setState((state) => ({
            ...state,
            uiMode: mode,
            showLiveDeviceModal: mode === "live" ? state.showLiveDeviceModal : false
        }));
    }

    function confirmRouteSelection() {
        store.setState((state) => ({
            ...state,
            routeSelectionConfirmed: true,
            statusText: `已选择路线：${state.route.name || "当前路线"}`
        }));
    }

    function reopenRouteSelection() {
        store.setState((state) => ({
            ...state,
            routeSelectionConfirmed: false,
            statusText: "已返回路线选择，请继续调整个人数据和训练线路。"
        }));
    }

    function enterSimulationMode() {
        store.setState((state) => ({
            ...state,
            uiMode: "simulation",
            showLiveDeviceModal: false
        }));
    }

    function enterLiveMode() {
        store.setState((state) => ({
            ...state,
            uiMode: "live",
            showLiveDeviceModal: true,
            statusText: "请先连接功率计和心率带，再开始虚拟骑行。"
        }));
    }

    function closeLiveDeviceModal() {
        store.setState((state) => ({
            ...state,
            showLiveDeviceModal: false
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
        confirmRouteSelection,
        reopenRouteSelection,
        enterSimulationMode,
        enterLiveMode,
        closeLiveDeviceModal,
        updatePipConfig
    };
}
