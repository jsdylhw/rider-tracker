const CYCLING_POWER_SERVICE = "00001818-0000-1000-8000-00805f9b34fb";
const CYCLING_POWER_MEASUREMENT = "00002a63-0000-1000-8000-00805f9b34fb";

const CSC_SERVICE = "00001816-0000-1000-8000-00805f9b34fb";
const CSC_MEASUREMENT = "00002a5b-0000-1000-8000-00805f9b34fb";

const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";

export function createPowerMeter({ onData, onStatus }) {
    let device = null;
    
    let currentPower = null;
    let currentCadence = null;
    
    let previousCrankSamples = {
        cp: null,
        csc: null
    };
    let cadenceTimeout = null;

    async function toggle() {
        if (device?.gatt?.connected) {
            await disconnect();
            return;
        }
        await connect();
    }

    async function connect() {
        if (!navigator.bluetooth) {
            throw new Error("当前浏览器不支持 Web Bluetooth");
        }
        
        onStatus({ type: "connecting", message: "正在搜索蓝牙功率计/骑行台..." });

        try {
            device = await navigator.bluetooth.requestDevice({
                filters: [
                    { services: [CYCLING_POWER_SERVICE] },
                    { services: [FTMS_SERVICE] },
                    { services: [CSC_SERVICE] }
                ],
                optionalServices: [CYCLING_POWER_SERVICE, CSC_SERVICE, FTMS_SERVICE]
            });

            const server = await device.gatt.connect();
            device.addEventListener("gattserverdisconnected", handleDisconnected);

            let foundServices = [];

            // 1. 尝试连接 FTMS (智能骑行台服务)，它通常直接包含功率和踏频
            try {
                const ftmsService = await server.getPrimaryService(FTMS_SERVICE);
                const indoorBikeChar = await ftmsService.getCharacteristic(INDOOR_BIKE_DATA);
                await indoorBikeChar.startNotifications();
                indoorBikeChar.addEventListener("characteristicvaluechanged", handleIndoorBikeData);
                foundServices.push("FTMS");
            } catch (e) { /* Ignore */ }

            // 2. 尝试连接传统的 Cycling Power 服务
            try {
                const cpService = await server.getPrimaryService(CYCLING_POWER_SERVICE);
                const cpChar = await cpService.getCharacteristic(CYCLING_POWER_MEASUREMENT);
                await cpChar.startNotifications();
                cpChar.addEventListener("characteristicvaluechanged", handlePowerMeasurement);
                foundServices.push("Power");
            } catch (e) { /* Ignore */ }

            // 3. 尝试连接独立的 CSC (速度与踏频) 服务
            try {
                const cscService = await server.getPrimaryService(CSC_SERVICE);
                const cscChar = await cscService.getCharacteristic(CSC_MEASUREMENT);
                await cscChar.startNotifications();
                cscChar.addEventListener("characteristicvaluechanged", handleCscMeasurement);
                foundServices.push("CSC");
            } catch (e) { /* Ignore */ }

            if (foundServices.length === 0) {
                throw new Error("设备未提供受支持的骑行数据服务！");
            }

            onStatus({
                type: "connected",
                message: `已连接 (${foundServices.join(', ')})：${device.name || "未命名设备"}`,
                deviceName: device.name || "未命名设备"
            });

        } catch (error) {
            console.error("BLE Connect Error:", error);
            onStatus({ type: "error", message: `连接失败: ${error.message}` });
            device = null;
        }
    }

    async function disconnect() {
        if (device?.gatt?.connected) {
            device.gatt.disconnect();
        }
        handleDisconnected();
    }

    function handleDisconnected() {
        device = null;
        previousCrankSamples = { cp: null, csc: null };
        onStatus({ type: "disconnected", message: "设备已断开" });
    }

    function emitData() {
        clearTimeout(cadenceTimeout);
        cadenceTimeout = setTimeout(() => {
            currentCadence = 0;
            onData({ power: currentPower, cadence: 0, timestamp: Date.now() });
        }, 2500);

        onData({
            power: currentPower,
            cadence: currentCadence,
            timestamp: Date.now()
        });
    }

    function handlePowerMeasurement(event) {
        const value = event.target.value;
        const flags = value.getUint16(0, true);
        currentPower = value.getInt16(2, true);
        
        const parsedCadence = parseCrankRevolutions(value, flags, 'cp');
        if (parsedCadence !== null) {
            currentCadence = parsedCadence;
        }
        
        emitData();
    }

    function handleCscMeasurement(event) {
        const value = event.target.value;
        const flags = value.getUint8(0);
        
        const parsedCadence = parseCrankRevolutions(value, flags, 'csc');
        if (parsedCadence !== null) {
            currentCadence = parsedCadence;
        }
        
        emitData();
    }

    function handleIndoorBikeData(event) {
        const value = event.target.value;
        const flags = value.getUint16(0, true);
        let offset = 2; // 跳过 Flags

        // Instantaneous Speed 总是存在的 (2 bytes)
        offset += 2; 

        if (flags & 0x0002) offset += 2; // Avg Speed

        // 踏频 (Instantaneous Cadence)
        if (flags & 0x0004) {
            const cadenceRaw = value.getUint16(offset, true);
            currentCadence = Math.round(cadenceRaw / 2); // FTMS 踏频分辨率是 0.5 RPM
            offset += 2;
        }

        if (flags & 0x0008) offset += 2; // Avg Cadence
        if (flags & 0x0010) offset += 3; // Total Distance
        if (flags & 0x0020) offset += 2; // Resistance Level

        // 功率 (Instantaneous Power)
        if (flags & 0x0040) {
            currentPower = value.getInt16(offset, true);
            offset += 2;
        }

        emitData();
    }

    function parseCrankRevolutions(value, flags, source) {
        let offset = 0;
        let hasCrank = false;

        if (source === 'cp') {
            offset = 4; // 跳过 Flags(2) + Power(2)
            if (flags & 0x0001) offset += 1; // Balance
            if (flags & 0x0004) offset += 2; // Accumulated Torque
            if (flags & 0x0010) offset += 6; // Wheel Revs
            hasCrank = !!(flags & 0x0020);
        } else if (source === 'csc') {
            offset = 1; // 跳过 Flags(1)
            if (flags & 0x01) offset += 6; // Wheel Revs
            hasCrank = !!(flags & 0x02);
        }

        if (!hasCrank || value.byteLength < offset + 4) {
            return null;
        }

        const cumulativeCrankRevolutions = value.getUint16(offset, true);
        const lastCrankEventTime = value.getUint16(offset + 2, true);
        const currentSample = { cumulativeCrankRevolutions, lastCrankEventTime };

        let cadence = null;
        const prev = previousCrankSamples[source];

        if (prev) {
            let revolutionDelta = cumulativeCrankRevolutions - prev.cumulativeCrankRevolutions;
            let timeDelta = lastCrankEventTime - prev.lastCrankEventTime;

            // 处理计数器溢出回绕 (16-bit)
            if (revolutionDelta < 0) revolutionDelta += 65536;
            if (timeDelta < 0) timeDelta += 65536;

            if (revolutionDelta > 0 && timeDelta > 0) {
                // 1024 倒数是时间的单位 (1/1024秒)
                cadence = Math.round((revolutionDelta / (timeDelta / 1024)) * 60);
            } else if (revolutionDelta === 0 && timeDelta > 0) {
                // 时间走动但曲柄未转，说明停止踩踏
                cadence = 0;
            }
        }

        previousCrankSamples[source] = currentSample;
        return cadence;
    }

    return {
        toggle,
        disconnect
    };
}