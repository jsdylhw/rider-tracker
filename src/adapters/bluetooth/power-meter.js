const CYCLING_POWER_SERVICE = "cycling_power";
const CYCLING_POWER_MEASUREMENT = "cycling_power_measurement";
const WHEEL_REVOLUTION_DATA_PRESENT = 1 << 4;
const CRANK_REVOLUTION_DATA_PRESENT = 1 << 5;

export function createPowerMeter({ onData, onStatus }) {
    let device = null;
    let characteristic = null;
    let previousCrankSample = null;

    async function toggle() {
        if (device?.gatt?.connected) {
            await disconnect();
            return;
        }

        await connect();
    }

    async function connect() {
        ensureBluetoothAvailability();
        onStatus({ type: "connecting", message: "正在搜索蓝牙功率计..." });

        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [CYCLING_POWER_SERVICE] }]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(CYCLING_POWER_SERVICE);
        characteristic = await service.getCharacteristic(CYCLING_POWER_MEASUREMENT);

        await characteristic.startNotifications();
        characteristic.addEventListener("characteristicvaluechanged", handleMeasurement);
        device.addEventListener("gattserverdisconnected", handleDisconnected);

        onStatus({
            type: "connected",
            message: `已连接功率计：${device.name || "未命名设备"}`,
            deviceName: device.name || "未命名设备"
        });
    }

    async function disconnect() {
        if (characteristic) {
            characteristic.removeEventListener("characteristicvaluechanged", handleMeasurement);
        }

        if (device) {
            device.removeEventListener("gattserverdisconnected", handleDisconnected);
        }

        if (device?.gatt?.connected) {
            device.gatt.disconnect();
        }

        device = null;
        characteristic = null;
        previousCrankSample = null;

        onStatus({
            type: "disconnected",
            message: "功率计已断开"
        });
    }

    function handleMeasurement(event) {
        const value = event.target.value;
        const flags = value.getUint16(0, true);
        const power = value.getInt16(2, true);
        const parsedCadence = parseCadence(value, flags);

        onData({
            power,
            cadence: parsedCadence,
            timestamp: Date.now()
        });
    }

    function handleDisconnected() {
        device = null;
        characteristic = null;
        previousCrankSample = null;

        onStatus({
            type: "disconnected",
            message: "功率计已断开"
        });
    }

    function parseCadence(dataView, flags) {
        let offset = 4;

        if (flags & WHEEL_REVOLUTION_DATA_PRESENT) {
            offset += 6;
        }

        if (!(flags & CRANK_REVOLUTION_DATA_PRESENT)) {
            return null;
        }

        const cumulativeCrankRevolutions = dataView.getUint16(offset, true);
        const lastCrankEventTime = dataView.getUint16(offset + 2, true);

        const currentSample = {
            cumulativeCrankRevolutions,
            lastCrankEventTime
        };

        let cadence = null;

        if (previousCrankSample) {
            let revolutionDelta = cumulativeCrankRevolutions - previousCrankSample.cumulativeCrankRevolutions;
            let timeDelta = lastCrankEventTime - previousCrankSample.lastCrankEventTime;

            if (revolutionDelta < 0) {
                revolutionDelta += 65536;
            }

            if (timeDelta < 0) {
                timeDelta += 65536;
            }

            if (revolutionDelta > 0 && timeDelta > 0) {
                cadence = Math.round((revolutionDelta / (timeDelta / 1024)) * 60);
            }
        }

        previousCrankSample = currentSample;

        return cadence;
    }

    return {
        toggle,
        disconnect
    };
}

function ensureBluetoothAvailability() {
    if (!navigator.bluetooth) {
        throw new Error("当前浏览器不支持 Web Bluetooth");
    }
}
