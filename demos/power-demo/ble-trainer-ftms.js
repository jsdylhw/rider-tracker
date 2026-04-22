const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const FTMS_CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const FTMS_RESPONSE_OPCODE = 0x80;

const FTMS_OPCODES = {
  REQUEST_CONTROL: 0x00,
  SET_TARGET_INCLINATION: 0x03,
  SET_INDOOR_BIKE_SIMULATION: 0x11
};

const FTMS_RESULT = {
  SUCCESS: 0x01,
  NOT_SUPPORTED: 0x02,
  INVALID_PARAMETER: 0x03,
  OPERATION_FAILED: 0x04,
  NOT_PERMITTED: 0x05
};

const SIM_DEFAULTS = {
  windSpeedMps: 0,
  crr: 0.004,
  windResistance: 0.51
};

export function createTrainerSimController({ onStatus }) {
  let device = null;
  let controlPoint = null;
  let pendingResponse = null;
  let commandQueue = Promise.resolve();
  let allowInclinationFallback = true;

  async function toggle() {
    if (device?.gatt?.connected) {
      disconnect();
      return;
    }
    await connect();
  }

  async function connect() {
    if (!navigator.bluetooth) {
      throw new Error("当前浏览器不支持 Web Bluetooth");
    }
    onStatus({ type: "connecting", message: "正在搜索 FTMS 骑行台..." });

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }]
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);
    controlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT);
    allowInclinationFallback = true;

    device.addEventListener("gattserverdisconnected", handleDisconnected);
    await controlPoint.startNotifications();
    controlPoint.addEventListener("characteristicvaluechanged", onControlResponse);

    await sendCommand(new Uint8Array([FTMS_OPCODES.REQUEST_CONTROL]), FTMS_OPCODES.REQUEST_CONTROL);

    onStatus({
      type: "connected",
      message: "骑行台控制已连接",
      deviceName: device.name || "未命名设备"
    });
  }

  function disconnect() {
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
    }
    handleDisconnected();
  }

  function handleDisconnected() {
    if (pendingResponse) {
      clearTimeout(pendingResponse.timeoutId);
      pendingResponse.reject(new Error("设备已断开"));
      pendingResponse = null;
    }
    commandQueue = Promise.resolve();
    controlPoint = null;
    device = null;
    onStatus({ type: "disconnected", message: "骑行台已断开" });
  }

  function onControlResponse(event) {
    const data = event.target.value;
    const opcode = data.getUint8(0);
    if (opcode !== FTMS_RESPONSE_OPCODE || !pendingResponse) return;

    const requestOpcode = data.getUint8(1);
    const result = data.getUint8(2);
    const pending = pendingResponse;
    pendingResponse = null;
    clearTimeout(pending.timeoutId);
    pending.resolve({ requestOpcode, result });
  }

  function enqueue(task) {
    const queued = commandQueue.then(task, task);
    commandQueue = queued.catch(() => undefined);
    return queued;
  }

  async function sendCommand(payload, expectedOpcode, timeoutMs = 4000) {
    return enqueue(async () => {
      if (!controlPoint) {
        throw new Error("FTMS Control Point 未连接");
      }
      await controlPoint.writeValueWithResponse(payload);
      const response = await waitForResponse(expectedOpcode, timeoutMs);
      if (response.result !== FTMS_RESULT.SUCCESS) {
        throw new Error(`FTMS 命令失败: opcode 0x${expectedOpcode.toString(16)}, result ${formatResultCode(response.result)}`);
      }
      return response;
    });
  }

  function waitForResponse(expectedOpcode, timeoutMs) {
    if (pendingResponse) {
      return Promise.reject(new Error("控制点忙，上一条命令尚未返回"));
    }
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (pendingResponse?.expectedOpcode === expectedOpcode) {
          pendingResponse = null;
        }
        reject(new Error(`FTMS 命令超时: 0x${expectedOpcode.toString(16)}`));
      }, timeoutMs);

      pendingResponse = {
        expectedOpcode,
        timeoutId,
        resolve: (response) => {
          if (response.requestOpcode !== expectedOpcode) {
            reject(new Error(`FTMS 响应 opcode 不匹配, expected 0x${expectedOpcode.toString(16)} got 0x${response.requestOpcode.toString(16)}`));
            return;
          }
          resolve(response);
        },
        reject
      };
    });
  }

  async function setGradePercent(gradePercent) {
    const grade = clamp(gradePercent, -10, 10);
    try {
      await sendSimulation(grade);
      return { status: "confirmed", path: "0x11" };
    } catch (simError) {
      if (isSimulationTimeout(simError)) {
        return { status: "unconfirmed", path: "0x11", reason: simError.message };
      }
      if (!allowInclinationFallback) {
        throw new Error(`FTMS 0x11 下发失败，且 0x03 回退已禁用: ${simError.message}`);
      }
    }

    try {
      await sendInclinationFallback(grade);
      return { status: "confirmed", path: "0x03-fallback" };
    } catch (fallbackError) {
      if (isInclinationUnsupported(fallbackError)) {
        allowInclinationFallback = false;
        throw new Error(`骑行台不支持稳定的 0x03 回退（已自动禁用回退）: ${fallbackError.message}`);
      }
      if (isInclinationTimeout(fallbackError)) {
        return { status: "unconfirmed", path: "0x03-fallback", reason: fallbackError.message };
      }
      throw fallbackError;
    }
  }

  async function sendSimulation(gradePercent) {
    const windRaw = Math.round(SIM_DEFAULTS.windSpeedMps * 1000);
    const gradeRaw = Math.round(gradePercent * 100);
    const crrRaw = clamp(Math.round(SIM_DEFAULTS.crr * 10000), 0, 255);
    const windResRaw = clamp(Math.round(SIM_DEFAULTS.windResistance * 100), 0, 255);

    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint8(0, FTMS_OPCODES.SET_INDOOR_BIKE_SIMULATION);
    view.setInt16(1, windRaw, true);
    view.setInt16(3, gradeRaw, true);
    view.setUint8(5, crrRaw);
    view.setUint8(6, windResRaw);

    await sendCommand(new Uint8Array(buffer), FTMS_OPCODES.SET_INDOOR_BIKE_SIMULATION);
  }

  async function sendInclinationFallback(gradePercent) {
    const value = Math.round(gradePercent * 10);
    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, FTMS_OPCODES.SET_TARGET_INCLINATION);
    view.setInt16(1, value, true);
    await sendCommand(new Uint8Array(buffer), FTMS_OPCODES.SET_TARGET_INCLINATION);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isInclinationUnsupported(error) {
    return String(error?.message ?? "").includes("opcode 0x3") && String(error?.message ?? "").includes("0x02");
  }

  function isInclinationTimeout(error) {
    return String(error?.message ?? "").includes("命令超时: 0x3");
  }

  function isSimulationTimeout(error) {
    return String(error?.message ?? "").includes("命令超时: 0x11");
  }

  function formatResultCode(code) {
    switch (code) {
      case FTMS_RESULT.SUCCESS:
        return "0x01(success)";
      case FTMS_RESULT.NOT_SUPPORTED:
        return "0x02(not-supported)";
      case FTMS_RESULT.INVALID_PARAMETER:
        return "0x03(invalid-parameter)";
      case FTMS_RESULT.OPERATION_FAILED:
        return "0x04(operation-failed)";
      case FTMS_RESULT.NOT_PERMITTED:
        return "0x05(not-permitted)";
      default:
        return `0x${code.toString(16)}`;
    }
  }

  return {
    toggle,
    disconnect,
    setGradePercent,
    get isConnected() {
      return Boolean(device?.gatt?.connected);
    }
  };
}
