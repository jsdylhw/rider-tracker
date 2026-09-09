import { createDeviceRenderer } from "../../src/ui/renderers/device-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

function createState() {
    return {
        ble: {
            supported: true,
            heartRate: {
                isConnecting: false,
                isConnected: false,
                statusLabel: "未连接",
                deviceName: "等待连接",
                value: null
            },
            powerMeter: {
                externalConnecting: false,
                externalConnected: false,
                externalDeviceName: "等待连接",
                statusLabel: "未连接",
                deviceName: "等待连接",
                power: null,
                cadence: null
            },
            trainer: {
                isConnecting: false,
                isConnected: false,
                statusLabel: "未连接",
                deviceName: "等待连接"
            }
        },
        liveRide: {
            isActive: false,
            canStart: false,
            session: null,
            records: [],
            summary: null,
            statusMeta: ""
        },
        route: {
            totalDistanceMeters: 1000,
            isLoading: false
        },
        rideInput: {
            powerSource: "virtual",
            virtualPowerWatts: 220,
            virtualCadenceRpm: 85
        },
        workout: { mode: "grade-sim", runtime: {} },
        settings: { ftp: 250 }
    };
}

export const suite = {
    name: "device-renderer",
    tests: [
        {
            name: "街景调试模拟功率会显示骑行准备状态",
            run() {
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } }
                };

                try {
                    const elements = {
                        stopRideBtn: createFakeElement(),
                        openRideDashboardBtn: createFakeElement(),
                        rideStatusMeta: createFakeElement()
                    };
                    const renderer = createDeviceRenderer({
                        elements,
                        onToggleHeartRate() {},
                        onTogglePowerMeter() {},
                        onToggleTrainer() {},
                        onOpenRideDashboard() {},
                        onStartRide() {},
                        onStopRide() {}
                    });

                    renderer.render(createState());
                    assertEqual(elements.rideStatusMeta.textContent.includes("debug 模拟功率"), true);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "路线从加载中变为完成后会解除模拟骑行阻塞提示",
            run() {
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } }
                };

                try {
                    const elements = {
                        stopRideBtn: createFakeElement(),
                        rideStatusMeta: createFakeElement()
                    };
                    const renderer = createDeviceRenderer({ elements });
                    const loadingState = createState();
                    loadingState.route = { ...loadingState.route, isLoading: true };

                    renderer.render(loadingState);
                    assertEqual(elements.rideStatusMeta.textContent, "路线仍在处理中，请等待完成。");

                    renderer.render({ ...loadingState, route: { ...loadingState.route, isLoading: false } });
                    assertEqual(elements.rideStatusMeta.textContent.includes("路线仍在处理中"), false);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        }
    ]
};
