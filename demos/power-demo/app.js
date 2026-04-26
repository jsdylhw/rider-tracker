import { createPowerMeterProbe } from "./ble-power-meter.js";
import { createTrainerSimController } from "./ble-trainer-ftms.js";
import { resolveSpeedTarget } from "../../src/domain/physics/cycling-model.js";

const el = {
  connectPowerMeterBtn: document.getElementById("connectPowerMeterBtn"),
  connectTrainerBtn: document.getElementById("connectTrainerBtn"),
  powerMeterStatus: document.getElementById("powerMeterStatus"),
  trainerStatus: document.getElementById("trainerStatus"),
  powerValue: document.getElementById("powerValue"),
  cadenceValue: document.getElementById("cadenceValue"),
  deviceSpeedValue: document.getElementById("deviceSpeedValue"),
  modelSpeedValue: document.getElementById("modelSpeedValue"),
  sampleTime: document.getElementById("sampleTime"),
  gradeSlider: document.getElementById("gradeSlider"),
  gradeInput: document.getElementById("gradeInput"),
  sendGradeBtn: document.getElementById("sendGradeBtn"),
  gradeSendStatus: document.getElementById("gradeSendStatus"),
  ergPowerSlider: document.getElementById("ergPowerSlider"),
  ergPowerInput: document.getElementById("ergPowerInput"),
  sendErgBtn: document.getElementById("sendErgBtn"),
  ergSendStatus: document.getElementById("ergSendStatus"),
  resistanceSlider: document.getElementById("resistanceSlider"),
  resistanceInput: document.getElementById("resistanceInput"),
  sendResistanceBtn: document.getElementById("sendResistanceBtn"),
  resistanceSendStatus: document.getElementById("resistanceSendStatus"),
  logPanel: document.getElementById("logPanel")
};

const state = {
  currentGrade: 0,
  currentErgPower: 150,
  currentResistance: 20,
  powerMeterConnected: false,
  trainerConnected: false,
  latestPower: null
};

const physicsSettings = {
  mass: 78,
  crr: 0.004,
  cda: 0.32,
  windSpeed: 0
};

const powerMeter = createPowerMeterProbe({
  onStatus(status) {
    state.powerMeterConnected = status.type === "connected";
    el.powerMeterStatus.textContent = status.deviceName
      ? `${status.message} (${status.deviceName})`
      : status.message;
    el.connectPowerMeterBtn.textContent = state.powerMeterConnected ? "断开功率计" : "连接功率计";
    log(`功率计状态: ${status.message}`);
  },
  onData(data) {
    state.latestPower = data.power;
    el.powerValue.textContent = data.power ?? "--";
    el.cadenceValue.textContent = data.cadence ?? "--";
    el.deviceSpeedValue.textContent = data.speedKph != null ? data.speedKph.toFixed(1) : "--";
    el.modelSpeedValue.textContent = computeModelSpeedText(data.power, state.currentGrade);
    el.sampleTime.textContent = new Date(data.timestamp).toLocaleTimeString();
  }
});

const trainer = createTrainerSimController({
  onStatus(status) {
    state.trainerConnected = status.type === "connected";
    el.trainerStatus.textContent = status.deviceName
      ? `${status.message} (${status.deviceName})`
      : status.message;
    el.connectTrainerBtn.textContent = state.trainerConnected ? "断开骑行台" : "连接骑行台 (FTMS)";
    el.sendGradeBtn.disabled = !state.trainerConnected;
    el.sendErgBtn.disabled = !state.trainerConnected;
    el.sendResistanceBtn.disabled = !state.trainerConnected;
    el.gradeSendStatus.textContent = state.trainerConnected ? "可发送坡度命令" : "等待连接骑行台";
    el.ergSendStatus.textContent = state.trainerConnected ? "可发送 ERG 命令" : "等待连接骑行台";
    el.resistanceSendStatus.textContent = state.trainerConnected ? "可发送阻力命令" : "等待连接骑行台";
    log(`骑行台状态: ${status.message}`);
  }
});

el.connectPowerMeterBtn.addEventListener("click", async () => {
  try {
    await powerMeter.toggle();
  } catch (error) {
    log(`功率计连接异常: ${error.message}`);
    el.powerMeterStatus.textContent = `异常: ${error.message}`;
  }
});

el.connectTrainerBtn.addEventListener("click", async () => {
  try {
    await trainer.toggle();
  } catch (error) {
    log(`骑行台连接异常: ${error.message}`);
    el.trainerStatus.textContent = `异常: ${error.message}`;
  }
});

el.gradeSlider.addEventListener("input", () => {
  const value = Number(el.gradeSlider.value);
  setGradeValue(value);
});

el.gradeInput.addEventListener("input", () => {
  const value = Number(el.gradeInput.value);
  setGradeValue(value);
});

el.sendGradeBtn.addEventListener("click", async () => {
  await sendGradeNow();
});

el.ergPowerSlider.addEventListener("input", () => {
  const value = Number(el.ergPowerSlider.value);
  setErgPowerValue(value);
});

el.ergPowerInput.addEventListener("input", () => {
  const value = Number(el.ergPowerInput.value);
  setErgPowerValue(value);
});

el.sendErgBtn.addEventListener("click", async () => {
  await sendErgNow();
});

el.resistanceSlider.addEventListener("input", () => {
  const value = Number(el.resistanceSlider.value);
  setResistanceValue(value);
});

el.resistanceInput.addEventListener("input", () => {
  const value = Number(el.resistanceInput.value);
  setResistanceValue(value);
});

el.sendResistanceBtn.addEventListener("click", async () => {
  await sendResistanceNow();
});

