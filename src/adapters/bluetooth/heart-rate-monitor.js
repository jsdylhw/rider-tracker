const HEART_RATE_SERVICE = "heart_rate";
const HEART_RATE_MEASUREMENT = "heart_rate_measurement";

export function createHeartRateMonitor({ onData, onStatus }) {
    let device = null;
    let characteristic = null;

    async function toggle() {
        if (device?.gatt?.connected) {
            await disconnect();
            return;
        }

        await connect();
    }

    async function connect() {
        ensureBluetoothAvailability();
        onStatus({ type: "connecting", message: "正在搜索蓝牙心率设备..." });

        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [HEART_RATE_SERVICE] }]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(HEART_RATE_SERVICE);
        characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT);

        await characteristic.startNotifications();
        characteristic.addEventListener("characteristicvaluechanged", handleMeasurement);
        device.addEventListener("gattserverdisconnected", handleDisconnected);

        onStatus({
            type: "connected",
            message: `已连接心率带：${device.name || "未命名设备"}`,
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

        onStatus({
            type: "disconnected",
            message: "心率带已断开"
        });
    }

    function handleMeasurement(event) {
        const value = event.target.value;
        const flags = value.getUint8(0);
        const rate16Bits = flags & 0x01;
        const heartRate = rate16Bits ? value.getUint16(1, true) : value.getUint8(1);

        onData({
            heartRate,
            timestamp: Date.now()
        });
    }

    function handleDisconnected() {
        device = null;
        characteristic = null;

        onStatus({
            type: "disconnected",
            message: "心率带已断开"
        });
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
