const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";
const MAX_LOG_LINES = 250;

const elements = {
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    clearBtn: document.getElementById("clearBtn"),
    statusText: document.getElementById("statusText"),
    packetCount: document.getElementById("packetCount"),
    currentIntervalMs: document.getElementById("currentIntervalMs"),
    avgIntervalMs: document.getElementById("avgIntervalMs"),
    hzValue: document.getElementById("hzValue"),
    powerValue: document.getElementById("powerValue"),
    cadenceValue: document.getElementById("cadenceValue"),
    speedValue: document.getElementById("speedValue"),
    powerPresenceRate: document.getElementById("powerPresenceRate"),
    logOutput: document.getElementById("logOutput")
};

let device = null;
let server = null;
let indoorBikeDataChar = null;
let previousTimestamp = null;
let disconnectListener = null;
let dataListener = null;
let logLines = [];
let stats = createEmptyStats();

elements.connectBtn.addEventListener("click", connectTrainer);
elements.disconnectBtn.addEventListener("click", disconnectTrainer);
elements.clearBtn.addEventListener("click", clearLogs);

renderStats();

async function connectTrainer() {
    if (!navigator.bluetooth) {
        setStatus("当前浏览器不支持 Web Bluetooth。请使用 Chromium 系浏览器。", "warn");
        return;
    }

    try {
        setBusy(true);
        setStatus("正在请求 FTMS 骑行台设备...", "");
        resetSessionState();

        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [FTMS_SERVICE] }],
            optionalServices: [FTMS_SERVICE]
        });

        disconnectListener = handleDisconnect;
        device.addEventListener("gattserverdisconnected", disconnectListener);

        server = await device.gatt.connect();
        const service = await server.getPrimaryService(FTMS_SERVICE);
        indoorBikeDataChar = await service.getCharacteristic(INDOOR_BIKE_DATA);
        await indoorBikeDataChar.startNotifications();

        dataListener = handleIndoorBikeData;
        indoorBikeDataChar.addEventListener("characteristicvaluechanged", dataListener);

        setStatus(`已连接 ${device.name || "未命名骑行台"}，正在接收 Indoor Bike Data 通知。`, "good");
        elements.disconnectBtn.disabled = false;
    } catch (error) {
        cleanupConnection();
        setStatus(`连接失败: ${error.message}`, "warn");
        appendLog(`[error] connect failed: ${error.message}`);
    } finally {
        elements.connectBtn.disabled = false;
    }
}

function disconnectTrainer() {
    if (device?.gatt?.connected) {
        device.gatt.disconnect();
    } else {
        cleanupConnection();
        setStatus("已断开连接。", "");
    }
}

function handleDisconnect() {
    cleanupConnection();
    setStatus("设备已断开连接。", "warn");
}

function cleanupConnection() {
    if (indoorBikeDataChar && dataListener) {
        indoorBikeDataChar.removeEventListener("characteristicvaluechanged", dataListener);
    }
    if (device && disconnectListener) {
        device.removeEventListener("gattserverdisconnected", disconnectListener);
    }

    indoorBikeDataChar = null;
    server = null;
    device = null;
    dataListener = null;
    disconnectListener = null;
    elements.disconnectBtn.disabled = true;
}

function handleIndoorBikeData(event) {
    const parsed = parseIndoorBikeData(event.target.value);
    const now = performance.now();
    const deltaMs = previousTimestamp == null ? null : now - previousTimestamp;
    previousTimestamp = now;

    stats.packetCount += 1;

    if (deltaMs != null) {
        stats.currentIntervalMs = deltaMs;
        stats.intervalSumMs += deltaMs;
        stats.intervalCount += 1;
        stats.minIntervalMs = stats.minIntervalMs == null ? deltaMs : Math.min(stats.minIntervalMs, deltaMs);
        stats.maxIntervalMs = stats.maxIntervalMs == null ? deltaMs : Math.max(stats.maxIntervalMs, deltaMs);
    }

    if (parsed.power != null) {
        stats.powerSamples += 1;
        stats.lastPower = parsed.power;
    }
    if (parsed.cadence != null) {
        stats.cadenceSamples += 1;
        stats.lastCadence = parsed.cadence;
    }
    if (parsed.speedKph != null) {
        stats.speedSamples += 1;
        stats.lastSpeedKph = parsed.speedKph;
    }

    renderStats();
    appendLog(formatLogLine(parsed, deltaMs));
}

