import { formatDuration, formatNumber } from "../../shared/format.js";

export function createMainView({
    store,
    onAddSegment,
    onResetRoute,
    onToggleHeartRate,
    onTogglePowerMeter,
    onRunSimulation,
    onDownloadSession,
    onDownloadFit,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    onUpdateSettings,
    onUpdateExportMetadata,
    onUpdatePipConfig,
    pipController
}) {
    const elements = {
        routeTableBody: document.getElementById("routeTableBody"),
        addSegmentBtn: document.getElementById("addSegmentBtn"),
        resetRouteBtn: document.getElementById("resetRouteBtn"),
        routeSummary: document.getElementById("routeSummary"),
        routeDistanceChip: document.getElementById("routeDistanceChip"),
        routeElevationChip: document.getElementById("routeElevationChip"),
        savedSessionChip: document.getElementById("savedSessionChip"),
        simulationForm: document.getElementById("simulationForm"),
        fitExportForm: document.getElementById("fitExportForm"),
        connectHrBtn: document.getElementById("connectHrBtn"),
        connectPowerBtn: document.getElementById("connectPowerBtn"),
        hrDeviceStatus: document.getElementById("hrDeviceStatus"),
        hrDeviceName: document.getElementById("hrDeviceName"),
        powerDeviceStatus: document.getElementById("powerDeviceStatus"),
        powerDeviceName: document.getElementById("powerDeviceName"),
        liveHeartRateDisplay: document.getElementById("liveHeartRateDisplay"),
        livePowerDisplay: document.getElementById("livePowerDisplay"),
        liveCadenceDisplay: document.getElementById("liveCadenceDisplay"),
        liveAvgPowerDisplay: document.getElementById("liveAvgPowerDisplay"),
        runSimulationBtn: document.getElementById("runSimulationBtn"),
        downloadSessionBtn: document.getElementById("downloadSessionBtn"),
        downloadFitBtn: document.getElementById("downloadFitBtn"),
        pipBtn: document.getElementById("pipBtn"),
        statusText: document.getElementById("statusText"),
        avgSpeedDisplay: document.getElementById("avgSpeedDisplay"),
        distanceDisplay: document.getElementById("distanceDisplay"),
        heartRateDisplay: document.getElementById("heartRateDisplay"),
        elevationDisplay: document.getElementById("elevationDisplay"),
        elapsedTimeValue: document.getElementById("elapsedTimeValue"),
        routeProgressValue: document.getElementById("routeProgressValue"),
        currentGradeValue: document.getElementById("currentGradeValue"),
        recordCountValue: document.getElementById("recordCountValue"),
        distanceChart: document.getElementById("distanceChart"),
        recordsTableBody: document.getElementById("recordsTableBody"),
        checkboxInputs: [...document.querySelectorAll(".checkbox-group input")]
    };

    let lastRenderedSettingsSignature = "";
    let lastRenderedExportSignature = "";

    elements.addSegmentBtn.addEventListener("click", onAddSegment);
    elements.resetRouteBtn.addEventListener("click", onResetRoute);
    elements.connectHrBtn.addEventListener("click", onToggleHeartRate);
    elements.connectPowerBtn.addEventListener("click", onTogglePowerMeter);
    elements.runSimulationBtn.addEventListener("click", onRunSimulation);
    elements.downloadSessionBtn.addEventListener("click", onDownloadSession);
    elements.downloadFitBtn.addEventListener("click", onDownloadFit);

    elements.simulationForm.addEventListener("input", () => {
        onUpdateSettings(readSettingsFromForm(elements.simulationForm));
    });

    elements.fitExportForm.addEventListener("input", () => {
        onUpdateExportMetadata(readExportMetadataFromForm(elements.fitExportForm));
    });

    elements.checkboxInputs.forEach((input) => {
        input.addEventListener("change", (event) => {
            onUpdatePipConfig(event.target.value, event.target.checked);
        });
    });

    store.subscribe((state) => {
        renderSettings(state);
        renderExportMetadata(state);
        renderRouteTable(state);
        renderRouteSummary(state);
        renderBle(state);
        renderSession(state);
        renderPipControls(state);
    });

    function renderSettings(state) {
        const signature = JSON.stringify(state.settings);

        if (signature === lastRenderedSettingsSignature) {
            return;
        }

        Object.entries(state.settings).forEach(([key, value]) => {
            const field = elements.simulationForm.elements.namedItem(key);

            if (field && document.activeElement !== field) {
                field.value = value;
            }
        });

        lastRenderedSettingsSignature = signature;
    }

    function renderExportMetadata(state) {
        const signature = JSON.stringify(state.exportMetadata);

        if (signature === lastRenderedExportSignature) {
            return;
        }

        Object.entries(state.exportMetadata).forEach(([key, value]) => {
            const field = elements.fitExportForm.elements.namedItem(key);

            if (field && document.activeElement !== field) {
                field.value = value;
            }
        });

        lastRenderedExportSignature = signature;
    }

    function renderRouteTable(state) {
        elements.routeTableBody.innerHTML = state.routeSegments.map((segment, index) => `
            <tr data-segment-id="${segment.id}">
                <td>
                    <input data-field="name" value="${escapeHtml(segment.name)}">
                </td>
                <td>
                    <input data-field="distanceKm" type="number" min="0.1" max="200" step="0.1" value="${segment.distanceKm}">
                </td>
                <td>
                    <input data-field="gradePercent" type="number" min="-15" max="20" step="0.1" value="${segment.gradePercent}">
                </td>
                <td class="action-cell">
                    <button class="remove-segment-btn" data-remove-segment="${segment.id}" ${state.routeSegments.length === 1 ? "disabled" : ""}>×</button>
                </td>
            </tr>
        `).join("");

        [...elements.routeTableBody.querySelectorAll("input[data-field]")].forEach((input) => {
            input.addEventListener("input", (event) => {
                const row = event.target.closest("tr");
                onUpdateRouteSegment(row.dataset.segmentId, event.target.dataset.field, event.target.value);
            });
        });

        [...elements.routeTableBody.querySelectorAll("[data-remove-segment]")].forEach((button) => {
            button.addEventListener("click", () => {
                onRemoveRouteSegment(button.dataset.removeSegment);
            });
        });
    }

    function renderRouteSummary(state) {
        const route = state.route;
        elements.routeDistanceChip.textContent = `${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        elements.routeElevationChip.textContent = `${Math.round(route.totalElevationGainMeters)} m`;
        elements.savedSessionChip.textContent = state.session ? "已更新" : state.hasPersistedSession ? "已恢复" : "未保存";
        elements.routeSummary.innerHTML = `
            <strong>路线概览</strong><br>
            共 ${route.segments.length} 段，累计距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km，
            累计爬升 ${Math.round(route.totalElevationGainMeters)} m，
            累计下降 ${Math.round(route.totalDescentMeters)} m。
        `;
    }

    function renderSession(state) {
        const session = state.session;
        const summary = session?.summary;
        const records = session?.records ?? [];

        elements.avgSpeedDisplay.innerHTML = `${formatNumber(summary?.averageSpeedKph ?? 0, 1)} <span class="unit">km/h</span>`;
        elements.distanceDisplay.innerHTML = `${formatNumber(summary?.distanceKm ?? 0, 2)} <span class="unit">km</span>`;
        elements.heartRateDisplay.innerHTML = `${Math.round(summary?.averageHeartRate ?? 0)} <span class="unit">bpm</span>`;
        elements.elevationDisplay.innerHTML = `${Math.round(summary?.ascentMeters ?? 0)} <span class="unit">m</span>`;
        elements.elapsedTimeValue.textContent = formatDuration(summary?.elapsedSeconds ?? 0);
        elements.routeProgressValue.textContent = `${Math.round((summary?.routeProgress ?? 0) * 100)}%`;
        elements.currentGradeValue.textContent = `${formatNumber(summary?.currentGradePercent ?? 0, 1)}%`;
        elements.recordCountValue.textContent = String(records.length);
        elements.statusText.textContent = state.statusText;
        elements.downloadSessionBtn.disabled = !session;
        elements.downloadFitBtn.disabled = !session;

        renderRecords(records);
        renderChart(records);
    }

    function renderBle(state) {
        const heartRate = state.ble.heartRate;
        const powerMeter = state.ble.powerMeter;

        elements.connectHrBtn.disabled = !state.ble.supported || heartRate.isConnecting;
        elements.connectPowerBtn.disabled = !state.ble.supported || powerMeter.isConnecting;
        elements.connectHrBtn.textContent = heartRate.isConnected ? "断开心率带" : (heartRate.isConnecting ? "连接中心率带..." : "连接心率带");
        elements.connectPowerBtn.textContent = powerMeter.isConnected ? "断开功率计" : (powerMeter.isConnecting ? "连接中功率计..." : "连接功率计");

        elements.hrDeviceStatus.textContent = heartRate.statusLabel;
        elements.hrDeviceName.textContent = heartRate.deviceName;
        elements.powerDeviceStatus.textContent = powerMeter.statusLabel;
        elements.powerDeviceName.textContent = powerMeter.deviceName;

        elements.liveHeartRateDisplay.innerHTML = `${heartRate.value ?? "--"} <span class="unit">bpm</span>`;
        elements.livePowerDisplay.innerHTML = `${powerMeter.power ?? "--"} <span class="unit">W</span>`;
        elements.liveCadenceDisplay.innerHTML = `${powerMeter.cadence ?? "--"} <span class="unit">rpm</span>`;
        elements.liveAvgPowerDisplay.innerHTML = `${powerMeter.averagePower ?? "--"} <span class="unit">W</span>`;
    }

    function renderRecords(records) {
        if (records.length === 0) {
            elements.recordsTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">运行模拟后将在这里显示记录。</td></tr>`;
            return;
        }

        const visibleRecords = records.slice(-12).reverse();
        elements.recordsTableBody.innerHTML = visibleRecords.map((record) => `
            <tr>
                <td>${record.elapsedLabel}</td>
                <td>${record.power} W</td>
                <td>${formatNumber(record.speedKph, 1)} km/h</td>
                <td>${formatNumber(record.distanceKm, 2)} km</td>
                <td>${record.heartRate} bpm</td>
                <td>${formatNumber(record.gradePercent, 1)}%</td>
            </tr>
        `).join("");
    }

    function renderChart(records) {
        if (records.length === 0) {
            elements.distanceChart.innerHTML = `
                <rect x="0" y="0" width="640" height="280" rx="18" fill="transparent"></rect>
                <text x="320" y="140" text-anchor="middle" fill="#64748b" font-size="16">暂无模拟数据</text>
            `;
            return;
        }

        const maxDistance = Math.max(...records.map((record) => record.distanceKm), 0.1);
        const maxTime = Math.max(...records.map((record) => record.elapsedSeconds), 1);
        const points = records.map((record) => {
            const x = 40 + (record.elapsedSeconds / maxTime) * 560;
            const y = 240 - (record.distanceKm / maxDistance) * 200;
            return `${x},${y}`;
        }).join(" ");

        const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = 40 + ratio * 200;
            return `<line x1="40" y1="${y}" x2="600" y2="${y}" stroke="rgba(100, 116, 139, 0.2)" />`;
        }).join("");

        elements.distanceChart.innerHTML = `
            <rect x="0" y="0" width="640" height="280" rx="18" fill="transparent"></rect>
            ${gridLines}
            <line x1="40" y1="240" x2="600" y2="240" stroke="#94a3b8" />
            <line x1="40" y1="40" x2="40" y2="240" stroke="#94a3b8" />
            <polyline fill="none" stroke="#3742fa" stroke-width="4" points="${points}" />
            <text x="40" y="258" fill="#64748b" font-size="13">0</text>
            <text x="560" y="258" fill="#64748b" font-size="13">${formatDuration(maxTime)}</text>
            <text x="8" y="48" fill="#64748b" font-size="13">${formatNumber(maxDistance, 1)} km</text>
        `;
    }

    function renderPipControls(state) {
        const hasLiveData = state.ble.heartRate.value !== null || state.ble.powerMeter.power !== null;
        elements.pipBtn.disabled = !pipController.isSupported || (!state.session && !hasLiveData);
        elements.checkboxInputs.forEach((input) => {
            const checked = Boolean(state.pipConfig[input.value]);

            if (input.checked !== checked) {
                input.checked = checked;
            }
        });

        pipController.render();
        pipController.sync();
    }
}

function readSettingsFromForm(form) {
    const formData = new FormData(form);

    return {
        power: Number(formData.get("power")),
        durationMinutes: Number(formData.get("durationMinutes")),
        mass: Number(formData.get("mass")),
        restingHr: Number(formData.get("restingHr")),
        maxHr: Number(formData.get("maxHr")),
        cda: Number(formData.get("cda")),
        crr: Number(formData.get("crr")),
        windSpeed: Number(formData.get("windSpeed"))
    };
}

function readExportMetadataFromForm(form) {
    const formData = new FormData(form);

    return {
        activityName: String(formData.get("activityName") ?? ""),
        fitDescription: String(formData.get("fitDescription") ?? ""),
        repositoryUrl: String(formData.get("repositoryUrl") ?? "")
    };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
