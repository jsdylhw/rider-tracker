import { createHeartRateMonitor } from "../../adapters/bluetooth/heart-rate-monitor.js";
import { createControllableTrainer } from "../../adapters/bluetooth/controllable-trainer.js";

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

    const controllableTrainer = createControllableTrainer({
        onTrainerStatus: (status) => {
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    trainer: {
                        ...state.ble.trainer,
                        isConnecting: status.type === "connecting",
                        isConnected: status.type === "connected",
                        statusLabel: mapStatusLabel(status.type),
                        deviceName: status.deviceName ?? (status.type === "disconnected" ? "等待连接" : status.message),
                        lastUpdated: Date.now()
                    }
                },
                liveRide: {
                    ...state.liveRide,
                    canStart: computeCanStart(state, {
                        trainerConnected: status.type === "connected"
                    }),
                    statusMeta: status.message
                },
                statusText: status.message
            }));
        }
    ,
        onPowerSourceStatus: (powerState) => {
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    powerMeter: {
                        ...state.ble.powerMeter,
                        isConnected: powerState.activeSource !== "none",
                        statusLabel: powerState.activeSourceLabel,
                        sourceType: powerState.activeSource,
                        sourceLabel: powerState.activeSourceLabel,
                        deviceName: resolvePowerSourceDeviceName(powerState),
                        externalConnected: powerState.externalPowerConnected,
                        externalConnecting: powerState.externalPowerConnecting,
                        externalDeviceName: powerState.externalPowerDeviceName
                    }
                },
                liveRide: {
                    ...state.liveRide,
                    canStart: computeCanStart(state, {
                        trainerConnected: powerState.trainerConnected,
                        externalPowerConnected: powerState.externalPowerConnected,
                        activePowerSource: powerState.activeSource
                    })
                }
            }));
        },
        onData: (data) => {
            store.setState((state) => {
                const hasPowerSample = typeof data.power === "number" && Number.isFinite(data.power);
                const sampleCount = hasPowerSample ? state.ble.powerMeter.sampleCount + 1 : state.ble.powerMeter.sampleCount;
                const powerTotal = hasPowerSample ? state.ble.powerMeter.powerTotal + data.power : state.ble.powerMeter.powerTotal;

                return {
                    ...state,
                    ble: {
                        ...state.ble,
                        powerMeter: {
                            ...state.ble.powerMeter,
                            isConnected: data.sourceType !== "none",
                            statusLabel: mapPowerSourceStatusLabel(data.sourceType),
                            sourceType: data.sourceType,
                            sourceLabel: mapPowerSourceStatusLabel(data.sourceType),
                            power: data.sourceType === "none" ? null : data.power,
                            cadence: data.sourceType === "none" ? null : data.cadence,
                            averagePower: sampleCount > 0 ? Math.round(powerTotal / sampleCount) : null,
                            sampleCount,
                            powerTotal,
                            lastUpdated: data.sourceType === "none" ? null : data.timestamp
                        }
                    },
                    liveRide: {
                        ...state.liveRide,
                        canStart: computeCanStart(state, {
                            trainerConnected: state.ble.trainer.isConnected,
                            activePowerSource: data.sourceType
                        })
                    }
                };
            });
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
            await controllableTrainer.toggleExternalPowerMeter();
        } catch (error) {
            console.error("功率计连接失败", error);
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    powerMeter: {
                        ...state.ble.powerMeter,
                        externalConnecting: false
                    }
                },
                statusText: `功率计连接失败：${error.message}`
            }));
        }
    }

    async function toggleTrainer() {
        try {
            await controllableTrainer.toggle();
        } catch (error) {
            console.error("骑行台连接失败", error);
            store.setState((state) => ({
                ...state,
                ble: {
                    ...state.ble,
                    trainer: {
                        ...state.ble.trainer,
                        isConnecting: false,
                        statusLabel: "连接失败",
                        deviceName: error.message
                    }
                },
                statusText: `骑行台连接失败：${error.message}`
            }));
        }
    }

    async function setTrainerGrade(gradePercent) {
        if (!controllableTrainer.isConnected) {
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
            const result = await controllableTrainer.setTargetGrade(gradePercent);
            if (result?.status === "unconfirmed") {
                const message = `坡度命令未确认（可能已生效）：${gradePercent.toFixed(1)}% (${result.path})`;
                store.setState((state) => ({
                    ...state,
                    liveRide: {
                        ...state.liveRide,
                        statusMeta: message
                    },
                    statusText: message
                }));
            }
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
        if (!controllableTrainer.isConnected) {
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
            await controllableTrainer.setTargetPower(powerWatts);
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

    async function setTrainerResistance(resistanceLevel) {
        if (!controllableTrainer.isConnected) {
            const message = "固定阻力指令未下发：智能骑行台控制未连接。";
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
            await controllableTrainer.setTargetResistance(resistanceLevel);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = `固定阻力下发失败：${reason}`;
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
        toggleTrainer,
        setTrainerGrade,
        setTrainerPower,
        setTrainerResistance
    };
}

function computeCanStart(state, overrides = {}) {
    const trainerConnected = overrides.trainerConnected ?? state.ble.trainer.isConnected;
    const externalPowerConnected = overrides.externalPowerConnected ?? state.ble.powerMeter.externalConnected;
    const activePowerSource = overrides.activePowerSource ?? state.ble.powerMeter.sourceType;

    return Boolean(state.liveRide.isActive || trainerConnected || externalPowerConnected || activePowerSource !== "none");
}

function mapPowerSourceStatusLabel(sourceType) {
    switch (sourceType) {
        case "external-power-meter":
            return "外置功率计";
        case "trainer":
            return "骑行台内置功率";
        default:
            return "无可用功率源";
    }
}

function resolvePowerSourceDeviceName(powerState) {
    if (powerState.activeSource === "external-power-meter") {
        return powerState.externalPowerDeviceName || "外置功率计";
    }

    if (powerState.activeSource === "trainer") {
        return powerState.trainerDeviceName || "骑行台";
    }

    return powerState.externalPowerConnected
        ? `${powerState.externalPowerDeviceName || "外置功率计"}（等待数据）`
        : "等待连接";
}
