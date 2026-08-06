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
                { latitude: 31.1, longitude: 121.1, distanceMeters: 0, gradePercent: 0 },
                { latitude: 31.2, longitude: 121.2, distanceMeters: 1000, gradePercent: 0 }
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
        streetViewContainer: createFakeElement({ style: {} }),
        svPano1: createFakeElement(),
        svPano2: createFakeElement(),
        immersiveStreetViewBtn: createFakeElement({ hidden: true }),
        loadStreetViewBtn: createFakeElement({ hidden: true }),
        downloadStreetViewTraceBtn: createFakeElement({ hidden: true }),
        requestRouteElevationBtn: createFakeElement({ hidden: true }),
        explorationTurnControls: createFakeElement({ hidden: true }),
        explorationTurnStatus: createFakeElement(),
        explorationTurnLeftBtn: createFakeElement(),
        explorationTurnStraightBtn: createFakeElement(),
        explorationTurnRightBtn: createFakeElement(),
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
        rideDashboardMap: createFakeElement()
    };
}

function createConfiguredStreetViewVisuals() {
    let loaded = false;
    return {
        hasStreetView: () => loaded,
        getGoogleMapsConfig: () => ({ apiKey: "test-key" }),
        async enableConfiguredStreetView() {
            loaded = true;
            return { enabled: true };
        },
        syncMap() {},
        syncStreetView() {}
    };
}

