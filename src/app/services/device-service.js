import { createHeartRateMonitor } from "../../adapters/bluetooth/heart-rate-monitor.js";
import { createPowerMeter } from "../../adapters/bluetooth/power-meter.js";

function mapStatusLabel(type) {
    if (type === "connected") {
        return "已连接";
    }
    if (type === "connecting") {
        return "连接中";
    }
    return "未连接";
}

export function createDeviceService({ store }) {
    const heartRateMonitor = createHeartRateMonitor({
        onData: (data) => {
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    heartRate: {
                        ...state.ble.heartRate,
                        value: data.heartRate,
                        lastUpdated: data.timestamp
                    }
                }
            }));
        },
        onStatus: (status) => {
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    heartRate: {
                        ...state.ble.heartRate,
                        isConnecting: status.type === "connecting",
                        isConnected: status.type === "connected",
                        statusLabel: mapStatusLabel(status.type),
                        deviceName: status.deviceName ?? (status.type === "disconnected" ? "等待连接" : status.message),
                        value: status.type === "disconnected" ? null : state.ble.heartRate.value
                    }
                },
                statusText: status.message
            }));
        }
    });

    const powerMeter = createPowerMeter({
        onData: (data) => {
            store.setState((state) => {
                const sampleCount = state.ble.powerMeter.sampleCount + 1;
                const powerTotal = state.ble.powerMeter.powerTotal + data.power;

                return {
                    ...state,
                    ble: {
                        ...state.ble,
                        powerMeter: {
                            ...state.ble.powerMeter,
                            power: data.power,
                            cadence: data.cadence ?? state.ble.powerMeter.cadence,
                            averagePower: Math.round(powerTotal / sampleCount),
                            sampleCount,
                            powerTotal,
                            lastUpdated: data.timestamp
                        }
                    }
                };
            });
        },
        onStatus: (status) => {
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    powerMeter: {
                        ...state.ble.powerMeter,
                        isConnecting: status.type === "connecting",
                        isConnected: status.type === "connected",
                        statusLabel: mapStatusLabel(status.type),
                        deviceName: status.deviceName ?? (status.type === "disconnected" ? "等待连接" : status.message),
                        power: status.type === "disconnected" ? null : state.ble.powerMeter.power,
                        cadence: status.type === "disconnected" ? null : state.ble.powerMeter.cadence,
                        averagePower: status.type === "disconnected" ? null : state.ble.powerMeter.averagePower,
                        sampleCount: status.type === "disconnected" ? 0 : state.ble.powerMeter.sampleCount,
                        powerTotal: status.type === "disconnected" ? 0 : state.ble.powerMeter.powerTotal
                    }
                },
                liveRide: {
                    ...state.liveRide,
                    canStart: status.type === "connected" || state.liveRide.isActive
                },
                statusText: status.message
            }));
        }
    });

    async function toggleHeartRate() {
        try {
            await heartRateMonitor.toggle();
        } catch (error) {
            console.error("心率带连接失败", error);
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    heartRate: {
                        ...state.ble.heartRate,
                        isConnecting: false,
                        statusLabel: "连接失败",
                        deviceName: error.message
                    }
                },
                statusText: `心率带连接失败：${error.message}`
            }));
        }
    }

    async function togglePowerMeter() {
        try {
            await powerMeter.toggle();
        } catch (error) {
            console.error("功率计连接失败", error);
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    powerMeter: {
                        ...state.ble.powerMeter,
                        isConnecting: false,
                        statusLabel: "连接失败",
                        deviceName: error.message
                    }
                },
                statusText: `功率计连接失败：${error.message}`
            }));
        }
    }

    return {
        toggleHeartRate,
        togglePowerMeter
    };
}