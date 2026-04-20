import { formatNumber } from "../../shared/format.js";

export function createDashboardRenderer({
    elements,
    mapController
}) {
    const customMetricsState = {
        currentPower: true,
        avg3sPower: true,
        currentHr: true,
        currentSpeed: true,
        currentCadence: true,
        pushedGrade: true,
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
    let streetViewLoaded = false;
    let immersiveStreetViewMode = false;

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

    function bindEvents(store) {
        if (elements.customizeMetricsBtn) {
            elements.customizeMetricsBtn.addEventListener("click", () => {
                if (elements.metricsCustomizer) {
                    elements.metricsCustomizer.hidden = !elements.metricsCustomizer.hidden;
                }
            });
        }

        if (elements.loadStreetViewBtn) {
            elements.loadStreetViewBtn.addEventListener("click", async () => {
                const apiKey = elements.streetViewApiKey?.value?.trim();
                if (!apiKey) {
                    alert("请输入 Google Maps API Key");
                    return;
                }
                
                if (elements.loadStreetViewBtn.disabled) return;
                elements.loadStreetViewBtn.disabled = true;
                elements.loadStreetViewBtn.textContent = "加载中...";
                streetViewLoaded = false;
                try {
                    await mapController.enableStreetView({
                        apiKey,
                        container1: elements.svPano1,
                        container2: elements.svPano2
                    });
                    elements.loadStreetViewBtn.textContent = "街景已开启";
                    elements.streetViewContainer.style.display = "block";
                    streetViewLoaded = true;
                } catch (error) {
                    alert(error?.message ?? "街景加载失败，请检查网络连接或 API Key。");
                    streetViewLoaded = false;
                    elements.loadStreetViewBtn.disabled = false;
                    elements.loadStreetViewBtn.textContent = "加载街景";
                    if (elements.immersiveStreetViewBtn) {
                        elements.immersiveStreetViewBtn.hidden = true;
                    }
                }
            });
        }

        if (elements.immersiveStreetViewBtn) {
            elements.immersiveStreetViewBtn.addEventListener("click", () => {
                if (!streetViewLoaded) {
                    alert("请先输入 API Key 并点击“加载街景”。");
                    return;
                }
                immersiveStreetViewMode = !immersiveStreetViewMode;
                elements.rideDashboard?.classList.toggle("immersive-street-view", immersiveStreetViewMode);
                elements.immersiveStreetViewBtn.textContent = immersiveStreetViewMode ? "退出沉浸模式" : "进入沉浸街景";
            });
        }

        if (elements.immersiveBackBtn) {
            elements.immersiveBackBtn.addEventListener("click", () => {
                immersiveStreetViewMode = false;
                elements.rideDashboard?.classList.remove("immersive-street-view");
                document.body.classList.remove("immersive-street-view-active");
                if (elements.immersiveStreetViewBtn) {
                    elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
                }
            });
        }

        if (elements.metricsCustomizer) {
            const checkboxes = elements.metricsCustomizer.querySelectorAll("input[type=checkbox]");
            checkboxes.forEach(cb => {
                cb.addEventListener("change", (e) => {
                    customMetricsState[e.target.value] = e.target.checked;
                    if (store) {
                        render(store.getState());
                    }
                });
            });
        }
    }

    function render(state) {
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
        
        if (elements.stopRideDashboardBtn) {
            elements.stopRideDashboardBtn.disabled = !liveRide.isActive;
        }
        if (elements.startRideDashboardBtn) {
            elements.startRideDashboardBtn.disabled = !liveRide.canStart || liveRide.isActive;
        }
        if (elements.deviceControlsPanel) {
            elements.deviceControlsPanel.style.display = liveRide.isActive ? "none" : "grid";
        }
        if (elements.rideDashboard) {
            elements.rideDashboard.classList.toggle("immersive-street-view", immersiveStreetViewMode);
        }
        document.body.classList.toggle("immersive-street-view-active", immersiveStreetViewMode && liveRide.dashboardOpen);
        if (elements.immersiveStreetViewBtn) {
            const canShow = liveRide.isActive && streetViewLoaded;
            elements.immersiveStreetViewBtn.hidden = !canShow;
            if (!canShow && immersiveStreetViewMode) {
                immersiveStreetViewMode = false;
                elements.rideDashboard?.classList.remove("immersive-street-view");
                document.body.classList.remove("immersive-street-view-active");
            }
            if (!immersiveStreetViewMode) {
                elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
            }
        }

        const metricsData = {
            currentPower: { label: "实时功率", value: powerMeter?.power ?? 0, unit: "W", color: "power-color" },
            avg3sPower: { label: "3秒均功率", value: avg3sPower, unit: "W", color: "power-color" },
            currentHr: { label: "当前心率", value: heartRate?.value ?? 0, unit: "bpm", color: "" },
            currentSpeed: { label: "当前速度", value: formatNumber(summary?.currentSpeedKph ?? 0, 1), unit: "km/h", color: "accent-color" },
            currentCadence: { label: "实时踏频", value: powerMeter?.cadence ?? 0, unit: "rpm", color: "accent-color" },
            pushedGrade: { label: "推送坡度", value: formatNumber(state.workout?.runtime?.targetTrainerGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
            avgPower: { label: "平均功率", value: Math.round(summary?.averagePower ?? 0), unit: "W", color: "power-color" },
            maxPower: { label: "最大功率", value: Math.round(summary?.maxPower ?? 0), unit: "W", color: "power-color" },
            avgHr: { label: "平均心率", value: Math.round(summary?.averageHeartRate ?? 0), unit: "bpm", color: "" },
            currentGrade: { label: "当前坡度", value: formatNumber(summary?.currentGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
            tss: { label: "预估 TSS", value: formatNumber(summary?.estimatedTss ?? 0, 1), unit: "", color: "accent-color" }
        };

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = "实时骑行界面";
            if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = "开始骑行后这里会显示实时进度、地图位置与核心训练指标。";
            if (elements.rideProgressHeadline) elements.rideProgressHeadline.textContent = "0%";
            if (elements.rideProgressBar) elements.rideProgressBar.style.width = "0%";
            if (elements.rideProgressDistance) elements.rideProgressDistance.textContent = "0.00 / 0.00 km";
            if (elements.rideProgressSegment) elements.rideProgressSegment.textContent = "等待开始";
            
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
                elements.dashboardMetricsGrid.innerHTML = immersiveStreetViewMode
                    ? getImmersiveMetricsHtml(metricsData)
                    : defaultMetricsHtml;
            }

            renderTrajectoryOverview(route, null);
            mapController.syncRide(route, null);
            return;
        }

        const progressPercent = Math.round((summary?.routeProgress ?? 0) * 100);
        const distanceKm = summary?.distanceKm ?? 0;
        const totalDistanceKm = route.totalDistanceMeters / 1000;
        const remainingKm = totalDistanceKm - distanceKm;

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

        if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = route.name || "实时骑行界面";
        if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = liveRide.isActive
            ? "骑行界面已开启，正在按实时功率推进路线。"
            : "骑行已结束，可在这里回看本次路线进度和核心指标。";
        if (elements.rideProgressHeadline) elements.rideProgressHeadline.textContent = `${progressPercent}%`;
        if (elements.rideProgressBar) elements.rideProgressBar.style.width = `${progressPercent}%`;
        if (elements.rideProgressDistance) elements.rideProgressDistance.textContent = `${formatNumber(summary?.distanceKm ?? 0, 2)} / ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.rideProgressSegment) elements.rideProgressSegment.textContent = currentRecord?.segmentName ?? "等待开始";

        if (elements.dashboardMetricsGrid) {
            elements.dashboardMetricsGrid.innerHTML = immersiveStreetViewMode
                ? getImmersiveMetricsHtml(metricsData)
                : Object.entries(customMetricsState)
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
        }

        renderTrajectoryOverview(route, currentRecord);
        mapController.syncRide(route, currentRecord);
    }

    function getImmersiveMetricsHtml(metricsData) {
        const immersiveKeys = ["currentSpeed", "currentPower", "currentGrade", "currentCadence", "currentHr"];
        return immersiveKeys.map((key) => {
            const metric = metricsData[key];
            return `
                <div class="data-item">
                    <div class="data-label">${metric.label}</div>
                    <div class="data-display ${metric.color}">${metric.value} <span class="unit">${metric.unit}</span></div>
                </div>
            `;
        }).join("");
    }

    function renderTrajectoryOverview(route, currentRecord) {
        if (!elements.streetViewTrajectorySvg) return;

        const points = (route?.points ?? []).filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
        if (points.length < 2) {
            elements.streetViewTrajectorySvg.innerHTML = `
                <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12">
                    暂无轨迹数据
                </text>
            `;
            return;
        }

        const width = 300;
        const height = 180;
        const padding = 14;
        const lats = points.map((p) => p.latitude);
        const lngs = points.map((p) => p.longitude);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);
        const latRange = Math.max(maxLat - minLat, 1e-9);
        const lngRange = Math.max(maxLng - minLng, 1e-9);

        const toX = (lng) => padding + ((lng - minLng) / lngRange) * (width - padding * 2);
        const toY = (lat) => height - padding - ((lat - minLat) / latRange) * (height - padding * 2);

        const polyline = points.map((p) => `${toX(p.longitude).toFixed(1)},${toY(p.latitude).toFixed(1)}`).join(" ");
        const start = points[0];
        const end = points.at(-1);
        const currentLat = typeof currentRecord?.positionLat === "number" ? currentRecord.positionLat : end.latitude;
        const currentLng = typeof currentRecord?.positionLong === "number" ? currentRecord.positionLong : end.longitude;

        elements.streetViewTrajectorySvg.innerHTML = `
            <rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a" rx="10"></rect>
            <polyline points="${polyline}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
            <circle cx="${toX(start.longitude).toFixed(1)}" cy="${toY(start.latitude).toFixed(1)}" r="4.2" fill="#22c55e"></circle>
            <circle cx="${toX(end.longitude).toFixed(1)}" cy="${toY(end.latitude).toFixed(1)}" r="4.2" fill="#ef4444"></circle>
            <circle cx="${toX(currentLng).toFixed(1)}" cy="${toY(currentLat).toFixed(1)}" r="5.3" fill="#f8fafc" stroke="#2563eb" stroke-width="2.2"></circle>
        `;
    }

    return {
        bindEvents,
        render
    };
}
