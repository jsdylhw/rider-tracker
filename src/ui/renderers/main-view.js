import { formatDuration, formatNumber } from "../../shared/format.js";
import { createMapController } from "../map/map-controller.js";

export function createMainView({
    store,
    onSetUiMode,
    onAddSegment,
    onResetRoute,
    onToggleHeartRate,
    onTogglePowerMeter,
    onOpenRideDashboard,
    onCloseRideDashboard,
    onStartRide,
    onStopRide,
    onRunSimulation,
    onDownloadSession,
    onDownloadFit,
    onImportGpx,
    onUpdateRouteSegment,
    onRemoveRouteSegment,
    onUpdateSettings,
    onUpdateExportMetadata,
    onUpdatePipConfig,
    pipController
}) {
    const elements = {
        viewHome: document.getElementById("view-home"),
        viewSimulation: document.getElementById("view-simulation"),
        viewLive: document.getElementById("view-live"),
        goToSimBtn: document.getElementById("goToSimBtn"),
        goToLiveBtn: document.getElementById("goToLiveBtn"),
        goHomeBtns: [...document.querySelectorAll(".go-home-btn")],
        simCol1: document.getElementById("sim-col-1"),
        liveCol1: document.getElementById("live-col-1"),
        routeCardContainer: document.getElementById("routeCardContainer"),
        routeCard: document.getElementById("routeCard"),
        historyContainer: document.getElementById("historyContainer"),
        personalSettingsForm: document.getElementById("personalSettingsForm"),
        simPowerForm: document.getElementById("simPowerForm"),
        routeTableBody: document.getElementById("routeTableBody"),
        routeTableShell: document.getElementById("routeTableShell"),
        addSegmentBtn: document.getElementById("addSegmentBtn"),
        resetRouteBtn: document.getElementById("resetRouteBtn"),
        gpxFileInput: document.getElementById("gpxFileInput"),
        routeSourceLabel: document.getElementById("routeSourceLabel"),
        routeMapPreview: document.getElementById("routeMapPreview"),
        routeSummary: document.getElementById("routeSummary"),
        routeDistanceChip: document.getElementById("routeDistanceChip"),
        routeElevationChip: document.getElementById("routeElevationChip"),
        savedSessionChip: document.getElementById("savedSessionChip"),
        simulationForm: document.getElementById("simulationForm"),
        fitExportForm: document.getElementById("fitExportForm"),
        fitExportFormLive: document.getElementById("fitExportFormLive"),
        liveFitExportCard: document.getElementById("liveFitExportCard"),
        connectHrBtn: document.getElementById("connectHrBtn"),
        connectPowerBtn: document.getElementById("connectPowerBtn"),
        openRideDashboardBtn: document.getElementById("openRideDashboardBtn"),
        hrDeviceStatus: document.getElementById("hrDeviceStatus"),
        hrDeviceName: document.getElementById("hrDeviceName"),
        powerDeviceStatus: document.getElementById("powerDeviceStatus"),
        powerDeviceName: document.getElementById("powerDeviceName"),
        rideStatusLabel: document.getElementById("rideStatusLabel"),
        rideStatusMeta: document.getElementById("rideStatusMeta"),
        rideSegmentLabel: document.getElementById("rideSegmentLabel"),
        rideSegmentMeta: document.getElementById("rideSegmentMeta"),
        liveHeartRateDisplay: document.getElementById("liveHeartRateDisplay"),
        livePowerDisplay: document.getElementById("livePowerDisplay"),
        liveCadenceDisplay: document.getElementById("liveCadenceDisplay"),
        liveAvgPowerDisplay: document.getElementById("liveAvgPowerDisplay"),
        liveSpeedDisplay: document.getElementById("liveSpeedDisplay"),
        liveDistanceDisplay: document.getElementById("liveDistanceDisplay"),
        startRideBtn: document.getElementById("startRideBtn"),
        stopRideBtn: document.getElementById("stopRideBtn"),
        rideDashboard: document.getElementById("rideDashboard"),
        rideDashboardTitle: document.getElementById("rideDashboardTitle"),
        rideDashboardSubtitle: document.getElementById("rideDashboardSubtitle"),
        rideProgressHeadline: document.getElementById("rideProgressHeadline"),
        rideProgressBar: document.getElementById("rideProgressBar"),
        rideProgressDistance: document.getElementById("rideProgressDistance"),
        rideProgressSegment: document.getElementById("rideProgressSegment"),
        rideDashboardMap: document.getElementById("rideDashboardMap"),
        dashboardAvgHr: document.getElementById("dashboardAvgHr"),
        dashboardAvgPower: document.getElementById("dashboardAvgPower"),
        dashboardMaxPower: document.getElementById("dashboardMaxPower"),
        dashboardTss: document.getElementById("dashboardTss"),
        dashboardCurrentSpeed: document.getElementById("dashboardCurrentSpeed"),
        dashboardCurrentGrade: document.getElementById("dashboardCurrentGrade"),
        closeRideDashboardBtn: document.getElementById("closeRideDashboardBtn"),
        stopRideDashboardBtn: document.getElementById("stopRideDashboardBtn"),
        runSimulationBtn: document.getElementById("runSimulationBtn"),
        downloadSessionBtn: document.getElementById("downloadSessionBtn"),
        downloadFitBtn: document.getElementById("downloadFitBtn"),
        downloadSessionBtnLive: document.getElementById("downloadSessionBtnLive"),
        downloadFitBtnLive: document.getElementById("downloadFitBtnLive"),
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
        checkboxInputs: [...document.querySelectorAll(".checkbox-group input")],
        dashboardMetricsGrid: document.getElementById("dashboardMetricsGrid"),
        customizeMetricsBtn: document.getElementById("customizeMetricsBtn"),
        metricsCustomizer: document.getElementById("metricsCustomizer"),
        elevationChart: document.getElementById("elevationChart"),
        setupElevationChart: document.getElementById("setupElevationChart"),
        mapProviderSelect: document.getElementById("mapProviderSelect")
    };

    // Initialize custom metrics state
    const customMetricsState = {
        currentPower: true,
        avg3sPower: true,
        currentHr: true,
        currentSpeed: true,
        currentCadence: true,
        avgPower: false,
        maxPower: false,
        avgHr: false,
        currentGrade: true,
        tss: false
    };

    let alertStates = {
        halfway: false,
        last3k: false
    };

    function showRideAlert(message) {
        let container = document.getElementById("rideAlertsContainer");
        if (!container) {
            container = document.createElement("div");
            container.id = "rideAlertsContainer";
            container.className = "ride-alerts";
            document.body.appendChild(container);
        }
        
        const alertEl = document.createElement("div");
        alertEl.className = "ride-alert-toast";
        alertEl.textContent = message;
        container.appendChild(alertEl);

        setTimeout(() => {
            alertEl.style.opacity = "0";
            alertEl.style.transform = "translateY(-40px)";
            alertEl.style.transition = "all 0.4s ease";
            setTimeout(() => alertEl.remove(), 400);
        }, 5000);
    }

    const mapController = createMapController({
        previewElement: elements.routeMapPreview,
        dashboardElement: elements.rideDashboardMap
    });

    let lastRenderedSettingsSignature = "";
    let lastRenderedExportSignature = "";

    function bind(el, event, handler) {
        if (el) {
            el.addEventListener(event, handler);
        }
    }

    bind(elements.addSegmentBtn, "click", onAddSegment);
    bind(elements.resetRouteBtn, "click", onResetRoute);
    bind(elements.connectHrBtn, "click", onToggleHeartRate);
    bind(elements.connectPowerBtn, "click", onTogglePowerMeter);
    bind(elements.openRideDashboardBtn, "click", onOpenRideDashboard);
    bind(elements.startRideBtn, "click", onStartRide);
    bind(elements.stopRideBtn, "click", onStopRide);
    bind(elements.closeRideDashboardBtn, "click", onCloseRideDashboard);
    bind(elements.stopRideDashboardBtn, "click", onStopRide);
    bind(elements.runSimulationBtn, "click", onRunSimulation);
    bind(elements.downloadSessionBtn, "click", onDownloadSession);
    bind(elements.downloadFitBtn, "click", onDownloadFit);
    bind(elements.downloadSessionBtnLive, "click", onDownloadSession);
    bind(elements.downloadFitBtnLive, "click", onDownloadFit);
    
    if (elements.gpxFileInput) {
        elements.gpxFileInput.addEventListener("change", async (event) => {
            const [file] = event.target.files ?? [];
            if (!file) return;
            await onImportGpx(file);
            event.target.value = "";
        });
    }

    if (elements.personalSettingsForm) {
        elements.personalSettingsForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.personalSettingsForm));
        });
    }

    if (elements.simPowerForm) {
        elements.simPowerForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.simPowerForm));
        });
    }

    if (elements.fitExportForm) {
        elements.fitExportForm.addEventListener("input", () => {
            onUpdateExportMetadata(readExportMetadataFromForm(elements.fitExportForm));
        });
    }

    if (elements.fitExportFormLive) {
        elements.fitExportFormLive.addEventListener("input", () => {
            onUpdateExportMetadata(readExportMetadataFromForm(elements.fitExportFormLive));
        });
    }

    bind(elements.customizeMetricsBtn, "click", () => {
        if (elements.metricsCustomizer) {
            elements.metricsCustomizer.hidden = !elements.metricsCustomizer.hidden;
        }
    });

    if (elements.metricsCustomizer) {
        const checkboxes = elements.metricsCustomizer.querySelectorAll("input[type=checkbox]");
        checkboxes.forEach(cb => {
            cb.addEventListener("change", (e) => {
                customMetricsState[e.target.value] = e.target.checked;
                renderRideDashboard(store.getState()); // re-render dashboard
            });
        });
    }

    elements.checkboxInputs.forEach((input) => {
        input.addEventListener("change", (event) => {
            onUpdatePipConfig(event.target.value, event.target.checked);
        });
    });

    store.subscribe((state) => {
        renderUiMode(state);
        renderSettings(state);
        renderExportMetadata(state);
        renderRouteTable(state);
        renderRouteSummary(state);
        renderRouteMap(state);
        renderBle(state);
        renderSession(state);
        renderRideDashboard(state);
        renderPipControls(state);
    });

    if (elements.mapProviderSelect) {
        elements.mapProviderSelect.addEventListener("change", (e) => {
            mapController.setMapProvider(e.target.value);
        });
    }

    function renderSettings(state) {
        const signature = JSON.stringify(state.settings);

        if (signature === lastRenderedSettingsSignature) {
            return;
        }

        Object.entries(state.settings).forEach(([key, value]) => {
            let field = null;
            if (elements.personalSettingsForm) {
                field = elements.personalSettingsForm.elements.namedItem(key);
            }
            if (!field && elements.simPowerForm) {
                field = elements.simPowerForm.elements.namedItem(key);
            }
            if (!field && elements.simulationForm) {
                field = elements.simulationForm.elements.namedItem(key);
            }

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
            if (elements.fitExportForm) {
                const field = elements.fitExportForm.elements.namedItem(key);
                if (field && document.activeElement !== field) {
                    field.value = value;
                }
            }

            if (elements.fitExportFormLive) {
                const fieldLive = elements.fitExportFormLive.elements.namedItem(key);
                if (fieldLive && document.activeElement !== fieldLive) {
                    fieldLive.value = value;
                }
            }
        });

        lastRenderedExportSignature = signature;
    }

    function renderUiMode(state) {
        const mode = state.uiMode;
        
        if (elements.viewHome) elements.viewHome.hidden = mode !== 'home';
        if (elements.viewSimulation) elements.viewSimulation.hidden = mode !== 'simulation';
        if (elements.viewLive) elements.viewLive.hidden = mode !== 'live';

        if (mode === 'simulation' && elements.simCol1 && elements.routeCardContainer) {
            elements.simCol1.insertBefore(elements.routeCardContainer, elements.simCol1.firstChild);
            elements.routeCardContainer.hidden = false;
        } else if (mode === 'live' && elements.liveCol1 && elements.routeCardContainer) {
            elements.liveCol1.insertBefore(elements.routeCardContainer, elements.liveCol1.firstChild);
            elements.routeCardContainer.hidden = false;
        } else if (elements.routeCardContainer) {
            elements.routeCardContainer.hidden = true;
        }

        // Render history in home view
        if (mode === 'home' && elements.historyContainer) {
            const summary = state.session?.summary;
            if (summary) {
                elements.historyContainer.innerHTML = `
                    <div style="display: grid; gap: 12px; margin-top: 8px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: var(--muted);">总距离</span>
                            <strong>${formatNumber(summary.distanceKm, 2)} km</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: var(--muted);">总用时</span>
                            <strong>${formatDuration(summary.elapsedSeconds)}</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: var(--muted);">平均速度</span>
                            <strong>${formatNumber(summary.averageSpeedKph, 1)} km/h</strong>
                        </div>
                    </div>
                `;
            }
        }
    }

    function renderRouteTable(state) {
        const isGpx = state.route.source === "gpx";
        
        if (elements.routeTableShell) {
            elements.routeTableShell.hidden = isGpx;
        }

        if (isGpx) {
            return;
        }

        if (elements.routeTableBody) {
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
    }

    function renderRouteSummary(state) {
        const route = state.route;
        const isGpx = route.source === "gpx";
        if (elements.routeSourceLabel) elements.routeSourceLabel.textContent = isGpx ? `GPX：${route.name}` : "手工路线";
        if (elements.addSegmentBtn) elements.addSegmentBtn.disabled = isGpx;
        if (elements.routeDistanceChip) elements.routeDistanceChip.textContent = `${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.routeElevationChip) elements.routeElevationChip.textContent = `${Math.round(route.totalElevationGainMeters)} m`;
        if (elements.savedSessionChip) elements.savedSessionChip.textContent = state.session ? "已更新" : state.hasPersistedSession ? "已恢复" : "未保存";
        if (elements.routeSummary) {
            const sourceText = isGpx ? "GPX 导入" : "手工输入";
            const segmentsText = isGpx ? "" : `，共 ${route.segments.length} 段`;
            
            elements.routeSummary.innerHTML = `
                <strong>路线概览</strong><br>
                来源：${sourceText}${segmentsText}，累计距离 ${formatNumber(route.totalDistanceMeters / 1000, 2)} km，
                累计爬升 ${Math.round(route.totalElevationGainMeters)} m，
                累计下降 ${Math.round(route.totalDescentMeters)} m。
            `;
        }
    }

    function renderRouteMap(state) {
        mapController.syncRoute(state.route);
        renderElevationChart(state.route, null);
    }

    function renderSession(state) {
        const session = state.liveRide.session ?? state.session;
        const summary = session?.summary;
        const records = session?.records ?? [];

        if (elements.avgSpeedDisplay) elements.avgSpeedDisplay.innerHTML = `${formatNumber(summary?.averageSpeedKph ?? 0, 1)} <span class="unit">km/h</span>`;
        if (elements.distanceDisplay) elements.distanceDisplay.innerHTML = `${formatNumber(summary?.distanceKm ?? 0, 2)} <span class="unit">km</span>`;
        if (elements.heartRateDisplay) elements.heartRateDisplay.innerHTML = `${Math.round(summary?.averageHeartRate ?? 0)} <span class="unit">bpm</span>`;
        if (elements.elevationDisplay) elements.elevationDisplay.innerHTML = `${Math.round(summary?.ascentMeters ?? 0)} <span class="unit">m</span>`;
        if (elements.elapsedTimeValue) elements.elapsedTimeValue.textContent = formatDuration(summary?.elapsedSeconds ?? 0);
        if (elements.routeProgressValue) elements.routeProgressValue.textContent = `${Math.round((summary?.routeProgress ?? 0) * 100)}%`;
        if (elements.currentGradeValue) elements.currentGradeValue.textContent = `${formatNumber(summary?.currentGradePercent ?? 0, 1)}%`;
        if (elements.recordCountValue) elements.recordCountValue.textContent = String(records.length);
        if (elements.statusText) elements.statusText.textContent = state.statusText;
        
        if (elements.downloadSessionBtn) elements.downloadSessionBtn.disabled = !session || state.liveRide.isActive;
        if (elements.downloadFitBtn) elements.downloadFitBtn.disabled = !session || state.liveRide.isActive;
        if (elements.downloadSessionBtnLive) elements.downloadSessionBtnLive.disabled = !session || state.liveRide.isActive;
        if (elements.downloadFitBtnLive) elements.downloadFitBtnLive.disabled = !session || state.liveRide.isActive;
        if (elements.runSimulationBtn) elements.runSimulationBtn.disabled = state.liveRide.isActive;

        renderRecords(records);
        renderChart(records);
    }

    function renderBle(state) {
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
        if (elements.openRideDashboardBtn) elements.openRideDashboardBtn.disabled = false; // 移除禁用限制，方便随时调试和查看 UI

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

    function renderRideDashboard(state) {
        if (!elements.rideDashboard) return;
        const liveRide = state.liveRide;
        const session = liveRide.session;
        const summary = session?.summary;
        const currentRecord = session?.records?.at(-1) ?? null;
        const route = session?.route ?? state.route;
        const records = session?.records ?? [];

        const powerMeter = state.ble.powerMeter;
        const heartRate = state.ble.heartRate;

        // 计算 3s 平均功率
        let avg3sPower = 0;
        if (records.length > 0) {
            const last3 = records.slice(-3);
            avg3sPower = Math.round(last3.reduce((sum, r) => sum + (r.power || 0), 0) / last3.length);
        }

        elements.rideDashboard.hidden = !liveRide.dashboardOpen;
        if (liveRide.dashboardOpen) {
            document.body.classList.add('dashboard-open');
        } else {
            document.body.classList.remove('dashboard-open');
        }
        
        elements.stopRideDashboardBtn.disabled = !liveRide.isActive;

        if (elements.liveFitExportCard) {
            // Only show FIT export options if a live ride has completed (not active and has a session)
            elements.liveFitExportCard.hidden = liveRide.isActive || !session;
        }

        const metricsData = {
            currentPower: { label: "实时功率", value: powerMeter?.power ?? 0, unit: "W", color: "power-color" },
            avg3sPower: { label: "3秒均功率", value: avg3sPower, unit: "W", color: "power-color" },
            currentHr: { label: "当前心率", value: heartRate?.value ?? 0, unit: "bpm", color: "" },
            currentSpeed: { label: "当前速度", value: formatNumber(summary?.currentSpeedKph ?? 0, 1), unit: "km/h", color: "accent-color" },
            currentCadence: { label: "实时踏频", value: powerMeter?.cadence ?? 0, unit: "rpm", color: "accent-color" },
            avgPower: { label: "平均功率", value: Math.round(summary?.averagePower ?? 0), unit: "W", color: "power-color" },
            maxPower: { label: "最大功率", value: Math.round(summary?.maxPower ?? 0), unit: "W", color: "power-color" },
            avgHr: { label: "平均心率", value: Math.round(summary?.averageHeartRate ?? 0), unit: "bpm", color: "" },
            currentGrade: { label: "当前坡度", value: formatNumber(summary?.currentGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
            tss: { label: "预估 TSS", value: formatNumber(summary?.estimatedTss ?? 0, 1), unit: "", color: "accent-color" }
        };

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            elements.rideDashboardTitle.textContent = "实时骑行界面";
            elements.rideDashboardSubtitle.textContent = "开始骑行后这里会显示实时进度、地图位置与核心训练指标。";
            elements.rideProgressHeadline.textContent = "0%";
            elements.rideProgressBar.style.width = "0%";
            elements.rideProgressDistance.textContent = "0.00 / 0.00 km";
            elements.rideProgressSegment.textContent = "等待开始";
            
            const defaultMetricsHtml = Object.entries(customMetricsState)
                .filter(([key, isEnabled]) => isEnabled)
                .map(([key]) => {
                    const metric = metricsData[key];
                    return `
                        <div class="data-item">
                            <div class="data-label">${metric.label}</div>
                            <div class="data-display ${metric.color}">-- <span class="unit">${metric.unit}</span></div>
                        </div>
                    `;
                }).join("");
            
            if (elements.dashboardMetricsGrid) {
                elements.dashboardMetricsGrid.innerHTML = defaultMetricsHtml;
            }

            mapController.syncRide(route, null);
            return;
        }

        const progressPercent = Math.round((summary?.routeProgress ?? 0) * 100);
        const distanceKm = summary?.distanceKm ?? 0;
        const totalDistanceKm = route.totalDistanceMeters / 1000;
        const remainingKm = totalDistanceKm - distanceKm;

        // 里程提示逻辑
        if (liveRide.isActive && totalDistanceKm > 3) {
            if (progressPercent >= 50 && progressPercent < 55 && !alertStates.halfway) {
                showRideAlert("里程过半！你已经完成了 50% 的路线，继续保持！");
                alertStates.halfway = true;
            }
            if (remainingKm <= 3 && remainingKm > 0 && !alertStates.last3k) {
                showRideAlert("冲刺阶段！距离终点仅剩最后 3 km，加油！");
                alertStates.last3k = true;
            }
        }

        elements.rideDashboardTitle.textContent = route.name || "实时骑行界面";
        elements.rideDashboardSubtitle.textContent = liveRide.isActive
            ? "骑行界面已开启，正在按实时功率推进路线。"
            : "骑行已结束，可在这里回看本次路线进度和核心指标。";
        elements.rideProgressHeadline.textContent = `${progressPercent}%`;
        elements.rideProgressBar.style.width = `${progressPercent}%`;
        elements.rideProgressDistance.textContent = `${formatNumber(summary?.distanceKm ?? 0, 2)} / ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        elements.rideProgressSegment.textContent = currentRecord?.segmentName ?? "等待开始";

        elements.dashboardMetricsGrid.innerHTML = Object.entries(customMetricsState)
            .filter(([key, isEnabled]) => isEnabled)
            .map(([key]) => {
                const metric = metricsData[key];
                return `
                    <div class="data-item">
                        <div class="data-label">${metric.label}</div>
                        <div class="data-display ${metric.color}">${metric.value} <span class="unit">${metric.unit}</span></div>
                    </div>
                `;
            }).join("");

        mapController.syncRide(route, currentRecord);
        renderElevationChart(route, currentRecord);
    }

    function renderElevationChart(route, currentRecord) {
        if (!elements.elevationChart) return;

        if (!route || !route.points || route.points.length === 0) {
            elements.elevationChart.innerHTML = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    导入路线后显示坡度图
                </text>
            `;
            return;
        }

        const width = 640;
        const height = 180;
        const paddingBottom = 20;
        const paddingTop = 20;
        const innerHeight = height - paddingTop - paddingBottom;

        const totalDist = route.totalDistanceMeters;
        
        // 动态计算 Y 轴的零点位置（平路）
        const maxGrade = Math.max(...route.points.map(p => p.gradePercent), 5); // 至少 5%
        const minGrade = Math.min(...route.points.map(p => p.gradePercent), -5); // 至少 -5%
        
        // 我们想让 Y=0 (平路) 在一个固定的基准线上
        // 比如图表上半部分画爬坡，下半部分画下坡
        const gradeRange = maxGrade - minGrade;
        
        // 计算 Y=0 的像素位置 (0 坡度对应的 Y)
        const zeroY = paddingTop + innerHeight * (maxGrade / gradeRange);

        let svgContent = '';

        // Helper to get grade color
        function getGradeColor(grade) {
            if (grade >= 10) return '#e11d48'; // 爬墙 (HC)
            if (grade >= 7) return '#f43f5e';  // 陡坡 (1级)
            if (grade >= 4) return '#f97316';  // 显著上坡 (2级)
            if (grade >= 2) return '#fbbf24';  // 缓坡 (3级)
            if (grade > -2) return '#2dd4bf';  // 平路或微坡
            return '#38bdf8';                  // 下坡
        }

        // 画一条 0 坡度的基准线
        svgContent += `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" />`;

        // 遍历所有的点画柱状图/折线面积图
        let currentX = 0;
        for (let i = 1; i < route.points.length; i++) {
            const prevPoint = route.points[i - 1];
            const currentPoint = route.points[i];
            
            const prevX = (prevPoint.distanceMeters / totalDist) * width;
            const curX = (currentPoint.distanceMeters / totalDist) * width;
            
            const prevY = paddingTop + innerHeight * ((maxGrade - prevPoint.gradePercent) / gradeRange);
            const curY = paddingTop + innerHeight * ((maxGrade - currentPoint.gradePercent) / gradeRange);
            
            const color = getGradeColor(currentPoint.gradePercent);

            // 画一个梯形，底边在 zeroY
            svgContent += `
                <polygon points="${prevX},${zeroY} ${prevX},${prevY} ${curX},${curY} ${curX},${zeroY}" 
                         fill="${color}" opacity="0.8" />
            `;
            
            // 顶部的描边
            svgContent += `
                <line x1="${prevX}" y1="${prevY}" x2="${curX}" y2="${curY}" 
                      stroke="${color}" stroke-width="1.5" />
            `;
        }

        // Draw current position indicator
        if (currentRecord) {
            const posX = (currentRecord.distanceKm * 1000 / totalDist) * width;
            svgContent += `
                <!-- 已骑行区域遮罩 -->
                <rect x="0" y="0" width="${posX}" height="${height}" fill="rgba(0, 0, 0, 0.2)" />
                <!-- 骑行者标记 -->
                <line x1="${posX}" y1="0" x2="${posX}" y2="${height}" stroke="var(--text)" stroke-width="2" stroke-dasharray="4 4" />
                <circle cx="${posX}" cy="${zeroY}" r="5" fill="white" stroke="var(--text)" stroke-width="2" />
            `;
        }

        if (elements.elevationChart) {
            elements.elevationChart.innerHTML = svgContent;
        }
        if (elements.setupElevationChart) {
            // 在设置界面，不需要显示半透明进度遮罩，只显示纯粹的路线图
            let setupSvgContent = svgContent.replace(/<!-- 已骑行区域遮罩 -->[\s\S]*?<\/circle>/, '');
            elements.setupElevationChart.innerHTML = setupSvgContent;
        }
    }

    function renderRecords(records) {
        if (!elements.recordsTableBody) return;
        
        if (records.length === 0) {
            elements.recordsTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">运行模拟后将在这里显示记录。</td></tr>`;
            return;
        }

        // 获取整条路线的汇总数据
        const startRecord = records[0];
        const endRecord = records[records.length - 1];
        
        const durationSeconds = endRecord.elapsedSeconds - startRecord.elapsedSeconds + 1;
        const distanceKm = endRecord.distanceKm - startRecord.distanceKm;
        const avgSpeedKph = durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0;
        const avgPower = Math.round(records.reduce((sum, r) => sum + (r.power || 0), 0) / records.length);
        const avgHr = Math.round(records.reduce((sum, r) => sum + (r.heartRate || 0), 0) / records.length);

        // 如果是导入的GPX等有名字的路线，可以从外层状态取，这里简化用 endRecord 获取或写个通用名
        const routeName = "当前路线总计";
        
        elements.recordsTableBody.innerHTML = `
            <tr>
                <td>${routeName}</td>
                <td>${formatDuration(durationSeconds)}</td>
                <td>${formatNumber(distanceKm, 2)} km</td>
                <td>${formatNumber(avgSpeedKph, 1)} km/h</td>
                <td>${avgPower} W</td>
                <td>${avgHr} bpm</td>
            </tr>
        `;
    }

    function renderChart(records) {
        if (!elements.distanceChart) return;

        if (records.length === 0) {
            elements.distanceChart.innerHTML = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14">
                    运行模拟后将显示图像
                </text>
            `;
            return;
        }

        const width = 640;
        const height = 280;
        const padding = 40;

        const maxTime = records[records.length - 1].elapsedSeconds;
        const maxDist = records[records.length - 1].distanceKm;

        const points = records.map((r) => {
            const x = padding + (r.elapsedSeconds / maxTime) * (width - padding * 2);
            const y = height - padding - (r.distanceKm / maxDist) * (height - padding * 2);
            return `${x},${y}`;
        }).join(" ");

        elements.distanceChart.innerHTML = `
            <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
            
            <!-- X 轴 (时间) -->
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
            <text x="${padding}" y="${height - padding + 20}" fill="#64748b" font-size="12">0s</text>
            <text x="${width - padding}" y="${height - padding + 20}" fill="#64748b" font-size="12" text-anchor="end">${formatDuration(maxTime)}</text>
            
            <!-- Y 轴 (距离) -->
            <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
            <text x="${padding - 10}" y="${height - padding}" fill="#64748b" font-size="12" text-anchor="end">0 km</text>
            <text x="${padding - 10}" y="${padding}" fill="#64748b" font-size="12" text-anchor="end">${formatNumber(maxDist, 1)} km</text>
        `;
    }

    function renderPipControls(state) {
        if (!elements.pipBtn) return;
        const hasLiveData = state.ble.heartRate.value !== null || state.ble.powerMeter.power !== null;
        const hasRoute = state.route && state.route.segments.length > 0;
        elements.pipBtn.disabled = !pipController.isSupported || (!state.liveRide.isActive && !state.session && !hasLiveData && !hasRoute);

        pipController.render();
        pipController.sync();
    }
}

function readSettingsFromForm(form) {
    const formData = new FormData(form);

    return {
        power: Number(formData.get("power")),
        mass: Number(formData.get("mass")),
        ftp: Number(formData.get("ftp")),
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
