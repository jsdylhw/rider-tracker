import { createPowerMeter } from "./power-meter.js";
import { createTrainerFtms } from "./trainer-ftms.js";

const DATA_STALE_MS = 4000;

export function createControllableTrainer({
    onTrainerStatus,
    onPowerSourceStatus,
    onData
}) {
    let trainerStatus = createDisconnectedStatus("等待连接");
    let externalPowerStatus = createDisconnectedStatus("等待连接");
    let trainerData = null;
    let externalPowerData = null;

    const trainerFtms = createTrainerFtms({
        onStatus: (status) => {
            trainerStatus = normalizeStatus(status, trainerStatus);
            onTrainerStatus?.({
                ...status,
                capabilities: trainerFtms.getCapabilities?.() ?? null
            });
            emitPowerSourceStatus();
            emitMergedData();
        },
        onData: (data) => {
            trainerData = data;
            emitPowerSourceStatus();
            emitMergedData();
        }
    });

    const externalPowerMeter = createPowerMeter({
        onStatus: (status) => {
            externalPowerStatus = normalizeStatus(status, externalPowerStatus);
            emitPowerSourceStatus();
            emitMergedData();
        },
        onData: (data) => {
            externalPowerData = {
                ...data,
                sourceType: "external-power-meter"
            };
            emitPowerSourceStatus();
            emitMergedData();
        }
    });

    async function toggle() {
        if (trainerFtms.isConnected) {
            await trainerFtms.disconnect();
            return;
        }

        await trainerFtms.connect();
    }

    async function disconnect() {
        await Promise.allSettled([
            trainerFtms.isConnected ? trainerFtms.disconnect() : Promise.resolve(),
            externalPowerMeter.isConnected ? externalPowerMeter.disconnect() : Promise.resolve()
        ]);
    }

    async function toggleExternalPowerMeter() {
        await externalPowerMeter.toggle();
    }

    async function setTargetGrade(gradePercent) {
        return trainerFtms.setTargetGrade(gradePercent);
    }

    async function activateControl(controlMode) {
        return trainerFtms.activateControl({
            controlModeLabel: mapControlModeLabel(controlMode)
        });
    }

    async function setTargetPower(powerWatts, options) {
        return trainerFtms.setTargetPower(powerWatts, options);
    }

    async function setTargetResistance(resistanceLevel) {
        return trainerFtms.setTargetResistance(resistanceLevel);
    }

    function emitPowerSourceStatus() {
        onPowerSourceStatus?.(getPowerSourceSnapshot());
    }

    function emitMergedData() {
        const preferredSource = resolveActivePowerSource();
        const payload = preferredSource === "external-power-meter"
            ? externalPowerData
            : preferredSource === "trainer"
                ? trainerData
                : null;

        onData?.({
            power: payload?.power ?? null,
            cadence: payload?.cadence ?? null,
            speedKph: payload?.speedKph ?? null,
            timestamp: payload?.timestamp ?? Date.now(),
            sourceType: preferredSource
        });
    }

    function resolveActivePowerSource() {
        if (isFresh(externalPowerData) && externalPowerStatus.isConnected) {
            return "external-power-meter";
        }

        if (isFresh(trainerData) && trainerStatus.isConnected) {
            return "trainer";
        }

        if (externalPowerStatus.isConnected) {
            return "external-power-meter";
        }

        if (trainerStatus.isConnected) {
            return "trainer";
        }

        return "none";
    }

    function getPowerSourceSnapshot() {
        const activeSource = resolveActivePowerSource();

        return {
            activeSource,
            activeSourceLabel: mapPowerSourceLabel(activeSource),
            externalPowerConnected: externalPowerStatus.isConnected,
            externalPowerConnecting: externalPowerStatus.isConnecting,
            externalPowerDeviceName: externalPowerStatus.deviceName,
            trainerConnected: trainerStatus.isConnected,
            trainerDeviceName: trainerStatus.deviceName,
            trainerControlReady: trainerStatus.controlReady === true
        };
    }

    return {
        toggle,
        disconnect,
        toggleExternalPowerMeter,
        activateControl,
        setTargetGrade,
        setTargetPower,
        setTargetResistance,
        getPowerSourceSnapshot,
        getCapabilities: () => trainerFtms.getCapabilities?.() ?? null,
        get isConnected() {
            return trainerFtms.isConnected;
        },
        get hasAnyPowerSource() {
            return resolveActivePowerSource() !== "none";
        }
    };
}

function normalizeStatus(status, previous) {
    return {
        isConnecting: status.type === "connecting",
        isConnected: status.type === "connected",
        deviceName: status.deviceName ?? previous.deviceName ?? "等待连接",
        phase: status.phase ?? previous.phase ?? "disconnected",
        controlReady: status.controlReady === true
    };
}

function createDisconnectedStatus(deviceName) {
    return {
        isConnecting: false,
        isConnected: false,
        deviceName,
        phase: "disconnected",
        controlReady: false
    };
}

function mapControlModeLabel(controlMode) {
    switch (controlMode) {
        case "sim":
            return "坡度模拟";
        case "erg":
            return "ERG 模式";
        case "resistance":
            return "固定阻力模式";
        default:
            return "当前训练模式";
    }
}

function isFresh(sample) {
    return Boolean(sample?.timestamp) && (Date.now() - sample.timestamp) <= DATA_STALE_MS;
}

function mapPowerSourceLabel(sourceType) {
    switch (sourceType) {
        case "external-power-meter":
            return "外置功率计";
        case "trainer":
            return "骑行台内置功率";
        default:
            return "无可用功率源";
    }
}
