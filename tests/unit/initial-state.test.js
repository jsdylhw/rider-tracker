import { createInitialState, defaultSettings, sanitizeSettings } from "../../src/app/store/initial-state.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "initial-state",
    tests: [
        {
            name: "sanitizeSettings 保留虚拟骑行 0W 输入",
            run() {
                const settings = sanitizeSettings({
                    ...defaultSettings,
                    power: 0
                });

                assertEqual(settings.power, 0);
            }
        },
        {
            name: "sanitizeSettings 仍会限制负功率和过高功率",
            run() {
                assertEqual(sanitizeSettings({ ...defaultSettings, power: -5 }).power, 0);
                assertEqual(sanitizeSettings({ ...defaultSettings, power: 9999 }).power, 600);
            }
        },
        {
            name: "初始状态不再预置可直接开始的手工路线",
            run() {
                const state = createInitialState();

                assertEqual(Object.hasOwn(state, "routeSegments"), false);
                assertEqual(Object.hasOwn(state, "hasPersistedSession"), false);
                assertEqual(state.session, null);
                assertEqual(state.route.totalDistanceMeters, 0);
            }
        }
    ]
};
