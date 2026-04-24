import { formatNumber } from "../../shared/format.js";
import { buildDashboardViewModel } from "../../app/view-models/live-ride-view-model.js";
import { buildTrajectoryOverviewSvg } from "./svg/dashboard-charts.js";
import { createDashboardMetricsRenderer } from "./dashboard-metrics-renderer.js";
import { createWorkoutRuntimeRenderer } from "./workout-runtime-renderer.js";

export function createDashboardRenderer({
    elements,
    mapController
}) {
    const dashboardMetricsRenderer = createDashboardMetricsRenderer({ elements });
    const workoutRuntimeRenderer = createWorkoutRuntimeRenderer({ elements });
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
                if (immersiveStreetViewMode && elements.metricsCustomizer) {
                    elements.metricsCustomizer.hidden = true;
                }
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
        const viewModel = buildDashboardViewModel({
            state,
            customMetricsState,
            immersiveStreetViewMode,
            streetViewLoaded
        });
        const { ride, training, metricsData, enabledMetricKeys } = viewModel;
        const { snapshot: rideSnapshot, session, currentRecord, route, records, distanceKm } = ride;

        elements.rideDashboard.hidden = !ride.dashboardOpen;
        if (ride.dashboardOpen) {
            document.body.classList.add('dashboard-open');
        } else {
            document.body.classList.remove('dashboard-open');
        }
        
        if (elements.stopRideDashboardBtn) {
            elements.stopRideDashboardBtn.disabled = !ride.isActive;
        }
        if (elements.startRideDashboardBtn) {
            elements.startRideDashboardBtn.disabled = !ride.canStart || ride.isActive;
        }
        if (elements.deviceControlsPanel) {
            elements.deviceControlsPanel.style.display = ride.isActive ? "none" : "grid";
        }
        if (elements.rideDashboard) {
            elements.rideDashboard.classList.toggle("immersive-street-view", immersiveStreetViewMode);
        }
        document.body.classList.toggle("immersive-street-view-active", immersiveStreetViewMode && ride.dashboardOpen);
        if (elements.immersiveStreetViewBtn) {
            const canShow = viewModel.canShowImmersiveStreetView;
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

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = "实时骑行界面";
            if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = "开始骑行后这里会显示实时进度、地图位置与核心训练指标。";
            if (elements.rideProgressHeadline) elements.rideProgressHeadline.textContent = "0%";
            if (elements.rideProgressBar) elements.rideProgressBar.style.width = "0%";
            if (elements.rideProgressDistance) elements.rideProgressDistance.textContent = "0.00 / 0.00 km";
            if (elements.rideProgressSegment) elements.rideProgressSegment.textContent = "等待开始";

            dashboardMetricsRenderer.render({
                metricsData,
                enabledMetricKeys,
                immersiveStreetViewMode,
                hasSession: false
            });

            renderTrajectoryOverview(rideSnapshot, route, null);
            workoutRuntimeRenderer.render({ rideSnapshot, training, records });
            syncRideMap(rideSnapshot, route, null);
            return;
        }

        const progressPercent = ride.progressPercent;
        const totalDistanceKm = ride.totalDistanceKm;
        const remainingKm = ride.remainingKm;

        if (ride.isActive && totalDistanceKm > 3) {
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
        if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = ride.isActive
            ? "骑行界面已开启，正在按实时功率推进路线。"
            : "骑行已结束，可在这里回看本次路线进度和核心指标。";
        if (elements.rideProgressHeadline) elements.rideProgressHeadline.textContent = `${progressPercent}%`;
        if (elements.rideProgressBar) elements.rideProgressBar.style.width = `${progressPercent}%`;
        if (elements.rideProgressDistance) elements.rideProgressDistance.textContent = `${formatNumber(distanceKm ?? 0, 2)} / ${formatNumber(route.totalDistanceMeters / 1000, 2)} km`;
        if (elements.rideProgressSegment) elements.rideProgressSegment.textContent = currentRecord?.segmentName ?? "等待开始";

        dashboardMetricsRenderer.render({
            metricsData,
            enabledMetricKeys,
            immersiveStreetViewMode,
            hasSession: true
        });

        renderTrajectoryOverview(rideSnapshot, route, currentRecord);
        workoutRuntimeRenderer.render({ rideSnapshot, training, records });
        syncRideMap(rideSnapshot, route, currentRecord);
    }

    function renderTrajectoryOverview(rideSnapshot, route, currentRecord) {
        if (!elements.streetViewTrajectorySvg) return;
        elements.streetViewTrajectorySvg.innerHTML = buildTrajectoryOverviewSvg(
            rideSnapshot?.session?.route ?? route,
            rideSnapshot?.currentRecord ?? currentRecord
        );
    }

    function syncRideMap(rideSnapshot, route, currentRecord) {
        mapController.syncRide(
            rideSnapshot?.session?.route ?? route,
            rideSnapshot?.currentRecord ?? currentRecord
        );
    }

    return {
        bindEvents,
        render
    };
}
