import { createDashboardRenderer } from "../../src/ui/renderers/dashboard-renderer.js";
import { createStore } from "../../src/app/store/app-store.js";
import { assertEqual } from "../helpers/test-harness.js";
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
                    mapController: {
                        async enableStreetView() {},
                        syncRide() {}
                    }
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
                    mapController: {
                        async enableStreetView() {},
                        syncRide() {}
                    }
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
                    mapController: {
                        async enableStreetView() {},
                        syncRide() {}
                    }
                });
                renderer.bindEvents(store);
                elements.immersiveBackBtn.dispatch("click");
                assertEqual(elements.immersiveStreetViewBtn.textContent, "进入沉浸街景");
            }
        }
    ]
};

if (!originalDocument) {
    // keep polyfill for whole runner lifecycle
}
