import {
    buildSimulationPacket,
    formatPacket,
    resolveLongitudinalWindMps
} from "./simulation.js";

const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const REQUEST_CONTROL = 0x00;
const RESPONSE_CODE = 0x80;
const MAX_LOG_LINES = 180;

const elements = Object.fromEntries([
    "riderHeading", "windFrom", "windSpeed", "grade", "cda", "crr", "connectButton", "disconnectButton",
    "status", "longitudinalWind", "windEffect", "cw", "windRaw", "packet", "allowWrite", "sendButton", "log"
].map((id) => [id, document.getElementById(id)]));

let device = null;
let controlPoint = null;
let disconnectListener = null;
let controlPointListener = null;
let logLines = [];

document.querySelectorAll("input").forEach((input) => input.addEventListener("input", renderPreview));
document.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => applyPreset(button.dataset.preset)));
elements.connectButton.addEventListener("click", connectTrainer);
elements.disconnectButton.addEventListener("click", disconnectTrainer);
elements.sendButton.addEventListener("click", sendSimulation);
elements.allowWrite.addEventListener("change", refreshButtons);

renderPreview();

function currentInput() {
    const longitudinalWindMps = resolveLongitudinalWindMps({
        riderHeadingDegrees: elements.riderHeading.value,
        windFromDegrees: elements.windFrom.value,
        windSpeedMps: elements.windSpeed.value
    });
    return {
        gradePercent: Number(elements.grade.value),
        longitudinalWindMps,
        crr: Number(elements.crr.value),
        cda: Number(elements.cda.value)
    };
}

function renderPreview() {
    const { packet, simulation } = buildSimulationPacket(currentInput());
    elements.longitudinalWind.textContent = `${simulation.longitudinalWindMps >= 0 ? "+" : ""}${simulation.longitudinalWindMps.toFixed(2)} m/s`;
    elements.windEffect.textContent = Math.abs(simulation.longitudinalWindMps) < 0.05
        ? "侧风"
        : simulation.longitudinalWindMps > 0 ? "逆风" : "顺风";
    elements.cw.textContent = `${simulation.cw.toFixed(3)} kg/m`;
    elements.windRaw.textContent = String(Math.round(simulation.longitudinalWindMps * 1000));
    elements.packet.textContent = `0x11 packet: ${formatPacket(packet)}`;
    return { packet, simulation };
}

function applyPreset(name) {
    const heading = Number(elements.riderHeading.value) || 0;
    elements.windSpeed.value = "4";
    elements.windFrom.value = String(name === "headwind" ? heading : name === "tailwind" ? heading + 180 : heading + 90);
    renderPreview();
}

async function connectTrainer() {
    if (!navigator.bluetooth) {
        setStatus("当前浏览器不支持 Web Bluetooth；请使用 Chrome 或 Edge。", true);
        return;
    }
    try {
        elements.connectButton.disabled = true;
        setStatus("正在选择 FTMS 骑行台...", false);
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: [FTMS_SERVICE] }] });
        disconnectListener = handleDisconnect;
        device.addEventListener("gattserverdisconnected", disconnectListener);
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(FTMS_SERVICE);
        controlPoint = await service.getCharacteristic(CONTROL_POINT);
        await controlPoint.startNotifications();
        controlPointListener = handleControlPointResponse;
        controlPoint.addEventListener("characteristicvaluechanged", controlPointListener);
        setStatus(`已连接 ${device.name || "未命名骑行台"}。勾选确认后才可写入。`, false);
        appendLog("[connect] FTMS Control Point ready");
    } catch (error) {
        appendLog(`[error] connect failed: ${error.message}`);
        cleanupConnection();
        setStatus(`连接失败：${error.message}`, true);
    } finally {
        refreshButtons();
    }
}

function disconnectTrainer() {
    if (device?.gatt?.connected) {
        device.gatt.disconnect();
        return;
    }
    cleanupConnection();
    setStatus("已断开。", false);
}

function handleDisconnect() {
    cleanupConnection();
    setStatus("骑行台已断开。", true);
    appendLog("[disconnect] device disconnected");
}

function cleanupConnection() {
    if (controlPoint && controlPointListener) controlPoint.removeEventListener("characteristicvaluechanged", controlPointListener);
    if (device && disconnectListener) device.removeEventListener("gattserverdisconnected", disconnectListener);
    device = null;
    controlPoint = null;
    disconnectListener = null;
    controlPointListener = null;
    refreshButtons();
}

async function sendSimulation() {
    if (!controlPoint || !elements.allowWrite.checked) return;
    const { packet, simulation } = renderPreview();
    try {
        elements.sendButton.disabled = true;
        await writeControlPoint(new Uint8Array([REQUEST_CONTROL]));
        await writeControlPoint(packet);
        appendLog(`[write] ${formatPacket(packet)} | grade=${simulation.gradePercent.toFixed(2)}% wind=${simulation.longitudinalWindMps.toFixed(2)}m/s Crr=${simulation.crr.toFixed(4)} Cw=${simulation.cw.toFixed(3)}`);
        setStatus("模拟包已写入，等待控制点响应。", false);
    } catch (error) {
        appendLog(`[error] write failed: ${error.message}`);
        setStatus(`写入失败：${error.message}`, true);
    } finally {
        refreshButtons();
    }
}

async function writeControlPoint(value) {
    if (typeof controlPoint.writeValueWithResponse === "function") {
        await controlPoint.writeValueWithResponse(value);
        return;
    }
    await controlPoint.writeValue(value);
}

function handleControlPointResponse(event) {
    const value = event.target.value;
    if (value.getUint8(0) !== RESPONSE_CODE || value.byteLength < 3) {
        appendLog(`[notify] ${formatPacket(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}`);
        return;
    }
    const request = value.getUint8(1);
    const result = value.getUint8(2);
    appendLog(`[response] request=0x${request.toString(16).padStart(2, "0")} result=${formatResult(result)}`);
}

function formatResult(result) {
    return ({ 1: "success", 2: "not-supported", 3: "invalid-parameter", 4: "operation-failed", 5: "not-permitted" })[result] ?? `0x${result.toString(16)}`;
}

function refreshButtons() {
    const connected = Boolean(controlPoint && device?.gatt?.connected);
    elements.connectButton.disabled = connected;
    elements.disconnectButton.disabled = !connected;
    elements.sendButton.disabled = !connected || !elements.allowWrite.checked;
}

function setStatus(message, isWarning) {
    elements.status.textContent = message;
    elements.status.className = isWarning ? "status warning" : "status";
}

function appendLog(line) {
    logLines.unshift(`${new Date().toISOString()} ${line}`);
    logLines = logLines.slice(0, MAX_LOG_LINES);
    elements.log.value = logLines.join("\n");
}