document.addEventListener("keydown", async (event) => {
  if (!state.trainerConnected) return;
  if (event.key === "ArrowUp") {
    setGradeValue(state.currentGrade + 0.5);
    await sendGradeNow();
  } else if (event.key === "ArrowDown") {
    setGradeValue(state.currentGrade - 0.5);
    await sendGradeNow();
  } else if (event.key === "PageUp") {
    setErgPowerValue(state.currentErgPower + 5);
    await sendErgNow();
  } else if (event.key === "PageDown") {
    setErgPowerValue(state.currentErgPower - 5);
    await sendErgNow();
  } else if (event.key === "Home") {
    setResistanceValue(state.currentResistance + 1);
    await sendResistanceNow();
  } else if (event.key === "End") {
    setResistanceValue(state.currentResistance - 1);
    await sendResistanceNow();
  }
});

function setGradeValue(next) {
  if (!Number.isFinite(next)) return;
  const value = clamp(round1(next), -10, 10);
  state.currentGrade = value;
  el.gradeSlider.value = String(value);
  el.gradeInput.value = String(value);
  el.modelSpeedValue.textContent = computeModelSpeedText(state.latestPower, state.currentGrade);
}

function setErgPowerValue(next) {
  if (!Number.isFinite(next)) return;
  const value = clamp(Math.round(next / 5) * 5, 0, 2000);
  state.currentErgPower = value;
  el.ergPowerSlider.value = String(clamp(value, 0, 800));
  el.ergPowerInput.value = String(value);
}

function setResistanceValue(next) {
  if (!Number.isFinite(next)) return;
  const value = clamp(Math.round(next), 0, 100);
  state.currentResistance = value;
  el.resistanceSlider.value = String(value);
  el.resistanceInput.value = String(value);
}

async function sendGradeNow() {
  if (!state.trainerConnected) return;
  el.sendGradeBtn.disabled = true;
  const grade = state.currentGrade;
  el.gradeSendStatus.textContent = `发送中: ${grade.toFixed(1)}%`;
  try {
    const result = await trainer.setGradePercent(grade);
    if (result?.status === "unconfirmed") {
      el.gradeSendStatus.textContent = `未确认(可能已生效): ${grade.toFixed(1)}%`;
      log(`坡度命令未收到确认但可能已生效: ${grade.toFixed(1)}% (${result.path}, ${result.reason})`);
    } else {
      el.gradeSendStatus.textContent = `已发送: ${grade.toFixed(1)}%`;
      log(`坡度命令下发成功: ${grade.toFixed(1)}% (${result?.path ?? "unknown"})`);
    }
  } catch (error) {
    el.gradeSendStatus.textContent = `失败: ${error.message}`;
    log(`坡度命令下发失败: ${error.message}`);
  } finally {
    el.sendGradeBtn.disabled = !state.trainerConnected;
  }
}

async function sendErgNow() {
  if (!state.trainerConnected) return;
  el.sendErgBtn.disabled = true;
  const power = state.currentErgPower;
  el.ergSendStatus.textContent = `发送中: ${power} W`;
  try {
    const result = await trainer.setTargetPower(power);
    if (result?.status === "written-unconfirmed") {
      el.ergSendStatus.textContent = `已写入但未确认: ${power} W`;
      log(`ERG 命令已写入但重发后仍未收到确认，后续将使用快速下发: ${power} W (${result.path}, retry ${result.retryCount ?? 0}, ${result.reason})`);
    } else if (result?.status === "written") {
      el.ergSendStatus.textContent = `已写入: ${power} W`;
      log(`ERG 命令已快速写入: ${power} W (${result.path}, 未等待 FTMS 确认)`);
    } else {
      const retryText = result?.retryCount ? `，重发 ${result.retryCount} 次后确认` : "";
      el.ergSendStatus.textContent = `已发送: ${power} W${retryText}`;
      log(`ERG 命令下发成功: ${power} W (${result?.path ?? "unknown"}${retryText})`);
    }
  } catch (error) {
    el.ergSendStatus.textContent = `失败: ${error.message}`;
    log(`ERG 命令下发失败: ${error.message}`);
  } finally {
    el.sendErgBtn.disabled = !state.trainerConnected;
  }
}

async function sendResistanceNow() {
  if (!state.trainerConnected) return;
  el.sendResistanceBtn.disabled = true;
  const resistance = state.currentResistance;
  el.resistanceSendStatus.textContent = `发送中: ${resistance}%`;
  try {
    const result = await trainer.setTargetResistance(resistance);
    el.resistanceSendStatus.textContent = `已写入: ${resistance}%`;
    log(`固定阻力命令已写入: ${resistance}% (${result?.path ?? "unknown"}，未等待 FTMS 确认)`);
  } catch (error) {
    el.resistanceSendStatus.textContent = `失败: ${error.message}`;
    log(`固定阻力命令下发失败: ${error.message}`);
  } finally {
    el.sendResistanceBtn.disabled = !state.trainerConnected;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function computeModelSpeedText(power, gradePercent) {
  if (power == null || Number.isNaN(Number(power))) {
    return "--";
  }

  const speedMps = resolveSpeedTarget({
    power: Number(power),
    gradePercent,
    ...physicsSettings
  });
  const speedKph = speedMps * 3.6;
  return speedKph.toFixed(1);
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  el.logPanel.textContent = `[${timestamp}] ${message}\n${el.logPanel.textContent}`.slice(0, 12000);
}

setGradeValue(0);
setErgPowerValue(150);
setResistanceValue(20);
log("Demo 已就绪。请先连接功率计和骑行台。");
