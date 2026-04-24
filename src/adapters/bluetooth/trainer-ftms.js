const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const FTMS_CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";
const FTMS_FEATURE = "00002acc-0000-1000-8000-00805f9b34fb";
const SUPPORTED_INCLINATION_RANGE = "00002ad5-0000-1000-8000-00805f9b34fb";
const SUPPORTED_RESISTANCE_LEVEL_RANGE = "00002ad6-0000-1000-8000-00805f9b34fb";
const SUPPORTED_POWER_RANGE = "00002ad8-0000-1000-8000-00805f9b34fb";
const FTMS_RESPONSE_OPCODE = 0x80;

const FTMS_OPCODES = {
    REQUEST_CONTROL: 0x00,
    SET_TARGET_INCLINATION: 0x03,
    SET_TARGET_RESISTANCE: 0x04,
    SET_TARGET_POWER: 0x05,
    SET_INDOOR_BIKE_SIMULATION: 0x11
};

const FTMS_RESPONSE_RESULT = {
    SUCCESS: 0x01,
    NOT_SUPPORTED: 0x02,
    INVALID_PARAMETER: 0x03,
    OPERATION_FAILED: 0x04,
    NOT_PERMITTED: 0x05
};

const DEFAULT_SIMULATION_CONFIG = {
    windSpeedMps: 0,
    crr: 0.004,
    cw: 0.51
};

