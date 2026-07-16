import { shouldRenderDashboard } from "../../src/ui/renderers/main-view.js";
import { assertEqual } from "../helpers/test-harness.js";

function createState(settings) {
    return {
        liveRide: {},
        route: {},
        ble: {},
        workout: {},
        settings,
        uiMode: "live"
    };
}

export const suite = {
    name: "main-view-rendering",
    tests: [
        {
            name: "profile settings 更新会重新渲染 dashboard 指标",
            run() {
                const previousState = createState({ ftp: 250, mass: 75 });
                const state = createState({ ftp: 280, mass: 75 });

                assertEqual(shouldRenderDashboard(state, previousState), true);
            }
        },
        {
            name: "无 dashboard 依赖变化时跳过 dashboard 渲染",
            run() {
                const dependencies = {
                    liveRide: {},
                    route: {},
                    ble: {},
                    workout: {},
                    settings: { ftp: 250 },
                    uiMode: "live"
                };

                assertEqual(shouldRenderDashboard(dependencies, dependencies), false);
            }
        }
    ]
};
