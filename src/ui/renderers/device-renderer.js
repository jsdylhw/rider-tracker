import { formatNumber } from "../../shared/format.js";
import { isStreetViewDebugEnabled } from "../../shared/debug-flags.js";
import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";
import { deriveRideReadiness, formatReadinessMessages } from "../../domain/ride/ride-readiness.js";

export function createDeviceRenderer({
    elements,
    onToggleHeartRate,
    onTogglePowerMeter,
    onToggleTrainer,
    onOpenRideDashboard,
    onStopRide
}) {
    function bindEvents() {
        if (elements.connectHrBtn) elements.connectHrBtn.addEventListener("click", onToggleHeartRate);
        if (elements.connectPowerBtn) elements.connectPowerBtn.addEventListener("click", onTogglePowerMeter);
        if (elements.connectTrainerBtn) elements.connectTrainerBtn.addEventListener("click", onToggleTrainer);
        if (elements.openRideDashboardBtn) elements.openRideDashboardBtn.addEventListener("click", onOpenRideDashboard);
        if (elements.stopRideBtn) elements.stopRideBtn.addEventListener("click", onStopRide);
    }

    function render(state) {
        const heartRate = state.ble.heartRate;
        const powerMeter = state.ble.powerMeter;
        const trainer = state.ble.trainer;
        const liveRide = state.liveRide;
        const liveSession = liveRide.session;
        const liveRecords = liveRide.records ?? liveSession?.records ?? [];
        const currentRecord = liveSession?.currentRecord ?? liveRecords.at(-1) ?? null;
        const workoutRuntime = liveSession?.workoutRuntime ?? state.workout.runtime;
        const sessionMetrics = resolveRideMetrics({
            summary: liveRide.summary ?? liveSession?.summary ?? null,
            records: liveRecords,
            ftp: state.settings?.ftp ?? null
        });

        if (elements.connectHrBtn) {
            elements.connectHrBtn.disabled = !state.ble.supported || heartRate.isConnecting;
            elements.connectHrBtn.textContent = resolveDeviceButtonLabel({
                label: "心率带",
                isConnected: heartRate.isConnected,
                isConnecting: heartRate.isConnecting,
                deviceName: heartRate.deviceName
            });
            elements.connectHrBtn.title = heartRate.isConnected ? "点击断开心率带" : "";
        }
        if (elements.connectPowerBtn) {
            elements.connectPowerBtn.disabled = !state.ble.supported || powerMeter.externalConnecting;
            elements.connectPowerBtn.textContent = resolveDeviceButtonLabel({
                label: "功率计",
                isConnected: powerMeter.externalConnected,
                isConnecting: powerMeter.externalConnecting,
                deviceName: powerMeter.externalDeviceName
            });
            elements.connectPowerBtn.title = powerMeter.externalConnected ? "点击断开功率计" : "";
        }
        if (elements.connectTrainerBtn) {
            elements.connectTrainerBtn.disabled = !state.ble.supported || trainer.isConnecting;
            elements.connectTrainerBtn.textContent = resolveDeviceButtonLabel({
                label: "骑行台",
                isConnected: trainer.isConnected,
                isConnecting: trainer.isConnecting,
                deviceName: trainer.deviceName
            });
            elements.connectTrainerBtn.title = trainer.isConnected ? "点击断开骑行台" : "";
        }
        const streetViewDebugEnabled = isStreetViewDebugEnabled();
        const isVirtualPower = streetViewDebugEnabled && state.rideInput?.powerSource === "virtual";
        const readiness = deriveRideReadiness({
            route: state.route, workout: state.workout, rideInput: state.rideInput,
            ble: state.ble, debugEnabled: streetViewDebugEnabled
        });
        if (elements.rideInputCard) {
            elements.rideInputCard.hidden = !streetViewDebugEnabled;
        }
        if (streetViewDebugEnabled) {
            if (elements.ridePowerSourceSelect) elements.ridePowerSourceSelect.value = state.rideInput?.powerSource ?? "device";
            if (elements.virtualPowerInput) elements.virtualPowerInput.value = state.rideInput?.virtualPowerWatts ?? 220;
            if (elements.virtualCadenceInput) elements.virtualCadenceInput.value = state.rideInput?.virtualCadenceRpm ?? 85;
        }
        if (elements.stopRideBtn) elements.stopRideBtn.disabled = !liveRide.isActive;
        if (elements.openRideDashboardBtn) elements.openRideDashboardBtn.disabled = false;

        if (elements.hrDeviceStatus) elements.hrDeviceStatus.textContent = heartRate.statusLabel;
        if (elements.hrDeviceName) elements.hrDeviceName.textContent = heartRate.lastError?.message || heartRate.deviceName;
        if (elements.powerDeviceStatus) elements.powerDeviceStatus.textContent = powerMeter.statusLabel;
        if (elements.powerDeviceName) elements.powerDeviceName.textContent = powerMeter.lastError?.message || powerMeter.deviceName;
        if (elements.trainerDeviceStatus) elements.trainerDeviceStatus.textContent = trainer.statusLabel;
        if (elements.trainerDeviceName) elements.trainerDeviceName.textContent = trainer.lastError?.message
            || `${trainer.deviceName}${trainer.capabilitiesState && trainer.capabilitiesState !== "unknown"
                ? ` · 能力 ${trainer.capabilitiesState}` : ""}`;
        if (elements.rideStatusLabel) elements.rideStatusLabel.textContent = liveRide.isActive ? "骑行中" : (liveRide.lastCompletedAt ? "已结束" : "未开始");
        if (elements.rideStatusMeta) elements.rideStatusMeta.textContent = liveRide.isActive
            ? liveRide.statusMeta
            : readiness.canStart
                ? formatReadinessMessages(readiness.warnings) || "设备和路线已就绪。"
                : formatReadinessMessages(readiness.blockers);
        if (elements.trainerPushGradeValue) {
            elements.trainerPushGradeValue.textContent = `${formatNumber(workoutRuntime.targetTrainerGradePercent ?? 0, 1)}%`;
        }
        if (elements.trainerPushGradeMeta) {
            elements.trainerPushGradeMeta.textContent = liveRide.isActive
                ? `序列 #${liveSession?.commandSequence ?? 0} · ${workoutRuntime.controlStatus ?? "等待控制状态"}`
                : "等待骑行开始后推送";
        }
        if (elements.rideSegmentLabel) elements.rideSegmentLabel.textContent = currentRecord?.segmentName ?? "等待开始";
        if (elements.rideSegmentMeta) {
            elements.rideSegmentMeta.textContent = currentRecord
                ? `当前坡度 ${formatNumber(currentRecord.gradePercent, 1)}%，路线进度 ${Math.round(currentRecord.routeProgress * 100)}%`
                : "速度将按当前路线坡度和实时功率计算。";
        }

        if (elements.liveHeartRateDisplay) elements.liveHeartRateDisplay.innerHTML = `${heartRate.value ?? "--"} <span class="unit">bpm</span>`;
        const displayedPower = isVirtualPower ? state.rideInput.virtualPowerWatts : powerMeter.power;
        const displayedCadence = isVirtualPower ? state.rideInput.virtualCadenceRpm : powerMeter.cadence;
        if (elements.livePowerDisplay) elements.livePowerDisplay.innerHTML = `${displayedPower ?? "--"} <span class="unit">W</span>`;
        if (elements.liveCadenceDisplay) elements.liveCadenceDisplay.innerHTML = `${displayedCadence ?? "--"} <span class="unit">rpm</span>`;
        if (elements.liveAvgPowerDisplay) {
            elements.liveAvgPowerDisplay.innerHTML = liveSession
                ? `${Math.round(sessionMetrics.power.averageWatts ?? 0)} <span class="unit">W</span>`
                : `-- <span class="unit">W</span>`;
        }
        if (elements.liveSpeedDisplay) elements.liveSpeedDisplay.innerHTML = `${currentRecord ? formatNumber(currentRecord.speedKph, 1) : "--"} <span class="unit">km/h</span>`;
        if (elements.liveDistanceDisplay) elements.liveDistanceDisplay.innerHTML = `${currentRecord ? formatNumber(currentRecord.distanceKm, 2) : "--"} <span class="unit">km</span>`;
    }

    bindEvents();

    return {
        render
    };
}

function resolveDeviceButtonLabel({ label, isConnected, isConnecting, deviceName }) {
    if (isConnected) {
        return `已连接：${resolveConnectedDeviceName(deviceName, label)}`;
    }
    if (isConnecting) {
        return `连接中${label}...`;
    }
    return `连接${label}`;
}

function resolveConnectedDeviceName(deviceName, fallbackLabel) {
    if (!deviceName || deviceName === "等待连接") return fallbackLabel;
    return deviceName;
}
