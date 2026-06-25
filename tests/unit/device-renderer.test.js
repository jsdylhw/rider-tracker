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
        workout: { runtime: {} },
        settings: { ftp: 250 }
    };
}

export const suite = {
    name: "device-renderer",
    tests: [
        {
            name: "街景调试模式允许外层开始骑行按钮可用",
            run() {
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } }
                };

                try {
                    const elements = {
                        startRideBtn: createFakeElement(),
                        stopRideBtn: createFakeElement(),
                        openRideDashboardBtn: createFakeElement()
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
                    assertEqual(elements.startRideBtn.disabled, false);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        }
    ]
};