export function createTrainerFtms({ onStatus, onData }) {
    let device = null;
    let ftmsService = null;
    let controlPointChar = null;
    let indoorBikeDataChar = null;
    let controlPointListener = null;
    let indoorBikeDataListener = null;
    let disconnectListener = null;
    let controlPointNotificationsReady = false;
    let pendingResponse = null;
    let capabilities = {
        simulationSupported: true,
        inclinationSupported: true,
        resistanceSupported: true,
        powerSupported: true,
        minInclinePercent: -15,
        maxInclinePercent: 20,
        minResistanceLevel: 0,
        maxResistanceLevel: 100,
        minPowerWatts: 0,
        maxPowerWatts: 2000
    };

    async function connect() {
        if (!navigator.bluetooth) {
            throw new Error("当前浏览器不支持 Web Bluetooth");
        }

        onStatus({ type: "connecting", message: "正在搜索智能骑行台 (FTMS)..." });

        try {
            device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [FTMS_SERVICE] }]
            });

            const server = await device.gatt.connect();
            ftmsService = await server.getPrimaryService(FTMS_SERVICE);
            controlPointChar = await ftmsService.getCharacteristic(FTMS_CONTROL_POINT);
            indoorBikeDataChar = await getCharacteristicOrNull(ftmsService, INDOOR_BIKE_DATA);
            await hydrateCapabilities();

            disconnectListener = handleDisconnected;
            device.addEventListener("gattserverdisconnected", disconnectListener);

            // FTMS Control Point requires us to subscribe to indications first before sending commands
            try {
                await controlPointChar.startNotifications();
                controlPointListener = handleControlPointResponse;
                controlPointChar.addEventListener("characteristicvaluechanged", controlPointListener);
                controlPointNotificationsReady = true;
            } catch (error) {
                controlPointNotificationsReady = false;
                console.warn("[FTMS] Control Point indications unavailable, continue with best-effort command mode.", error);
            }

            if (indoorBikeDataChar) {
                try {
                    await indoorBikeDataChar.startNotifications();
                    indoorBikeDataListener = handleIndoorBikeData;
                    indoorBikeDataChar.addEventListener("characteristicvaluechanged", indoorBikeDataListener);
                } catch (error) {
                    console.warn("[FTMS] Indoor Bike Data notifications unavailable, continue without trainer data stream.", error);
                }
            }

            try {
                await sendCommand(new Uint8Array([FTMS_OPCODES.REQUEST_CONTROL]));
            } catch (error) {
                console.warn("[FTMS] Request Control best-effort send failed, continue if trainer still accepts writes.", error);
            }

            onStatus({
                type: "connected",
                message: `已获取智能骑行台控制权`,
                deviceName: device.name || "未命名设备"
            });
        } catch (error) {
            console.error("FTMS Connection Error:", error);
            onStatus({ type: "error", message: `连接失败: ${error.message}` });
            throw error;
        }
    }

    async function disconnect() {
        if (device?.gatt?.connected) {
            device.gatt.disconnect();
        }
        handleDisconnected();
    }

    function handleDisconnected() {
        clearPendingResponse(new Error("智能骑行台连接已断开"));
        if (controlPointChar && controlPointListener) {
            controlPointChar.removeEventListener("characteristicvaluechanged", controlPointListener);
        }
        if (indoorBikeDataChar && indoorBikeDataListener) {
            indoorBikeDataChar.removeEventListener("characteristicvaluechanged", indoorBikeDataListener);
        }
        if (device && disconnectListener) {
            device.removeEventListener("gattserverdisconnected", disconnectListener);
        }
        device = null;
        ftmsService = null;
        controlPointChar = null;
        indoorBikeDataChar = null;
        controlPointListener = null;
        indoorBikeDataListener = null;
        disconnectListener = null;
        controlPointNotificationsReady = false;
        onStatus({ type: "disconnected", message: "智能骑行台已断开" });
    }

    function handleControlPointResponse(event) {
        const value = event.target.value;
        const responseOpcode = value.getUint8(0);
        
        if (responseOpcode === FTMS_RESPONSE_OPCODE) {
            const requestOpcode = value.getUint8(1);
            const result = value.getUint8(2);
            console.log(`[FTMS] Response for 0x${requestOpcode.toString(16)}: ${formatResultCode(result)}`);

            if (pendingResponse && pendingResponse.expectedRequestOpcode === requestOpcode) {
                const resolvePending = pendingResponse.resolve;
                clearPendingResponse();
                resolvePending({
                    requestOpcode,
                    result
                });
            }
        }
    }

    function handleIndoorBikeData(event) {
        if (!onData) {
            return;
        }

        const value = event.target.value;
        const flags = value.getUint16(0, true);
        let offset = 2;
        let speedKph = null;
        let cadence = null;
        let power = null;

        speedKph = value.getUint16(offset, true) / 100;
        offset += 2;

        if (flags & 0x0002) offset += 2;

        if (flags & 0x0004) {
            cadence = Math.round(value.getUint16(offset, true) / 2);
            offset += 2;
        }

        if (flags & 0x0008) offset += 2;
        if (flags & 0x0010) offset += 3;
        if (flags & 0x0020) offset += 2;

        if (flags & 0x0040) {
            power = value.getInt16(offset, true);
        }

        onData({
            power,
            cadence,
            speedKph,
            timestamp: Date.now(),
            sourceType: "trainer"
        });
    }

    let isCommandPending = false;
    let cmdQueue = [];

    async function processCommandQueue() {
        if (isCommandPending || cmdQueue.length === 0) return;

        isCommandPending = true;
        const {
            buffer,
            resolve,
            reject,
            awaitResponse,
            expectedRequestOpcode,
            responseTimeoutMs
        } = cmdQueue.shift();

        try {
            // 给骑行台硬件预留处理时间，防止指令过密
            await new Promise(r => setTimeout(r, 200));

            const responsePromise = awaitResponse
                ? armResponseWaiter(expectedRequestOpcode, responseTimeoutMs)
                : null;

            await controlPointChar.writeValueWithResponse(buffer);
            console.log(`[FTMS] Sent Command:`, new Uint8Array(buffer));
            
            if (responsePromise) {
                const response = await responsePromise;
                if (response.result !== FTMS_RESPONSE_RESULT.SUCCESS) {
                    throw new Error(`FTMS 返回失败（opcode 0x${expectedRequestOpcode?.toString(16)}): ${formatResultCode(response.result)}`);
                }
                resolve(response);
            } else {
                // 保留一个很短的硬件生效窗口，但不等待 FTMS response。
                await new Promise(r => setTimeout(r, 100));
                resolve();
            }
        } catch (error) {
            clearPendingResponse();
            console.error("[FTMS] Failed to send command:", error);
            reject(error);
        } finally {
            isCommandPending = false;
            // 继续处理队列中的下一个指令
            processCommandQueue();
        }
    }

    async function sendCommand(buffer, {
        awaitResponse = false,
        expectedRequestOpcode = null,
        responseTimeoutMs = 2000
    } = {}) {
        if (!controlPointChar) {
            throw new Error("FTMS Control Point 未连接");
        }

        return new Promise((resolve, reject) => {
            if (cmdQueue.length > 2) {
                const dropped = cmdQueue.slice(0, -1);
                cmdQueue = cmdQueue.slice(-1);
                dropped.forEach(({ reject: rejectDropped }) => {
                    rejectDropped(new Error("FTMS 命令已被新的控制目标替换"));
                });
            }
            cmdQueue.push({
                buffer,
                awaitResponse,
                expectedRequestOpcode,
                responseTimeoutMs,
                resolve,
                reject
            });
            processCommandQueue();
        });
    }

    function armResponseWaiter(expectedRequestOpcode, timeoutMs) {
        if (!controlPointNotificationsReady) {
            return Promise.reject(new Error("当前骑行台未开启 FTMS 回包，无法使用确认模式"));
        }

        if (typeof expectedRequestOpcode !== "number") {
            return Promise.reject(new Error("确认模式缺少 FTMS request opcode"));
        }

        if (pendingResponse) {
            return Promise.reject(new Error("已有等待中的 FTMS 确认响应"));
        }

        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                clearPendingResponse();
                reject(new Error(`FTMS 确认超时（opcode 0x${expectedRequestOpcode.toString(16)})`));
            }, timeoutMs);

            pendingResponse = {
                expectedRequestOpcode,
                timeoutId,
                resolve,
                reject
            };
        });
    }

    function clearPendingResponse(error = null) {
        if (!pendingResponse) {
            return;
        }

        const current = pendingResponse;
        pendingResponse = null;
        window.clearTimeout(current.timeoutId);
        if (error) {
            current.reject(error);
        }
    }

    function formatResultCode(resultCode) {
        return ({
            0x01: "0x01 success",
            0x02: "0x02 not-supported",
            0x03: "0x03 invalid-parameter",
            0x04: "0x04 operation-failed",
            0x05: "0x05 not-permitted"
        })[resultCode] ?? `0x${resultCode.toString(16)}`;
    }

    /**
     * 坡度模拟请求
     * Opcode: 0x03 (Set Target Inclination)
     * 参数: Inclination (SINT16, 精度 0.1%)
     * 例如：5.5% -> 55 (0x0037)
     */
    async function setTargetGrade(gradePercent) {
        const clampedGrade = Math.max(capabilities.minInclinePercent, Math.min(capabilities.maxInclinePercent, gradePercent));

        if (capabilities.simulationSupported) {
            await sendIndoorBikeSimulation(clampedGrade);
            return;
        }

        if (!capabilities.inclinationSupported) {
            throw new Error("当前骑行台不支持坡度模拟控制");
        }

        const inclinationValue = Math.round(clampedGrade * 10); // 0.1% 精度
        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_INCLINATION);
        view.setInt16(1, inclinationValue, true);

        console.log(`[FTMS] Sending Inclination Grade: ${clampedGrade}% (Value: ${inclinationValue})`);
        await sendCommand(new Uint8Array(buffer));
    }

    /**
     * ERG 目标功率请求
     * Opcode: 0x05 (Set Target Power)
     * 参数: Power (SINT16, 精度 1W)
     */
    async function setTargetPower(powerWatts, options = {}) {
        const clampedPower = Math.max(capabilities.minPowerWatts, Math.min(capabilities.maxPowerWatts, powerWatts));

        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_POWER); // Opcode: Set Target Power
        view.setInt16(1, clampedPower, true); // Little-endian SINT16
        
        console.log(`[FTMS] Sending ERG Target Power: ${clampedPower}W`);
        await sendCommand(new Uint8Array(buffer), {
            awaitResponse: options.confirm === true,
            expectedRequestOpcode: FTMS_OPCODES.SET_TARGET_POWER
        });
    }

    async function setTargetResistance(resistanceLevel) {
        if (!capabilities.resistanceSupported) {
            throw new Error("当前骑行台不支持固定阻力控制");
        }

        const clampedResistance = Math.max(
            capabilities.minResistanceLevel,
            Math.min(capabilities.maxResistanceLevel, resistanceLevel)
        );

        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_RESISTANCE);
        view.setInt16(1, Math.round(clampedResistance * 10), true);

        console.log(`[FTMS] Sending Resistance Target: ${clampedResistance}%`);
        await sendCommand(new Uint8Array(buffer));
    }

    async function sendIndoorBikeSimulation(gradePercent) {
        const gradeRaw = Math.round(gradePercent * 100); // 0.01%
        const windRaw = Math.round(DEFAULT_SIMULATION_CONFIG.windSpeedMps * 1000); // 0.001 m/s
        const crrRaw = Math.max(0, Math.min(255, Math.round(DEFAULT_SIMULATION_CONFIG.crr * 10000))); // 0.0001
        const cwRaw = Math.max(0, Math.min(255, Math.round(DEFAULT_SIMULATION_CONFIG.cw * 100))); // 0.01 kg/m

        const buffer = new ArrayBuffer(7);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_INDOOR_BIKE_SIMULATION);
        view.setInt16(1, windRaw, true);
        view.setInt16(3, gradeRaw, true);
        view.setUint8(5, crrRaw);
        view.setUint8(6, cwRaw);

        console.log(`[FTMS] Sending Simulation Grade: ${gradePercent}% (gradeRaw: ${gradeRaw})`);
        await sendCommand(new Uint8Array(buffer));
    }

    async function hydrateCapabilities() {
        capabilities = {
            simulationSupported: true,
            inclinationSupported: true,
            resistanceSupported: true,
            powerSupported: true,
            minInclinePercent: -15,
            maxInclinePercent: 20,
            minResistanceLevel: 0,
            maxResistanceLevel: 100,
            minPowerWatts: 0,
            maxPowerWatts: 2000
        };

        if (!ftmsService) {
            return;
        }

        try {
            const featureChar = await ftmsService.getCharacteristic(FTMS_FEATURE);
            const featureValue = await featureChar.readValue();
            const targetFlags = featureValue.getUint32(4, true);
            capabilities.powerSupported = !!(targetFlags & (1 << 3));
            capabilities.inclinationSupported = !!(targetFlags & (1 << 1));
            capabilities.resistanceSupported = !!(targetFlags & (1 << 2));
            capabilities.simulationSupported = !!(targetFlags & (1 << 13));
        } catch {
            // Some trainers don't expose feature characteristic reliably.
        }

        try {
            const inclineRangeChar = await ftmsService.getCharacteristic(SUPPORTED_INCLINATION_RANGE);
            const v = await inclineRangeChar.readValue();
            capabilities.minInclinePercent = v.getInt16(0, true) / 10;
            capabilities.maxInclinePercent = v.getInt16(2, true) / 10;
        } catch {
            // keep defaults
        }

        try {
            const resistanceRangeChar = await ftmsService.getCharacteristic(SUPPORTED_RESISTANCE_LEVEL_RANGE);
            const v = await resistanceRangeChar.readValue();
            capabilities.minResistanceLevel = v.getInt16(0, true) / 10;
            capabilities.maxResistanceLevel = v.getInt16(2, true) / 10;
        } catch {
            // keep defaults
        }

        try {
            const powerRangeChar = await ftmsService.getCharacteristic(SUPPORTED_POWER_RANGE);
            const v = await powerRangeChar.readValue();
            capabilities.minPowerWatts = v.getInt16(0, true);
            capabilities.maxPowerWatts = v.getInt16(2, true);
        } catch {
            // keep defaults
        }
    }

    return {
        connect,
        disconnect,
        setTargetGrade,
        setTargetPower,
        setTargetResistance,
        getCapabilities: () => ({ ...capabilities }),
        get isConnected() { return !!device?.gatt?.connected; }
    };
}

async function getCharacteristicOrNull(service, uuid) {
    try {
        return await service.getCharacteristic(uuid);
    } catch {
        return null;
    }
}
