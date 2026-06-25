import { createDashboardRenderer } from "../../src/ui/renderers/dashboard-renderer.js";
import { createStore } from "../../src/app/store/app-store.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement, createFakeClassList } from "../helpers/fake-dom.js";

const originalDocument = globalThis.document;
if (!globalThis.document) {
    globalThis.document = {
        body: {
            appendChild() {},
            classList: createFakeClassList()
        },
        createElement() {
            return createFakeElement({ style: {} });
        },
        getElementById() {
            return null;
        }
    };
}

function createBaseState() {
    return {
        liveRide: {
            isActive: false,
            canStart: true,
            dashboardOpen: true,
            session: null
        },
        route: {
            totalDistanceMeters: 1000,
            name: "Test",
            points: [
                { latitude: 31.1, longitude: 121.1 },
                { latitude: 31.2, longitude: 121.2 }
            ]
        },
        workout: { runtime: { targetTrainerGradePercent: 0 } },
        ble: {
            powerMeter: { power: 0, cadence: 0 },
            heartRate: { value: 0 }
        }
    };
}

function createElements() {
    const trainingErgValue = createFakeElement();
    trainingErgValue.textContent = "220";
    const trainingResistanceValue = createFakeElement();
    trainingResistanceValue.textContent = "35";
    const trainingDifficultyValue = createFakeElement();
    trainingDifficultyValue.textContent = "100";

    const modeBtns = [
        createFakeElement({ dataset: { mode: "grade-sim" }, classList: createFakeClassList() }),
        createFakeElement({ dataset: { mode: "fixed-power" }, classList: createFakeClassList() }),
        createFakeElement({ dataset: { mode: "free-ride" }, classList: createFakeClassList() })
    ];
    const querySelectorAll = (sel) => {
        if (sel === ".training-mode-btn") return modeBtns;
        return [];
    };

    return {
        rideDashboard: { classList: createFakeClassList(), hidden: false },
        customizeMetricsBtn: createFakeElement(),
        metricsCustomizer: createFakeElement({ hidden: true, querySelectorAll: () => [] }),
        loadStreetViewBtn: createFakeElement(),
        streetViewApiKey: createFakeElement(),
        streetViewContainer: createFakeElement({ style: {} }),
        svPano1: createFakeElement(),
        svPano2: createFakeElement(),
        immersiveStreetViewBtn: createFakeElement({ hidden: true }),
        immersiveBackBtn: createFakeElement(),
        immersiveUiToggleBtn: createFakeElement(),
        stopRideDashboardBtn: createFakeElement(),
        startRideDashboardBtn: createFakeElement(),
        deviceControlsPanel: createFakeElement({ style: {} }),
        dashboardMetricsGrid: createFakeElement(),
        rideDashboardTitle: createFakeElement(),
        rideDashboardSubtitle: createFakeElement(),
        rideProgressHeadline: createFakeElement(),
        rideProgressBar: createFakeElement({ style: {} }),
        rideProgressDistance: createFakeElement(),
        rideProgressSegment: createFakeElement(),
        streetViewTrajectorySvg: createFakeElement(),
        toggleTrainingBtn: createFakeElement({ hidden: true }),
        trainingControlCard: (() => { const cl = createFakeClassList(); cl.add("collapsed"); return createFakeElement({ classList: cl, querySelectorAll, hidden: true }); })(),
        trainingControlToggle: createFakeElement(),
        trainingControlBody: createFakeElement(),
        trainingErgPowerSlider: createFakeElement(),
        trainingErgValue,
        trainingResistanceSlider: createFakeElement(),
        trainingResistanceValue,
        trainingDifficultySlider: createFakeElement(),
        trainingDifficultyValue
    };
}

