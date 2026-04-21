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
    let pendingResponse = null;
    let allowInclinationFallback = true;
    let controlPointListener = null;
    let indoorBikeDataListener = null;
    let disconnectListener = null;
    let controlPointNotificationsReady = false;
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
            allowInclinationFallback = true;
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
                console.warn("[FTMS] Control Point indications unavailable, fallback to non-confirmed command mode.", error);
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

            // Send "Request Control" command and ensure trainer accepted it.
            if (controlPointNotificationsReady) {
                try {
                    await sendCommand(new Uint8Array([FTMS_OPCODES.REQUEST_CONTROL]), {
                        expectedRequestOpcode: FTMS_OPCODES.REQUEST_CONTROL,
                        awaitResponse: true
                    });
                } catch (error) {
                    // Some trainers do not respond reliably to Request Control but still accept writes.
                    console.warn("[FTMS] Request Control unconfirmed, continue with best-effort control mode.", error);
                }
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
        if (pendingResponse) {
            window.clearTimeout(pendingResponse.timeoutId);
            pendingResponse.reject(new Error("智能骑行台连接已断开"));
            pendingResponse = null;
        }
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
        
        if (responseOpcode === FTMS_RESPONSE_OPCODE) { // Response Code
            const requestOpcode = value.getUint8(1);
            const result = value.getUint8(2);

            // 0x01 = Success, 0x02 = Not Supported, 0x03 = Invalid Parameter, 0x04 = Operation Failed
            console.log(`[FTMS] Command 0x${requestOpcode.toString(16)} resulted in: 0x${result.toString(16)}`);

            if (pendingResponse) {
                const pending = pendingResponse;
                pendingResponse = null;
                window.clearTimeout(pending.timeoutId);
                pending.resolve({
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
        const { buffer, resolve, reject } = cmdQueue.shift();

        try {
            // 给骑行台硬件预留处理时间，防止指令过密
            await new Promise(r => setTimeout(r, 200));

            await controlPointChar.writeValueWithResponse(buffer);
            console.log(`[FTMS] Sent Command:`, new Uint8Array(buffer));
            
            // 简单等待一小段时间让它生效，不强制等待 Notification 
            // 因为有些骑行台在频繁下发时不会对每条指令都返回 0x80
            await new Promise(r => setTimeout(r, 100));
            await resolve();
        } catch (error) {
            console.error("[FTMS] Failed to send command:", error);
            reject(error);
        } finally {
            isCommandPending = false;
            // 继续处理队列中的下一个指令
            processCommandQueue();
        }
    }

    async function sendCommand(buffer, { expectedRequestOpcode, awaitResponse = false, responseTimeoutMs = 1500 } = {}) {
        if (!controlPointChar) {
            throw new Error("FTMS Control Point 未连接");
        }

        return new Promise((resolve, reject) => {
            // 如果队列太长（说明堵塞严重），清空之前的旧指令，只保留最新的一条
            if (cmdQueue.length > 2) {
                cmdQueue = cmdQueue.slice(-1);
            }
            cmdQueue.push({
                buffer,
                expectedRequestOpcode,
                resolve: async () => {
                    if (!awaitResponse) {
                        resolve();
                        return;
                    }
                    try {
                        const response = await waitForResponse(expectedRequestOpcode, responseTimeoutMs);
                        if (response.result !== FTMS_RESPONSE_RESULT.SUCCESS) {
                            throw new Error(`FTMS 返回失败（opcode 0x${expectedRequestOpcode?.toString(16)}): ${formatResultCode(response.result)}`);
                        }
                        resolve(response);
                    } catch (error) {
                        reject(error);
                    }
                },
                reject
            });
            processCommandQueue();
        });
    }

    function waitForResponse(expectedRequestOpcode, timeoutMs) {
        if (!controlPointNotificationsReady) {
            return Promise.reject(new Error("Control Point indications 不可用，无法等待响应"));
        }
        if (pendingResponse) {
            return Promise.reject(new Error("已有未完成的 FTMS 响应等待"));
        }

        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                pendingResponse = null;
                reject(new Error(`命令超时（opcode 0x${expectedRequestOpcode?.toString(16)})`));
            }, timeoutMs);

            pendingResponse = {
                timeoutId,
                resolve: (result) => {
                    if (typeof expectedRequestOpcode === "number" && result.requestOpcode !== expectedRequestOpcode) {
                        return;
                    }
                    resolve(result);
                },
                reject
            };
        });
    }

    function formatResultCode(resultCode) {
        switch (resultCode) {
            case FTMS_RESPONSE_RESULT.SUCCESS:
                return "0x01 success";
            case FTMS_RESPONSE_RESULT.NOT_SUPPORTED:
                return "0x02 not-supported";
            case FTMS_RESPONSE_RESULT.INVALID_PARAMETER:
                return "0x03 invalid-parameter";
            case FTMS_RESPONSE_RESULT.OPERATION_FAILED:
                return "0x04 operation-failed";
            case FTMS_RESPONSE_RESULT.NOT_PERMITTED:
                return "0x05 not-permitted";
            default:
                return `0x${resultCode.toString(16)}`;
        }
    }

    function isInclinationUnsupported(error) {
        return String(error?.message ?? "").includes("opcode 0x3")
            && String(error?.message ?? "").includes("0x02");
    }

    function isInclinationTimeout(error) {
        return String(error?.message ?? "").includes("命令超时（opcode 0x3）");
    }

    function isSimulationTimeout(error) {
        return String(error?.message ?? "").includes("命令超时（opcode 0x11）");
    }

    /**
     * 坡度模拟请求
     * Opcode: 0x03 (Set Target Inclination)
     * 参数: Inclination (SINT16, 精度 0.1%)
     * 例如：5.5% -> 55 (0x0037)
     */
    async function setTargetGrade(gradePercent) {
        // 按设备支持范围限制坡度
        const clampedGrade = Math.max(capabilities.minInclinePercent, Math.min(capabilities.maxInclinePercent, gradePercent));
        try {
            // 优先使用 Indoor Bike Simulation（0x11），兼容主流骑行台的 Sim 模式。
            if (!capabilities.simulationSupported) {
                throw new Error("设备不支持 0x11 Simulation");
            }
            await sendIndoorBikeSimulation(clampedGrade);
            return { status: "confirmed", path: "0x11" };
        } catch (error) {
            if (isSimulationTimeout(error)) {
                return { status: "unconfirmed", path: "0x11", reason: error.message };
            }
            if (!allowInclinationFallback) {
                throw new Error(`FTMS 0x11 下发失败，且 0x03 回退已禁用: ${error.message}`);
            }
            console.warn("[FTMS] 0x11 模拟命令失败，回退到 0x03 Inclination。", error);
        }

        const inclinationValue = Math.round(clampedGrade * 10); // 0.1% 精度
        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_INCLINATION);
        view.setInt16(1, inclinationValue, true);

        console.log(`[FTMS] Sending Inclination Fallback: ${clampedGrade}% (Value: ${inclinationValue})`);
        try {
            await sendCommand(new Uint8Array(buffer), {
                expectedRequestOpcode: FTMS_OPCODES.SET_TARGET_INCLINATION
            });
            return { status: "confirmed", path: "0x03-fallback" };
        } catch (error) {
            if (isInclinationUnsupported(error)) {
                allowInclinationFallback = false;
                throw new Error(`骑行台不支持稳定的 0x03 回退（已自动禁用回退）: ${error.message}`);
            }
            if (isInclinationTimeout(error)) {
                return { status: "unconfirmed", path: "0x03-fallback", reason: error.message };
            }
            throw error;
        }
    }

    /**
     * ERG 目标功率请求
     * Opcode: 0x05 (Set Target Power)
     * 参数: Power (SINT16, 精度 1W)
     */
    async function setTargetPower(powerWatts) {
        const clampedPower = Math.max(capabilities.minPowerWatts, Math.min(capabilities.maxPowerWatts, powerWatts));
        
        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_POWER); // Opcode: Set Target Power
        view.setInt16(1, clampedPower, true); // Little-endian SINT16
        
        console.log(`[FTMS] Sending ERG Target Power: ${clampedPower}W`);
        await sendCommand(new Uint8Array(buffer), {
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
        await sendCommand(new Uint8Array(buffer), {
            expectedRequestOpcode: FTMS_OPCODES.SET_TARGET_RESISTANCE
        });
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
        await sendCommand(new Uint8Array(buffer), {
            expectedRequestOpcode: FTMS_OPCODES.SET_INDOOR_BIKE_SIMULATION
        });
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