function parseIndoorBikeData(value) {
    const flags = value.getUint16(0, true);
    let offset = 2;
    let speedKph = value.getUint16(offset, true) / 100;
    let cadence = null;
    let power = null;

    offset += 2;

    if (flags & 0x0002) {
        offset += 2;
    }

    if (flags & 0x0004) {
        cadence = Math.round(value.getUint16(offset, true) / 2);
        offset += 2;
    }

    if (flags & 0x0008) {
        offset += 2;
    }
    if (flags & 0x0010) {
        offset += 3;
    }
    if (flags & 0x0020) {
        offset += 2;
    }
    if (flags & 0x0040) {
        power = value.getInt16(offset, true);
    }

    return {
        flags,
        speedKph,
        cadence,
        power,
        timestampIso: new Date().toISOString()
    };
}

function createEmptyStats() {
    return {
        packetCount: 0,
        currentIntervalMs: null,
        intervalSumMs: 0,
        intervalCount: 0,
        minIntervalMs: null,
        maxIntervalMs: null,
        powerSamples: 0,
        cadenceSamples: 0,
        speedSamples: 0,
        lastPower: null,
        lastCadence: null,
        lastSpeedKph: null
    };
}

function resetSessionState() {
    previousTimestamp = null;
    stats = createEmptyStats();
    clearLogs();
    renderStats();
}

function renderStats() {
    const avgIntervalMs = stats.intervalCount > 0 ? stats.intervalSumMs / stats.intervalCount : null;
    const hz = avgIntervalMs && avgIntervalMs > 0 ? 1000 / avgIntervalMs : null;
    const powerPresenceRate = stats.packetCount > 0 ? (stats.powerSamples / stats.packetCount) * 100 : 0;

    elements.packetCount.textContent = String(stats.packetCount);
    elements.currentIntervalMs.textContent = formatMs(stats.currentIntervalMs);
    elements.avgIntervalMs.textContent = formatMs(avgIntervalMs);
    elements.hzValue.textContent = hz == null ? "--" : `${hz.toFixed(2)} Hz`;
    elements.powerValue.textContent = stats.lastPower == null ? "--" : `${stats.lastPower} W`;
    elements.cadenceValue.textContent = stats.lastCadence == null ? "--" : `${stats.lastCadence} rpm`;
    elements.speedValue.textContent = stats.lastSpeedKph == null ? "--" : `${stats.lastSpeedKph.toFixed(1)} km/h`;
    elements.powerPresenceRate.textContent = `${powerPresenceRate.toFixed(0)}%`;
}

function appendLog(line) {
    logLines.unshift(line);
    if (logLines.length > MAX_LOG_LINES) {
        logLines = logLines.slice(0, MAX_LOG_LINES);
    }
    elements.logOutput.value = logLines.join("\n");
}

function clearLogs() {
    logLines = [];
    elements.logOutput.value = "";
}

function formatLogLine(parsed, deltaMs) {
    const parts = [
        parsed.timestampIso,
        `flags=0x${parsed.flags.toString(16).padStart(4, "0")}`,
        `delta=${formatMs(deltaMs)}`,
        `speed=${parsed.speedKph?.toFixed(1) ?? "--"}km/h`,
        `cadence=${parsed.cadence ?? "--"}rpm`,
        `power=${parsed.power ?? "--"}W`
    ];
    return parts.join(" | ");
}

function formatMs(value) {
    if (value == null) {
        return "--";
    }
    return `${value.toFixed(1)} ms`;
}

function setBusy(isBusy) {
    elements.connectBtn.disabled = isBusy;
    if (isBusy) {
        elements.disconnectBtn.disabled = true;
    }
}

function setStatus(message, variant) {
    elements.statusText.textContent = message;
    elements.statusText.className = variant ? `status ${variant}` : "status";
}
