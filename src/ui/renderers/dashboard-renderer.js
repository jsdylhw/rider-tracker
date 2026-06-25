import { formatNumber } from "../../shared/format.js";
import { buildDashboardViewModel } from "../../app/view-models/live-ride-view-model.js";
import { buildTrajectoryOverviewSvg } from "./svg/dashboard-charts.js";
import { buildGradeChartSvg } from "./svg/route-charts.js";
import { createDashboardMetricsRenderer } from "./dashboard-metrics-renderer.js";
import { createWorkoutRuntimeRenderer } from "./workout-runtime-renderer.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import {
    DEFAULT_METRIC_SELECTION,
    METRIC_LABELS,
    METRIC_OPTIONS,
    normalizeMetricSelection
} from "../../shared/live-metrics.js";

const LIVE_VISUAL_UPDATE_INTERVAL_MS = 1000;
const STREET_VIEW_SYNC_INTERVAL_MS = 500;

export function createDashboardRenderer({
    elements,
    mapController,
    streetViewControllerRef,
    onEnableStreetView,
    onUpdateWorkoutMode,
    onUpdateErgTargetPower,
    onUpdateResistanceLevel,
    onUpdateGradeDifficulty
}) {
    function isStreetViewLoaded() {
        return streetViewControllerRef?.current != null;
    }
    const dashboardMetricsRenderer = createDashboardMetricsRenderer({ elements });
    const workoutRuntimeRenderer = createWorkoutRuntimeRenderer({ elements });
    const customMetricsState = normalizeMetricSelection(DEFAULT_METRIC_SELECTION);

    let alertStates = {
        halfway: false,
        last3k: false
    };
    let immersiveStreetViewMode = false;
    let immersiveUiHidden = false;
    let previousImmersiveStreetViewMode = false;
    let previousDashboardOpen = false;
    const visualRenderState = {
        map: createVisualRenderSlot(),
        streetView: createVisualRenderSlot(),
        trajectory: createVisualRenderSlot(),
        gradeChart: createVisualRenderSlot(),
        workoutRuntime: createVisualRenderSlot()
    };

    function resetVisualRenderState() {
        Object.values(visualRenderState).forEach((slot) => {
            slot.lastRenderedAt = 0;
            slot.lastSignature = "";
        });
    }

    function setImmersiveUiHidden(hidden) {
        immersiveUiHidden = hidden;
        elements.rideDashboard?.classList.toggle("immersive-ui-hidden", immersiveUiHidden);
        if (elements.immersiveUiToggleBtn) {
            elements.immersiveUiToggleBtn.textContent = immersiveUiHidden ? "显示 UI" : "隐藏 UI";
        }
    }

    function exitImmersiveStreetView() {
        immersiveStreetViewMode = false;
        setImmersiveUiHidden(false);
        elements.rideDashboard?.classList.remove("immersive-street-view");
        document.body.classList.remove("immersive-street-view-active");
        if (elements.immersiveStreetViewBtn) {
            elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
        }
    }

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
                try {
                    await onEnableStreetView({
                        apiKey,
                        container1: elements.svPano1,
                        container2: elements.svPano2
                    });
                    elements.loadStreetViewBtn.textContent = "街景已开启";
                    elements.streetViewContainer.style.display = "block";
                } catch (error) {
                    alert(error?.message ?? "街景加载失败，请检查网络连接或 API Key。");
                    elements.loadStreetViewBtn.disabled = false;
                    elements.loadStreetViewBtn.textContent = "加载街景";
                    if (elements.immersiveStreetViewBtn) {
                        elements.immersiveStreetViewBtn.hidden = true;
                    }
                    setImmersiveUiHidden(false);
                }
            });
        }

        if (elements.immersiveStreetViewBtn) {
            elements.immersiveStreetViewBtn.addEventListener("click", () => {
                if (!isStreetViewLoaded()) {
                    alert("请先输入 API Key 并点击“加载街景”。");
                    return;
                }
                immersiveStreetViewMode = !immersiveStreetViewMode;
                resetVisualRenderState();
                if (immersiveStreetViewMode && elements.metricsCustomizer) {
                    elements.metricsCustomizer.hidden = true;
                }
                if (!immersiveStreetViewMode) {
                    setImmersiveUiHidden(false);
                }
                elements.rideDashboard?.classList.toggle("immersive-street-view", immersiveStreetViewMode);
                elements.immersiveStreetViewBtn.textContent = immersiveStreetViewMode ? "退出沉浸模式" : "进入沉浸街景";
            });
        }

        if (elements.immersiveUiToggleBtn) {
            elements.immersiveUiToggleBtn.textContent = "隐藏 UI";
            elements.immersiveUiToggleBtn.addEventListener("click", () => {
                if (!immersiveStreetViewMode) return;
                setImmersiveUiHidden(!immersiveUiHidden);
            });
        }

        if (elements.immersiveBackBtn) {
            elements.immersiveBackBtn.addEventListener("click", () => {
                exitImmersiveStreetView();
            });
        }

        function toggleTrainingCard() {
            const card = elements.trainingControlCard;
            if (!card) return;
            card.hidden = !card.hidden;
        }

        if (elements.toggleTrainingBtn) {
            elements.toggleTrainingBtn.addEventListener("click", toggleTrainingCard);
        }
        if (elements.immersiveTrainingBtn) {
            elements.immersiveTrainingBtn.addEventListener("click", toggleTrainingCard);
        }

        bindCustomMetricControls(store);
        bindTrainingControls(store);
    }

    function bindTrainingControls(store) {
        const card = elements.trainingControlCard;
        const toggle = elements.trainingControlToggle;
        if (!card || !toggle) return;

        toggle.addEventListener("click", () => {
            card.classList.toggle("collapsed");
        });

        // Mode buttons
        card.querySelectorAll(".training-mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const mode = btn.dataset.mode;
                if (mode && onUpdateWorkoutMode) onUpdateWorkoutMode(mode);
            });
        });

        // ERG power slider
        if (elements.trainingErgPowerSlider) {
            elements.trainingErgPowerSlider.addEventListener("input", () => {
                const watts = Number(elements.trainingErgPowerSlider.value);
                if (elements.trainingErgValue) elements.trainingErgValue.textContent = String(watts);
                if (onUpdateErgTargetPower) onUpdateErgTargetPower(watts);
            });
        }

        // Resistance slider
        if (elements.trainingResistanceSlider) {
            elements.trainingResistanceSlider.addEventListener("input", () => {
                const level = Number(elements.trainingResistanceSlider.value);
                if (elements.trainingResistanceValue) elements.trainingResistanceValue.textContent = String(level);
                if (onUpdateResistanceLevel) onUpdateResistanceLevel(level);
            });
        }

        // Grade difficulty slider
        if (elements.trainingDifficultySlider) {
            elements.trainingDifficultySlider.addEventListener("input", () => {
                const diff = Number(elements.trainingDifficultySlider.value);
                if (elements.trainingDifficultyValue) elements.trainingDifficultyValue.textContent = String(diff);
                if (onUpdateGradeDifficulty) onUpdateGradeDifficulty(diff);
            });
        }
    }

    function bindCustomMetricControls(store) {
        renderSelectedMetrics();
        syncMetricAddOptions();

        elements.addMetricBtn?.addEventListener("click", () => {
            const key = elements.metricAddSelect?.value;
            if (!key || !Object.hasOwn(customMetricsState, key)) return;

            customMetricsState[key] = true;
            if (elements.metricAddSelect) {
                elements.metricAddSelect.value = "";
            }
            renderSelectedMetrics();
            syncMetricAddOptions();
            if (store) render(store.getState());
        });

        elements.metricAddSelect?.addEventListener("change", () => {
            if (elements.addMetricBtn) {
                elements.addMetricBtn.disabled = !elements.metricAddSelect.value;
            }
        });

        elements.selectedMetricsList?.addEventListener("click", (event) => {
            const removeButton = event.target.closest("[data-remove-metric]");
            if (!removeButton) return;

            const key = removeButton.dataset.removeMetric;
            if (!Object.hasOwn(customMetricsState, key)) return;

            customMetricsState[key] = false;
            renderSelectedMetrics();
            syncMetricAddOptions();
            if (store) render(store.getState());
        });
    }

    function renderSelectedMetrics() {
        if (!elements.selectedMetricsList) return;
        const enabledOptions = METRIC_OPTIONS.filter((option) => customMetricsState[option.key]);

        if (!enabledOptions.length) {
            elements.selectedMetricsList.innerHTML = `<p class="section-subtitle">还没有选择数据项，请从上方下拉菜单添加。</p>`;
            return;
        }

        elements.selectedMetricsList.innerHTML = enabledOptions
            .map((option) => `
                <span class="metric-chip-item">
                    <span class="metric-chip-group">${option.group}</span>
                    ${option.label}
                    <button type="button" class="metric-chip-remove" data-remove-metric="${option.key}" aria-label="移除${option.label}">×</button>
                </span>
            `)
            .join("");
    }

    function syncMetricAddOptions() {
        if (!elements.metricAddSelect) return;

        [...elements.metricAddSelect.options].forEach((option) => {
            if (!option.value) return;
            option.disabled = customMetricsState[option.value] === true;
            const metric = METRIC_LABELS[option.value];
            if (metric) {
                option.textContent = customMetricsState[option.value]
                    ? `${metric.label}（已添加）`
                    : metric.label;
            }
        });

        if (elements.addMetricBtn) {
            elements.addMetricBtn.disabled = !elements.metricAddSelect.value;
        }
    }

    function render(state) {
        if (!elements.rideDashboard) return;
        const now = Date.now();
        const viewModel = buildDashboardViewModel({
            state,
            customMetricsState,
            immersiveStreetViewMode,
            streetViewLoaded: isStreetViewLoaded()
        });
        const { ride, training, metricsData, enabledMetricKeys } = viewModel;
        const { session, currentRecord, route, records, distanceKm } = ride;
        const isGradeSimulation = training.mode === WORKOUT_MODES.GRADE_SIM;
        const modeChanged = previousImmersiveStreetViewMode !== immersiveStreetViewMode;
        const dashboardOpenChanged = previousDashboardOpen !== ride.dashboardOpen;
        if (modeChanged) {
            resetVisualRenderState();
            previousImmersiveStreetViewMode = immersiveStreetViewMode;
        }
        if (dashboardOpenChanged) {
            resetVisualRenderState();
            previousDashboardOpen = ride.dashboardOpen;
        }

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
            elements.rideDashboard.classList.toggle("immersive-ui-hidden", immersiveUiHidden);
        }
        syncElevationChartCopy();
        renderTrainingControls(state);
        document.body.classList.toggle("immersive-street-view-active", immersiveStreetViewMode && ride.dashboardOpen);
        if (elements.immersiveStreetViewBtn) {
            const canShow = viewModel.canShowImmersiveStreetView;
            elements.immersiveStreetViewBtn.hidden = !canShow;
            if (!canShow && immersiveStreetViewMode) {
                exitImmersiveStreetView();
            }
            if (!immersiveStreetViewMode) {
                elements.immersiveStreetViewBtn.textContent = "进入沉浸街景";
            }
        }

        if (!ride.dashboardOpen) {
            return;
        }

        if (!session) {
            alertStates.halfway = false;
            alertStates.last3k = false;
            if (elements.rideDashboardTitle) elements.rideDashboardTitle.textContent = "实时骑行界面";
            if (elements.rideDashboardSubtitle) elements.rideDashboardSubtitle.textContent = "";
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

            renderHeavyVisuals({
                session,
                route,
                currentRecord: null,
                records,
                training,
                isGradeSimulation,
                now,
                force: modeChanged || dashboardOpenChanged
            });
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

        renderHeavyVisuals({
            session,
            route,
            currentRecord,
            records,
            training,
            isGradeSimulation,
            now,
            force: modeChanged || dashboardOpenChanged
        });
    }

    function renderHeavyVisuals({
        session,
        route,
        currentRecord,
        records,
        training,
        isGradeSimulation,
        now,
        force = false
    }) {
        const distanceMeters = Math.round((currentRecord?.distanceKm ?? 0) * 1000);
        const routeSignature = buildRouteSignature(route);
        const positionSignature = `${routeSignature}:${distanceMeters}`;
        const workoutSignature = [
            records?.length ?? 0,
            training?.mode ?? "",
            training?.runtime?.customWorkoutTargetStepIndex ?? "",
            training?.runtime?.customWorkoutTargetPowerWatts ?? "",
            training?.runtime?.targetErgPowerWatts ?? "",
            Math.round((training?.runtime?.customWorkoutTargetProgress ?? 0) * 100)
        ].join(":");

        if (shouldRenderVisual(visualRenderState.trajectory, positionSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force)) {
            renderTrajectoryOverview(route, currentRecord, isGradeSimulation);
        }

        if (shouldRenderVisual(visualRenderState.gradeChart, positionSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force)) {
            renderImmersiveGradeChart(route, currentRecord, isGradeSimulation);
        }

        if (shouldRenderVisual(visualRenderState.workoutRuntime, workoutSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force)) {
            workoutRuntimeRenderer.render({ liveSession: session, training, records });
        }

        syncRideVisuals({
            route,
            currentRecord,
            positionSignature,
            now,
            force
        });
    }

    function renderTrajectoryOverview(route, currentRecord, isGradeSimulation) {
        if (elements.trajectoryCard) {
            elements.trajectoryCard.hidden = !isGradeSimulation;
        }
        if (!elements.streetViewTrajectorySvg) return;
        if (!isGradeSimulation) {
            elements.streetViewTrajectorySvg.innerHTML = "";
            return;
        }
        elements.streetViewTrajectorySvg.innerHTML = buildTrajectoryOverviewSvg(
            route,
            currentRecord,
            { title: "路线平面图" }
        );
    }

    function renderImmersiveGradeChart(route, currentRecord, isGradeSimulation) {
        if (!elements.rideDashboardElevationChart || !immersiveStreetViewMode || !isGradeSimulation) {
            return;
        }

        elements.rideDashboardElevationChart.setAttribute("preserveAspectRatio", "xMidYMid meet");
        elements.rideDashboardElevationChart.innerHTML = buildGradeChartSvg(
            route,
            currentRecord,
            { transparent: true }
        );
    }

    function syncElevationChartCopy() {
        if (elements.rideElevationChartTitle) {
            elements.rideElevationChartTitle.textContent = immersiveStreetViewMode ? "路线坡度图" : "路线海拔剖面";
        }
        if (elements.rideElevationChartSubtitle) {
            elements.rideElevationChartSubtitle.textContent = immersiveStreetViewMode
                ? "全程坡度图，右侧显示当前位置附近的短距离坡度。"
                : "距离-海拔图（含当前骑行位置）。";
        }
        elements.rideDashboardElevationChart?.setAttribute(
            "preserveAspectRatio",
            "xMidYMid meet"
        );
    }

    function syncRideVisuals({ route, currentRecord, positionSignature, now, force }) {
        const shouldSyncMap = !immersiveStreetViewMode
            && shouldRenderVisual(visualRenderState.map, positionSignature, now, LIVE_VISUAL_UPDATE_INTERVAL_MS, force);
        const shouldSyncStreetView = isStreetViewLoaded()
            && shouldRenderVisual(visualRenderState.streetView, positionSignature, now, STREET_VIEW_SYNC_INTERVAL_MS, force);

        if (shouldSyncMap) {
            mapController.syncRide(route, currentRecord);
        }

        if (shouldSyncStreetView) {
            streetViewControllerRef.current.update(route, currentRecord);
        }
    }

    function renderTrainingControls(state) {
        const card = elements.trainingControlCard;
        if (!card) return;

        const isActive = state.liveRide?.isActive === true;
        if (elements.toggleTrainingBtn) {
            elements.toggleTrainingBtn.hidden = !isActive;
        }
        if (elements.immersiveTrainingBtn) {
            elements.immersiveTrainingBtn.hidden = !isActive;
        }
        if (!isActive) {
            card.hidden = true;
            return;
        }

        // Highlight active mode button
        const mode = state.workout?.mode ?? WORKOUT_MODES.GRADE_SIM;
        card.querySelectorAll(".training-mode-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.mode === mode);
        });

        // Show/hide params based on mode
        const isErg = mode === WORKOUT_MODES.FIXED_POWER;
        const isResistance = mode === WORKOUT_MODES.FREE_RIDE;
        const isGradeSim = mode === WORKOUT_MODES.GRADE_SIM;

        const paramErg = document.getElementById("trainingParamErg");
        const paramResistance = document.getElementById("trainingParamResistance");
        const paramGrade = document.getElementById("trainingParamGrade");
        const customTargetActive = state.workout?.runtime?.customWorkoutTargetEnabled === true;
        if (paramErg) paramErg.hidden = !isErg || customTargetActive;
        if (paramResistance) paramResistance.hidden = !isResistance;
        if (paramGrade) paramGrade.hidden = !isGradeSim;

        // Sync slider values from state
        const settings = state.settings ?? {};
        const resistance = state.workout?.resistance ?? {};
        const gradeSim = state.workout?.gradeSimulation ?? {};

        if (elements.trainingErgPowerSlider) {
            elements.trainingErgPowerSlider.value = settings.power ?? 220;
            if (elements.trainingErgValue) elements.trainingErgValue.textContent = String(settings.power ?? 220);
        }
        if (elements.trainingResistanceSlider) {
            elements.trainingResistanceSlider.value = resistance.level ?? 35;
            if (elements.trainingResistanceValue) elements.trainingResistanceValue.textContent = String(resistance.level ?? 35);
        }
        if (elements.trainingDifficultySlider) {
            elements.trainingDifficultySlider.value = gradeSim.difficultyPercent ?? 100;
            if (elements.trainingDifficultyValue) elements.trainingDifficultyValue.textContent = String(gradeSim.difficultyPercent ?? 100);
        }
    }

    return {
        bindEvents,
        render
    };
}

function createVisualRenderSlot() {
    return {
        lastRenderedAt: 0,
        lastSignature: ""
    };
}

function shouldRenderVisual(slot, signature, now, intervalMs, force = false) {
    if (force || slot.lastRenderedAt === 0) {
        slot.lastRenderedAt = now;
        slot.lastSignature = signature;
        return true;
    }

    if (signature === slot.lastSignature) {
        return false;
    }

    if (now - slot.lastRenderedAt < intervalMs) {
        return false;
    }

    slot.lastRenderedAt = now;
    slot.lastSignature = signature;
    return true;
}

function buildRouteSignature(route) {
    if (!route) {
        return "no-route";
    }

    return [
        route.source ?? "unknown",
        route.name ?? "route",
        route.totalDistanceMeters ?? 0,
        route.points?.length ?? 0
    ].join(":");
}
