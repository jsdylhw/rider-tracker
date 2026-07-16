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
        streetViewTrajectorySvg: createFakeElement()
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
                    onEnableStreetView: async () => {}
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
                    onEnableStreetView: async () => {}
                });
                renderer.render(store.getState());
                assertEqual(elements.immersiveStreetViewBtn.hidden, true);
            }
        },
        {
            name: "街景调试模式允许未开始骑行时进入沉浸预览",
            run() {
                const elements = createElements();
                const state = createBaseState();
                const store = createStore(state);
                let syncedRecord = null;
                const streetViewRef = {
                    current: {
                        update(route, currentRecord) {
                            syncedRecord = currentRecord;
                        }
                    }
                };

                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: streetViewRef,
                    onEnableStreetView: async () => {},
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                assertEqual(elements.immersiveStreetViewBtn.hidden, false);

                elements.immersiveStreetViewBtn.dispatch("click");

                assertEqual(elements.rideDashboard.classList.contains("immersive-street-view"), true);
                assertEqual(syncedRecord?.segmentName, "街景调试起点");
                assertEqual(syncedRecord?.latitude, 31.1);
            }
        },
        {
            name: "沉浸街景只同步街景，不刷新隐藏地图",
            run() {
                const elements = createElements();
                const store = createStore(createBaseState());
                let mapSyncCount = 0;
                let streetViewSyncCount = 0;
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => true,
                        enableStreetView: async () => {},
                        syncMap() { mapSyncCount += 1; },
                        syncStreetView() { streetViewSyncCount += 1; }
                    },
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                const mapSyncCountBeforeImmersive = mapSyncCount;
                const streetViewSyncCountBeforeImmersive = streetViewSyncCount;

                elements.immersiveStreetViewBtn.dispatch("click");

                assertEqual(mapSyncCount, mapSyncCountBeforeImmersive);
                assert(streetViewSyncCount > streetViewSyncCountBeforeImmersive,
                    "immersive mode should continue to update Street View");
            }
        },
        {
            name: "街景调试模式加载街景后立即显示沉浸入口",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                const store = createStore(state);
                const streetViewRef = { current: null };
                const renderer = createDashboardRenderer({
                    elements,
                    mapController: { syncRide() {} },
                    streetViewControllerRef: streetViewRef,
                    onEnableStreetView: async () => {
                        streetViewRef.current = { update() {}, destroy() {} };
                    },
                    streetViewDebugEnabled: true
                });

                elements.streetViewApiKey.value = "test-key";
                renderer.bindEvents(store);
                elements.loadStreetViewBtn.dispatch("click");
                await Promise.resolve();

                assertEqual(elements.immersiveStreetViewBtn.hidden, false);
                assertEqual(elements.immersiveStreetViewBtn.textContent, "进入沉浸街景");
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
                    onEnableStreetView: async () => {}
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
        }
    ]
};

if (!originalDocument) {
    // keep polyfill for whole runner lifecycle
}
