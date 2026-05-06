import { createInitialState } from "../../src/app/store/initial-state.js";
import { createUiService } from "../../src/app/services/ui-service.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "pip-preferences",
    tests: [
        {
            name: "初始状态会恢复 PiP 偏好",
            run() {
                const state = createInitialState(null, {
                    pipPreferences: {
                        pipConfig: {
                            currentPower: false,
                            elapsedTime: true,
                            unknownMetric: true
                        },
                        pipChartConfig: {
                            elevation: false,
                            powerHeartRate: true,
                            unknownChart: true
                        },
                        pipLayout: "wide"
                    }
                });

                assertEqual(state.pipConfig.currentPower, false);
                assertEqual(state.pipConfig.elapsedTime, true);
                assertEqual(Object.hasOwn(state.pipConfig, "unknownMetric"), false);
                assertEqual(state.pipChartConfig.elevation, false);
                assertEqual(state.pipChartConfig.powerHeartRate, true);
                assertEqual(Object.hasOwn(state.pipChartConfig, "unknownChart"), false);
                assertEqual(state.pipLayout, "wide");
            }
        },
        {
            name: "UI service 更新 PiP 偏好时写入 localStorage",
            run() {
                const originalLocalStorage = globalThis.localStorage;
                const writes = [];
                globalThis.localStorage = {
                    setItem(key, value) {
                        writes.push({ key, value: JSON.parse(value) });
                    }
                };

                try {
                    const store = createFakeStore(createInitialState(null));
                    const uiService = createUiService({ store });

                    uiService.updatePipChartConfig("powerHeartRate", true);
                    uiService.updatePipLayout("compact");

                    assertEqual(writes.length, 2);
                    assertEqual(writes.at(-1).key, "rider-tracker:pip-preferences");
                    assertEqual(writes.at(-1).value.pipChartConfig.powerHeartRate, true);
                    assertEqual(writes.at(-1).value.pipLayout, "compact");
                } finally {
                    if (originalLocalStorage === undefined) {
                        delete globalThis.localStorage;
                    } else {
                        globalThis.localStorage = originalLocalStorage;
                    }
                }
            }
        }
    ]
};

function createFakeStore(initialState) {
    let state = initialState;
    return {
        getState() {
            return state;
        },
        setState(updater) {
            state = typeof updater === "function" ? updater(state) : { ...state, ...updater };
            return state;
        }
    };
}