function waitForUiAction() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export const suite = {
    name: "streetview-ui",
    tests: [
        {
            name: "未配置 Google Key 时街景仅等待用户点击",
            async run() {
                const elements = createElements();
                const store = createStore(createBaseState());
                let loadCount = 0;

                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        getGoogleMapsConfig: () => ({ apiKey: "" }),
                        async enableConfiguredStreetView() { loadCount += 1; },
                        syncMap() {},
                        syncStreetView() {}
                    }
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                await Promise.resolve();

                assertEqual(loadCount, 0);
                assertEqual(elements.immersiveStreetViewBtn.hidden, true);
                assertEqual(elements.loadStreetViewBtn.hidden, true);
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
                let syncedTarget = null;
                const streetViewRef = {
                    current: {
                        update(target) {
                            syncedTarget = target;
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
                assertEqual(syncedTarget?.latitude, 31.1);
                assertEqual(syncedTarget?.longitude, 121.1);
            }
        },
        {
            name: "沉浸街景低频同步右下角路线小地图",
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

                assert(mapSyncCount > mapSyncCountBeforeImmersive,
                    "immersive mode should refresh the visible route mini map");
                assert(streetViewSyncCount > streetViewSyncCountBeforeImmersive,
                    "immersive mode should continue to update Street View");
            }
        },
        {
            name: "沉浸切换后会刷新街景主视图尺寸",
            async run() {
                const elements = createElements();
                const store = createStore(createBaseState());
                let streetViewResizeCount = 0;
                let dashboardMapResizeCount = 0;
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => true,
                        syncMap() {},
                        syncStreetView() {},
                        invalidateStreetViewSize() { streetViewResizeCount += 1; },
                        invalidateDashboardSize() { dashboardMapResizeCount += 1; }
                    },
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                elements.immersiveStreetViewBtn.dispatch("click");
                await Promise.resolve();

                assertEqual(streetViewResizeCount, 1);
                assertEqual(dashboardMapResizeCount, 1);
                const dashboardMapResizeBeforeExit = dashboardMapResizeCount;
                elements.immersiveBackBtn.dispatch("click");
                await Promise.resolve();
                assertEqual(streetViewResizeCount, 2);
                assertEqual(dashboardMapResizeCount, dashboardMapResizeBeforeExit + 1);
            }
        },
        {
            name: "手工路线进入沉浸街景时不显示路线小地图",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.route.source = "manual";
                const store = createStore(state);
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => true,
                        enableStreetView: async () => {},
                        syncMap() {},
                        syncStreetView() {}
                    },
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                elements.immersiveStreetViewBtn.dispatch("click");

                assertEqual(elements.rideDashboardMap.hidden, true);
            }
        },
        {
            name: "点击加载街景后初始化街景并显示沉浸入口",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                const store = createStore(state);
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: createConfiguredStreetViewVisuals(),
                    requestGoogleMapsApiKey: async () => "test-key",
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                assertEqual(elements.loadStreetViewBtn.hidden, false);
                elements.loadStreetViewBtn.dispatch("click");
                await waitForUiAction();

                assertEqual(elements.immersiveStreetViewBtn.hidden, false);
                assertEqual(elements.immersiveStreetViewBtn.textContent, "进入沉浸街景");
                assertEqual(elements.downloadStreetViewTraceBtn.hidden, false);
            }
        },
        {
            name: "街景调试模式会将无效 Key 的加载失败呈现为黑屏预览",
            async run() {
                const elements = createElements();
                const store = createStore(createBaseState());
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        getGoogleMapsConfig: () => ({ apiKey: "aa" }),
                        async enableConfiguredStreetView() {
                            throw new Error("API Key 验证失败");
                        },
                        syncMap() {},
                        syncStreetView() {}
                    },
                    requestGoogleMapsApiKey: async () => "aa",
                    streetViewDebugEnabled: true
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                elements.loadStreetViewBtn.dispatch("click");
                await waitForUiAction();

                assertEqual(elements.streetViewContainer.style.display, "block");
                assertEqual(elements.streetViewContainer.classList.contains("streetview-debug-empty"), true);
                assertEqual(elements.svPano1.style.display, "none");
                assertEqual(elements.rideDashboard.classList.contains("immersive-street-view"), true);
                assertEqual(elements.immersiveStreetViewBtn.hidden, false);
            }
        },
        {
            name: "街景与海拔请求都从骑行界面按需触发",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                state.route.source = "osm-exploration";
                state.liveRide.isActive = true;
                const store = createStore(state);
                let requestedKeyFor = "";
                let elevationRequests = 0;
                const visuals = createConfiguredStreetViewVisuals();
                visuals.getGoogleMapsConfig = () => ({ apiKey: "" });
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: visuals,
                    requestGoogleMapsApiKey: async ({ featureLabel }) => {
                        requestedKeyFor = featureLabel;
                        return "test-key";
                    },
                    onRequestRouteElevation: async () => { elevationRequests += 1; }
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                assertEqual(elements.loadStreetViewBtn.hidden, false);
                assertEqual(elements.requestRouteElevationBtn.hidden, false);
                assertEqual(elements.requestRouteElevationBtn.disabled, true);
                assertEqual(elements.requestRouteElevationBtn.textContent, "骑行中不可请求海拔");

                state.liveRide.isActive = false;
                store.setState(() => state);
                renderer.render(store.getState());
                elements.requestRouteElevationBtn.dispatch("click");
                await waitForUiAction();

                assertEqual(elevationRequests, 1);
                assertEqual(requestedKeyFor, "请求路线海拔");
            }
        },
        {
            name: "已加载海拔的探索路线伝达明确状态而不隐藏按钮",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.route.source = "osm-exploration";
                state.route.hasElevationData = true;
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        syncMap() {},
                        syncStreetView() {}
                    }
                });

                renderer.render(state);

                assertEqual(elements.requestRouteElevationBtn.hidden, false);
                assertEqual(elements.requestRouteElevationBtn.disabled, true);
                assertEqual(elements.requestRouteElevationBtn.textContent, "探索路线海拔已加载");
            }
        },
        {
            name: "路线处理中不会允许请求探索海拔",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                state.route.source = "osm-exploration";
                state.route.isLoading = true;
                let requestedKeyCount = 0;
                let elevationRequests = 0;
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        syncMap() {},
                        syncStreetView() {}
                    },
                    requestGoogleMapsApiKey: async () => {
                        requestedKeyCount += 1;
                        return "test-key";
                    },
                    onRequestRouteElevation: async () => { elevationRequests += 1; }
                });

                renderer.render(state);
                elements.requestRouteElevationBtn.dispatch("click");
                await waitForUiAction();

                assertEqual(elements.requestRouteElevationBtn.disabled, true);
                assertEqual(elements.requestRouteElevationBtn.textContent, "路线处理中");
                assertEqual(requestedKeyCount, 0);
                assertEqual(elevationRequests, 0);
            }
        },
        {
            name: "其他带坐标路线默认不显示海拔请求入口",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.route.source = "gpx";
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        syncMap() {},
                        syncStreetView() {}
                    }
                });

                renderer.render(state);

                assertEqual(elements.requestRouteElevationBtn.hidden, true);
            }
        },
        {
            name: "探索骑行显示下一路口方向并把按钮输入交给路线服务",
            run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.isActive = true;
                state.route = {
                    ...state.route,
                    source: "osm-exploration",
                    exploration: { pendingIntent: "right" }
                };
                const store = createStore(state);
                const intents = [];
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        syncMap() {},
                        syncStreetView() {}
                    },
                    onQueueExplorationTurn: (intent) => intents.push(intent)
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                elements.explorationTurnLeftBtn.dispatch("click");

                assertEqual(elements.explorationTurnControls.hidden, false);
                assertEqual(elements.explorationTurnStatus.textContent, "下一路口：右拐");
                assertEqual(elements.explorationTurnRightBtn.attributes["aria-pressed"], "true");
                assertEqual(intents[0], "left");
            }
        },
        {
            name: "打开骑行页面后会刷新隐藏期间创建的路线地图",
            async run() {
                const elements = createElements();
                const state = createBaseState();
                state.liveRide.dashboardOpen = false;
                let dashboardMapRefreshCount = 0;
                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: {
                        hasStreetView: () => false,
                        syncMap() {},
                        syncStreetView() {},
                        invalidateDashboardSize() { dashboardMapRefreshCount += 1; }
                    }
                });

                renderer.render(state);
                renderer.render({
                    ...state,
                    liveRide: { ...state.liveRide, dashboardOpen: true }
                });
                await Promise.resolve();

                assertEqual(dashboardMapRefreshCount, 1);
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

                const renderer = createDashboardRenderer({
                    elements,
                    rideVisuals: createConfiguredStreetViewVisuals()
                });

                renderer.bindEvents(store);
                renderer.render(store.getState());
                elements.loadStreetViewBtn.dispatch("click");
                await waitForUiAction();
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
