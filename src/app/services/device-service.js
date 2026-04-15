import { createHeartRateMonitor } from "../../adapters/bluetooth/heart-rate-monitor.js";
import { createPowerMeter } from "../../adapters/bluetooth/power-meter.js";
import { createTrainerFtms } from "../../adapters/bluetooth/trainer-ftms.js";

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

    const trainerFtms = createTrainerFtms({
        onStatus: (status) => {
            store.setState((state) => ({
                ...state,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: status.message
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
            // 如果功率计连上了，尝试同步连接 FTMS 控制通道
            if (powerMeter.isConnected && !trainerFtms.isConnected) {
                try {
                    await trainerFtms.connect();
                } catch (e) {
                    console.log("未找到可用的 FTMS 控制服务，可能是单边功率计", e);
                }
            } else if (!powerMeter.isConnected && trainerFtms.isConnected) {
                await trainerFtms.disconnect();
            }
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

    async function setTrainerGrade(gradePercent) {
        if (!trainerFtms.isConnected) {
            const message = "坡度模拟未下发：智能骑行台控制未连接。";
            store.setState((state) => ({
                ...state,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: message
                },
                statusText: message
            }));
            throw new Error(message);
        }

        try {
            await trainerFtms.setTargetGrade(gradePercent);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = `坡度模拟下发失败：${reason}`;
            store.setState((state) => ({
                ...state,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: message
                },
                statusText: message
            }));
            throw error;
        }
    }

    async function setTrainerPower(powerWatts) {
        if (!trainerFtms.isConnected) {
            const message = "ERG 指令未下发：智能骑行台控制未连接。";
            store.setState((state) => ({
                ...state,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: message
                },
                statusText: message
            }));
            throw new Error(message);
        }

        try {
            await trainerFtms.setTargetPower(powerWatts);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = `ERG 指令下发失败：${reason}`;
            store.setState((state) => ({
                ...state,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: message
                },
                statusText: message
            }));
            throw error;
        }
    }

    return {
        toggleHeartRate,
        togglePowerMeter,
        setTrainerGrade,
        setTrainerPower
    };
}
