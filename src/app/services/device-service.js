import { createHeartRateMonitor } from "../../adapters/bluetooth/heart-rate-monitor.js";
import { createControllableTrainer } from "../../adapters/bluetooth/controllable-trainer.js";
import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { resolveTrainerControlModeForWorkoutMode } from "../../domain/workout/trainer-command.js";
import {
    clearHeartRateSample,
    clearPowerSample,
    ingestHeartRateSample,
    ingestPowerSample
} from "../realtime/sensor-sampling.js";

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
            store.setState((state) => {
                const nextSampling = ingestHeartRateSample(state.ble.sampling, data);

                return {
                    ...state,
                    ble: {
                        ...state.ble,
                        heartRate: {
                            ...state.ble.heartRate,
                            value: nextSampling.heartRate.value,
                            lastUpdated: nextSampling.heartRate.timestamp
                        },
                        sampling: nextSampling
                    }
                };
            });
        },
        onStatus: (status) => {
            store.setState((state) => {
                const nextSampling = status.type === "disconnected"
                    ? clearHeartRateSample(state.ble.sampling)
                    : state.ble.sampling;

                return {
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
                        },
                        sampling: nextSampling
                    },
                    statusText: status.message
                };
            });
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
                        controlActivating: status.phase === "control-activating",
                        controlReady: status.controlReady === true,
                        statusLabel: mapTrainerStatusLabel(status),
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
            store.setState((state) => {
                const nextSampling = powerState.activeSource === "none"
                    ? clearPowerSample(state.ble.sampling)
                    : state.ble.sampling;

                return {
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
                            externalDeviceName: powerState.externalPowerDeviceName,
                            ...(powerState.activeSource === "none"
                                ? {
                                    power: null,
                                    cadence: null,
                                    averagePower: null,
                                    sampleCount: 0,
                                    powerTotal: 0,
                                    lastUpdated: null
                                }
                                : {})
                        },
                        sampling: nextSampling
                    },
                    liveRide: {
                        ...state.liveRide,
                        canStart: computeCanStart(state, {
                            trainerConnected: powerState.trainerConnected,
                            externalPowerConnected: powerState.externalPowerConnected,
                            activePowerSource: powerState.activeSource
                        })
                    }
                };
            });
        },
        onData: (data) => {
            store.setState((state) => {
                const nextSampling = ingestPowerSample(state.ble.sampling, data);

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
                            power: nextSampling.power.value,
                            cadence: nextSampling.cadence.value,
                            averagePower: nextSampling.power.average,
                            sampleCount: nextSampling.power.sampleCount,
                            powerTotal: nextSampling.power.total,
                            lastUpdated: nextSampling.power.timestamp
                        },
                        sampling: nextSampling
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
            await controllableTrainer.activateControl("sim");
            await controllableTrainer.setTargetGrade(gradePercent);
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

    async function setTrainerPower(powerWatts, options) {
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
            await controllableTrainer.activateControl("erg");
            await controllableTrainer.setTargetPower(powerWatts, options);
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
            await controllableTrainer.activateControl("resistance");
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
        prepareTrainerControlForWorkoutMode,
        setTrainerGrade,
        setTrainerPower,
        setTrainerResistance
    };

    async function prepareTrainerControlForWorkoutMode(workoutMode) {
        if (!controllableTrainer.isConnected) {
            return false;
        }

        const controlMode = resolveTrainerControlModeForWorkoutMode(workoutMode);
        const modeLabel = getWorkoutModeLabel(workoutMode);

        try {
            await controllableTrainer.activateControl(controlMode);
            store.setState((state) => ({
                ...state,
                statusText: `已为训练模式“${modeLabel}”激活骑行台 FTMS 控制。`,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: `训练模式已切换为 ${modeLabel}，骑行台控制链路就绪。`
                }
            }));
            return true;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            store.setState((state) => ({
                ...state,
                statusText: `训练模式“${modeLabel}”激活骑行台控制失败：${reason}`,
                liveRide: {
                    ...state.liveRide,
                    statusMeta: `训练模式已切换为 ${modeLabel}，但 FTMS 控制激活失败：${reason}`
                }
            }));
            return false;
        }
    }
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

function mapTrainerStatusLabel(status) {
    if (status.type === "connecting") {
        return "连接中";
    }
    if (status.type !== "connected") {
        return "未连接";
    }
    if (status.phase === "control-ready") {
        return "控制已激活";
    }
    if (status.phase === "control-activating") {
        return "激活控制中";
    }
    if (status.phase === "data-ready") {
        return "仅数据已连接";
    }
    return "已连接";
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
