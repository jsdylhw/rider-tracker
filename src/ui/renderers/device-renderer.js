import { formatNumber } from "../../shared/format.js";

export function createDeviceRenderer({
    elements,
    onToggleHeartRate,
    onTogglePowerMeter,
    onOpenRideDashboard,
    onStartRide,
    onStopRide
}) {
    function bindEvents() {
        if (elements.connectHrBtn) elements.connectHrBtn.addEventListener("click", onToggleHeartRate);
        if (elements.connectPowerBtn) elements.connectPowerBtn.addEventListener("click", onTogglePowerMeter);
        if (elements.openRideDashboardBtn) elements.openRideDashboardBtn.addEventListener("click", onOpenRideDashboard);
        if (elements.startRideBtn) elements.startRideBtn.addEventListener("click", onStartRide);
        if (elements.stopRideBtn) elements.stopRideBtn.addEventListener("click", onStopRide);
    }

    function render(state) {
        const heartRate = state.ble.heartRate;
        const powerMeter = state.ble.powerMeter;
        const liveRide = state.liveRide;
        const liveSession = liveRide.session;
        const currentRecord = liveSession?.records?.at(-1) ?? null;

        if (elements.connectHrBtn) {
            elements.connectHrBtn.disabled = !state.ble.supported || heartRate.isConnecting;
            elements.connectHrBtn.textContent = heartRate.isConnected ? "断开心率带" : (heartRate.isConnecting ? "连接中心率带..." : "连接心率带");
        }
        if (elements.connectPowerBtn) {
            elements.connectPowerBtn.disabled = !state.ble.supported || powerMeter.isConnecting;
            elements.connectPowerBtn.textContent = powerMeter.isConnected ? "断开功率计" : (powerMeter.isConnecting ? "连接中功率计..." : "连接功率计");
        }
        if (elements.startRideBtn) elements.startRideBtn.disabled = !liveRide.canStart || liveRide.isActive;
        if (elements.stopRideBtn) elements.stopRideBtn.disabled = !liveRide.isActive;
        if (elements.openRideDashboardBtn) elements.openRideDashboardBtn.disabled = false;

        if (elements.hrDeviceStatus) elements.hrDeviceStatus.textContent = heartRate.statusLabel;
        if (elements.hrDeviceName) elements.hrDeviceName.textContent = heartRate.deviceName;
        if (elements.powerDeviceStatus) elements.powerDeviceStatus.textContent = powerMeter.statusLabel;
        if (elements.powerDeviceName) elements.powerDeviceName.textContent = powerMeter.deviceName;
        if (elements.rideStatusLabel) elements.rideStatusLabel.textContent = liveRide.isActive ? "骑行中" : (liveRide.lastCompletedAt ? "已结束" : "未开始");
        if (elements.rideStatusMeta) elements.rideStatusMeta.textContent = liveRide.statusMeta;
        if (elements.rideSegmentLabel) elements.rideSegmentLabel.textContent = currentRecord?.segmentName ?? "等待开始";
        if (elements.rideSegmentMeta) {
            elements.rideSegmentMeta.textContent = currentRecord
                ? `当前坡度 ${formatNumber(currentRecord.gradePercent, 1)}%，路线进度 ${Math.round(currentRecord.routeProgress * 100)}%`
                : "速度将按当前路线坡度和实时功率计算。";
        }

        if (elements.liveHeartRateDisplay) elements.liveHeartRateDisplay.innerHTML = `${heartRate.value ?? "--"} <span class="unit">bpm</span>`;
        if (elements.livePowerDisplay) elements.livePowerDisplay.innerHTML = `${powerMeter.power ?? "--"} <span class="unit">W</span>`;
        if (elements.liveCadenceDisplay) elements.liveCadenceDisplay.innerHTML = `${powerMeter.cadence ?? "--"} <span class="unit">rpm</span>`;
        if (elements.liveAvgPowerDisplay) elements.liveAvgPowerDisplay.innerHTML = `${powerMeter.averagePower ?? "--"} <span class="unit">W</span>`;
        if (elements.liveSpeedDisplay) elements.liveSpeedDisplay.innerHTML = `${currentRecord ? formatNumber(currentRecord.speedKph, 1) : "--"} <span class="unit">km/h</span>`;
        if (elements.liveDistanceDisplay) elements.liveDistanceDisplay.innerHTML = `${currentRecord ? formatNumber(currentRecord.distanceKm, 2) : "--"} <span class="unit">km</span>`;
    }

    bindEvents();

    return {
        render
    };
}
