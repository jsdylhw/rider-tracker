const CYCLING_POWER_SERVICE = "00001818-0000-1000-8000-00805f9b34fb";
const CYCLING_POWER_MEASUREMENT = "00002a63-0000-1000-8000-00805f9b34fb";
const WHEEL_REVOLUTION_DATA_PRESENT = 0x0010; // Bit 4
const CRANK_REVOLUTION_DATA_PRESENT = 0x0020; // Bit 5

export function createPowerMeter({ onData, onStatus }) {
    let device = null;
    let characteristic = null;
    let previousCrankSample = null;
    let cadenceTimeout = null;

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

        // 如果用户停止踩踏，踏频时间戳不会更新。我们设置一个 2.5 秒的超时来将踏频归零
        clearTimeout(cadenceTimeout);
        cadenceTimeout = setTimeout(() => {
            onData({ power, cadence: 0, timestamp: Date.now() });
        }, 2500);

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

    function parseCadence(value, flags) {
        let offset = 4; // Start after Flags (2 bytes) and Instantaneous Power (2 bytes)

        // 1. Pedal Power Balance Present (Bit 0)
        if (flags & 0x0001) {
            offset += 1;
            // Note: If Pedal Power Balance Reference is also present (Bit 1 in Cycling Power Measurement), 
            // it doesn't add extra bytes, it just changes the meaning of the 1 byte balance.
        }
        
        // 2. Accumulated Torque Present (Bit 2 - 0x0004)
        if (flags & 0x0004) offset += 2;
        
        // 3. Wheel Revolution Data Present (Bit 4 - 0x0010)
        if (flags & WHEEL_REVOLUTION_DATA_PRESENT) {
            offset += 6; // 4 bytes for revs, 2 bytes for time
        }

        // Check if Crank Revolution Data is present (Bit 5 - 0x0020)
        if (!(flags & CRANK_REVOLUTION_DATA_PRESENT)) {
            return null;
        }

        // Safely check if we have enough bytes left
        if (value.byteLength < offset + 4) {
            return null;
        }

        const cumulativeCrankRevolutions = value.getUint16(offset, true);
        const lastCrankEventTime = value.getUint16(offset + 2, true);

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