export const suite = {
    name: "streetview-ui",
    tests: [
        {
            name: "API key 为空时点击加载街景会提示并中断",
            async run() {
                const elements = createElements();
                elements.streetViewApiKey.value = "";
                const store = createStore(createBaseState());
                let alertMessage = "";
                const prevAlert = globalThis.alert;
                globalThis.alert = (msg) => { alertMessage = msg; };

                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {},
                    onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {},
                    onUpdateGradeDifficulty() {}
                });

                renderer.bindEvents(store);
                elements.loadStreetViewBtn.dispatch("click");

                assertEqual(alertMessage, "请输入 Google Maps API Key");
                globalThis.alert = prevAlert;
            }
        },
        {
            name: "开始骑行前沉浸按钮保持隐藏",
            run() {
                const elements = createElements();
                const store = createStore(createBaseState());
                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {},
                    onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {},
                    onUpdateGradeDifficulty() {}
                });
                renderer.render(store.getState());
                assertEqual(elements.immersiveStreetViewBtn.hidden, true);
            }
        },
        {
            name: "点击沉浸返回按钮会退出沉浸模式",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.isActive = true;
                const store = createStore(state);

                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {},
                    onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {},
                    onUpdateGradeDifficulty() {}
                });
                renderer.bindEvents(store);
                elements.immersiveBackBtn.dispatch("click");
                assertEqual(elements.immersiveStreetViewBtn.textContent, "进入沉浸街景");
            }
        },
        {
            name: "沉浸模式左下角按钮可以隐藏和显示骑行 UI",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.isActive = true;
                const store = createStore(state);

                const streetViewRef = { current: null };
                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: streetViewRef,
                    onEnableStreetView: async () => {
                        streetViewRef.current = { update() {}, destroy() {} };
                    }
                });

                elements.streetViewApiKey.value = "test-key";
                renderer.bindEvents(store);
                elements.loadStreetViewBtn.dispatch("click");
                await Promise.resolve();
                renderer.render(store.getState());
                elements.immersiveStreetViewBtn.dispatch("click");

                elements.immersiveUiToggleBtn.dispatch("click");
                assertEqual(elements.rideDashboard.classList.contains("immersive-ui-hidden"), true);
                assertEqual(elements.immersiveUiToggleBtn.textContent, "显示 UI");

                elements.immersiveUiToggleBtn.dispatch("click");
                assertEqual(elements.rideDashboard.classList.contains("immersive-ui-hidden"), false);
                assertEqual(elements.immersiveUiToggleBtn.textContent, "隐藏 UI");
            }
        },
        {
            name: "训练控制卡片在非活跃骑行中隐藏",
            run() {
                const elements = createElements();
                const state = createBaseState();
                const store = createStore(state);
                const renderer = createDashboardRenderer({
                    elements, mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {}, onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {}, onUpdateGradeDifficulty() {}
                });
                renderer.render(store.getState());
                assertEqual(elements.trainingControlCard.hidden, true);
            }
        },
        {
            name: "训练控制卡片默认隐藏，按钮点击后显示",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.isActive = true;
                state.workout = { mode: "grade-sim", resistance: { level: 35 }, gradeSimulation: { difficultyPercent: 100 } };
                const store = createStore(state);
                const renderer = createDashboardRenderer({
                    elements, mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {}, onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {}, onUpdateGradeDifficulty() {}
                });
                renderer.render(store.getState());
                // Card hidden by default even during active ride
                assert(elements.trainingControlCard.hidden, "card should be hidden until toggled");
                assert(!elements.toggleTrainingBtn.hidden, "toggle button should be visible during ride");
            }
        },
        {
            name: "模式按钮点击触发 onUpdateWorkoutMode 回调",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.isActive = true;
                const store = createStore(state);
                let calledMode = null;
                const renderer = createDashboardRenderer({
                    elements, mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode(mode) { calledMode = mode; },
                    onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {},
                    onUpdateGradeDifficulty() {}
                });
                renderer.bindEvents(store);
                const ergBtn = elements.trainingControlCard.querySelectorAll(".training-mode-btn")[1];
                ergBtn.dispatch("click");
                assertEqual(calledMode, "fixed-power");
            }
        },
        {
            name: "训练控制卡片默认折叠，点击切换展开/折叠",
            run() {
                const elements = createElements();
                const state = createBaseState();
                const store = createStore(state);
                const renderer = createDashboardRenderer({
                    elements, mapController: { syncRide() {} },
                    streetViewControllerRef: { current: null },
                    onEnableStreetView: async () => {},
                    onUpdateWorkoutMode() {}, onUpdateErgTargetPower() {},
                    onUpdateResistanceLevel() {}, onUpdateGradeDifficulty() {}
                });
                renderer.bindEvents(store);
                // Show card via toggle button first
                elements.toggleTrainingBtn.dispatch("click");
                assert(!elements.trainingControlCard.hidden, "should show card after toggle button click");

                assert(elements.trainingControlCard.classList.contains("collapsed") === true, "should start collapsed");
                elements.trainingControlToggle.dispatch("click");
                assert(elements.trainingControlCard.classList.contains("collapsed") === false, "should expand on click");
                elements.trainingControlToggle.dispatch("click");
                assert(elements.trainingControlCard.classList.contains("collapsed") === true, "should collapse again");
            }
        }
    ]
};

if (!originalDocument) {
    // keep polyfill for whole runner lifecycle
}
