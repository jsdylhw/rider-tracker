const CYCLING_POWER_SERVICE = "00001818-0000-1000-8000-00805f9b34fb";
const CYCLING_POWER_MEASUREMENT = "00002a63-0000-1000-8000-00805f9b34fb";
const CSC_SERVICE = "00001816-0000-1000-8000-00805f9b34fb";
const CSC_MEASUREMENT = "00002a5b-0000-1000-8000-00805f9b34fb";
const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";

export function createPowerMeterProbe({ onStatus, onData }) {
  let device = null;
  let power = null;
  let cadence = null;
  let speedKph = null;
  let cadenceTimeout = null;
  const previousCrank = { cp: null, csc: null };

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

    onStatus({ type: "connecting", message: "正在搜索功率计..." });

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

    const found = [];
    try {
      const ftms = await server.getPrimaryService(FTMS_SERVICE);
      const indoor = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      await indoor.startNotifications();
      indoor.addEventListener("characteristicvaluechanged", onIndoorBikeData);
      found.push("FTMS");
    } catch {}

    try {
      const cps = await server.getPrimaryService(CYCLING_POWER_SERVICE);
      const cpm = await cps.getCharacteristic(CYCLING_POWER_MEASUREMENT);
      await cpm.startNotifications();
      cpm.addEventListener("characteristicvaluechanged", onPowerMeasurement);
      found.push("CPS");
    } catch {}

    try {
      const cscs = await server.getPrimaryService(CSC_SERVICE);
      const cscm = await cscs.getCharacteristic(CSC_MEASUREMENT);
      await cscm.startNotifications();
      cscm.addEventListener("characteristicvaluechanged", onCscMeasurement);
      found.push("CSC");
    } catch {}

    if (found.length === 0) {
      throw new Error("设备不支持 FTMS/CPS/CSC 数据特征");
    }

    onStatus({
      type: "connected",
      message: `功率设备已连接 (${found.join(", ")})`,
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
    clearTimeout(cadenceTimeout);
    cadenceTimeout = null;
    power = null;
    cadence = null;
    speedKph = null;
    previousCrank.cp = null;
    previousCrank.csc = null;
    device = null;
    onStatus({ type: "disconnected", message: "功率设备已断开" });
  }

  function emitData() {
    clearTimeout(cadenceTimeout);
    cadenceTimeout = setTimeout(() => {
      cadence = 0;
      onData({ power, cadence, speedKph, timestamp: Date.now() });
    }, 2500);

    onData({ power, cadence, speedKph, timestamp: Date.now() });
  }

  function onPowerMeasurement(event) {
    const value = event.target.value;
    const flags = value.getUint16(0, true);
    power = value.getInt16(2, true);
    const parsedCadence = parseCrankCadence(value, flags, "cp");
    if (parsedCadence !== null) cadence = parsedCadence;
    emitData();
  }

  function onCscMeasurement(event) {
    const value = event.target.value;
    const flags = value.getUint8(0);
    const parsedCadence = parseCrankCadence(value, flags, "csc");
    if (parsedCadence !== null) cadence = parsedCadence;
    emitData();
  }

  function onIndoorBikeData(event) {
    const value = event.target.value;
    const flags = value.getUint16(0, true);
    let offset = 2;

    // FTMS Instantaneous Speed (unit: 0.01 km/h)
    const speedRaw = value.getUint16(offset, true);
    speedKph = speedRaw / 100;
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
    emitData();
  }

  function parseCrankCadence(value, flags, source) {
    let offset = 0;
    let hasCrank = false;
    if (source === "cp") {
      offset = 4;
      if (flags & 0x0001) offset += 1;
      if (flags & 0x0004) offset += 2;
      if (flags & 0x0010) offset += 6;
      hasCrank = Boolean(flags & 0x0020);
    } else {
      offset = 1;
      if (flags & 0x01) offset += 6;
      hasCrank = Boolean(flags & 0x02);
    }

    if (!hasCrank || value.byteLength < offset + 4) return null;

    const cumulativeCrankRevolutions = value.getUint16(offset, true);
    const lastCrankEventTime = value.getUint16(offset + 2, true);
    const current = { cumulativeCrankRevolutions, lastCrankEventTime };
    const prev = previousCrank[source];
    previousCrank[source] = current;
    if (!prev) return null;

    let revDelta = cumulativeCrankRevolutions - prev.cumulativeCrankRevolutions;
    let timeDelta = lastCrankEventTime - prev.lastCrankEventTime;
    if (revDelta < 0) revDelta += 65536;
    if (timeDelta < 0) timeDelta += 65536;
    if (revDelta === 0 && timeDelta > 0) return 0;
    if (revDelta > 0 && timeDelta > 0) {
      return Math.round((revDelta / (timeDelta / 1024)) * 60);
    }
    return null;
  }

  return {
    toggle,
    disconnect,
    get isConnected() {
      return Boolean(device?.gatt?.connected);
    }
  };
}
