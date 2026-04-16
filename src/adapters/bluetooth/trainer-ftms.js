const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const FTMS_CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const FTMS_RESPONSE_OPCODE = 0x80;

const FTMS_OPCODES = {
    REQUEST_CONTROL: 0x00,
    SET_TARGET_INCLINATION: 0x03,
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

export function createTrainerFtms({ onStatus }) {
    let device = null;
    let controlPointChar = null;
    let pendingResponse = null;
    let commandQueue = Promise.resolve();
    let allowInclinationFallback = true;

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
            const service = await server.getPrimaryService(FTMS_SERVICE);
            controlPointChar = await service.getCharacteristic(FTMS_CONTROL_POINT);
            allowInclinationFallback = true;

            device.addEventListener("gattserverdisconnected", handleDisconnected);

            // FTMS Control Point requires us to subscribe to indications first before sending commands
            await controlPointChar.startNotifications();
            controlPointChar.addEventListener("characteristicvaluechanged", handleControlPointResponse);

            // Send "Request Control" command and ensure trainer accepted it.
            await sendCommand(new Uint8Array([FTMS_OPCODES.REQUEST_CONTROL]), {
                expectedRequestOpcode: FTMS_OPCODES.REQUEST_CONTROL
            });

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
        commandQueue = Promise.resolve();
        device = null;
        controlPointChar = null;
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

    async function sendCommand(buffer, { expectedRequestOpcode, timeoutMs = 4000 } = {}) {
        const commandBytes = new Uint8Array(buffer);
        return enqueueCommand(async () => {
            if (!controlPointChar) {
                throw new Error("FTMS Control Point 未连接");
            }

            const requestOpcode = expectedRequestOpcode ?? commandBytes[0];
            try {
                await controlPointChar.writeValueWithResponse(buffer);
                console.log("[FTMS] Sent Command:", commandBytes);
                const response = await waitForResponse(requestOpcode, timeoutMs);
                return response;
            } catch (error) {
                console.error("[FTMS] Failed to send command:", error);
                throw error;
            }
        });
    }

    function enqueueCommand(task) {
        const queuedTask = commandQueue.then(task, task);
        commandQueue = queuedTask.catch(() => undefined);
        return queuedTask;
    }

    function waitForResponse(requestOpcode, timeoutMs) {
        if (pendingResponse) {
            return Promise.reject(new Error("FTMS 控制点忙，等待上一个命令响应中。"));
        }

        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                if (pendingResponse?.requestOpcode === requestOpcode) {
                    pendingResponse = null;
                }
                reject(new Error(`FTMS 命令超时（opcode 0x${requestOpcode.toString(16)}）`));
            }, timeoutMs);

            pendingResponse = {
                requestOpcode,
                timeoutId,
                resolve: (response) => {
                    if (response.requestOpcode !== requestOpcode) {
                        reject(new Error(`FTMS 响应 opcode 不匹配，期望 0x${requestOpcode.toString(16)}，收到 0x${response.requestOpcode.toString(16)}`));
                        return;
                    }
                    if (response.result !== FTMS_RESPONSE_RESULT.SUCCESS) {
                        reject(new Error(`FTMS 命令失败（opcode 0x${requestOpcode.toString(16)}，result ${formatResultCode(response.result)}）`));
                        return;
                    }
                    resolve(response);
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
        // 限制坡度在 -15% 到 +20% 之间
        const clampedGrade = Math.max(-15, Math.min(20, gradePercent));
        try {
            // 优先使用 Indoor Bike Simulation（0x11），兼容主流骑行台的 Sim 模式。
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
        const clampedPower = Math.max(0, Math.min(2000, powerWatts));
        
        const buffer = new ArrayBuffer(3);
        const view = new DataView(buffer);
        view.setUint8(0, FTMS_OPCODES.SET_TARGET_POWER); // Opcode: Set Target Power
        view.setInt16(1, clampedPower, true); // Little-endian SINT16
        
        console.log(`[FTMS] Sending ERG Target Power: ${clampedPower}W`);
        await sendCommand(new Uint8Array(buffer), {
            expectedRequestOpcode: FTMS_OPCODES.SET_TARGET_POWER
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

    return {
        connect,
        disconnect,
        setTargetGrade,
        setTargetPower,
        get isConnected() { return !!device?.gatt?.connected; }
    };
}
