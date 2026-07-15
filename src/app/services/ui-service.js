import { savePipPreferences } from "../../adapters/storage/session-storage.js";
import { isStreetViewDebugEnabled } from "../../shared/debug-flags.js";

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
        if (!isStreetViewDebugEnabled()) {
            enterLiveMode();
            return;
        }
        store.setState((state) => ({
            ...state,
            uiMode: "live",
            rideInput: {
                ...state.rideInput,
                powerSource: "virtual"
            },
            liveRide: {
                ...state.liveRide,
                canStart: true
            },
            statusText: "已进入实时骑行设置，当前使用模拟功率。"
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
        persistPipPreferences();
    }

    function updatePipChartConfig(key, checked) {
        store.setState((state) => ({
            ...state,
            pipChartConfig: {
                ...state.pipChartConfig,
                [key]: checked
            }
        }));
        persistPipPreferences();
    }

    function updatePipLayout(layout) {
        store.setState((state) => ({
            ...state,
            pipLayout: ["compact", "grid", "wide"].includes(layout) ? layout : "grid"
        }));
        persistPipPreferences();
    }

    return {
        setUiMode,
        openActivityDetail,
        enterSimulationMode,
        enterLiveMode,
        updatePipConfig,
        updatePipChartConfig,
        updatePipLayout
    };

    function persistPipPreferences() {
        const state = store.getState();
        savePipPreferences({
            pipConfig: state.pipConfig,
            pipChartConfig: state.pipChartConfig,
            pipLayout: state.pipLayout
        });
    }
}
