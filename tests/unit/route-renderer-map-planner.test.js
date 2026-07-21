import { createRouteRenderer } from "../../src/ui/renderers/route-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "route-renderer-map-planner",
    tests: [
        {
            name: "selects map route points and calls planner callback",
            run() {
                let plannerClickHandler = null;
                let planned = null;
                let invalidationCount = 0;
                const plannerModes = [];
                const plannerSelections = [];
                const elements = {
                    routeModeGpxBtn: createFakeElement(),
                    routeModeManualBtn: createFakeElement(),
                    routeModeMapBtn: createFakeElement(),
                    gpxRoutePanel: createFakeElement(),
                    manualRoutePanel: createFakeElement(),
                    mapRoutePanel: createFakeElement(),
                    routeMapShell: createFakeElement({ hidden: true }),
                    setupElevationChartShell: createFakeElement({ hidden: true }),
                    routeCurrentSourceRow: createFakeElement({ hidden: true }),
                    routeTableShell: createFakeElement(),
                    clearMapRouteSelectionBtn: createFakeElement(),
                    planMapRouteBtn: createFakeElement(),
                    mapRouteSelectionStatus: createFakeElement(),
                    mapRouteStartText: createFakeElement(),
                    mapRouteDestinationText: createFakeElement(),
                    routeSummary: createFakeElement(),
                    routeSourceLabel: createFakeElement(),
                    addSegmentBtn: createFakeElement()
                };

                const renderer = createRouteRenderer({
                    elements,
                    mapController: {
                        syncRoute() {},
                        syncPlannerSelection(selection) { plannerSelections.push(selection ? { ...selection } : null); },
                        setPlannerMode(mode) {
                            plannerModes.push(mode);
                        },
                        setPlannerClickHandler(handler) {
                            plannerClickHandler = handler;
                        }
                    },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onInvalidateMapRoute() {
                        invalidationCount += 1;
                    },
                    onPlanMapRoute(plan) {
                        planned = plan;
                    },
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                assertEqual(plannerModes.at(-1), "select");

                renderer.render({ route: { source: "manual", points: [], segments: [] }, routeSegments: [] });

                assertEqual(elements.mapRoutePanel.hidden, false);
                assertEqual(elements.manualRoutePanel.hidden, true);
                assertEqual(elements.routeModeMapBtn.classList.contains("active"), true);
                assert(elements.routeSummary.innerHTML.includes("地图探索"), "地图模式不应展示默认手工路线摘要");
                assertEqual(elements.routeSourceLabel.textContent, "地图探索（待生成）");
                assertEqual(elements.setupElevationChartShell.hidden, true);
                plannerClickHandler({ mode: "select", point: { lat: 37.1, lng: -122.1 } });
                plannerClickHandler({ mode: "select", point: { lat: 37.2, lng: -122.2 } });
                elements.planMapRouteBtn.dispatch("click");

                assertEqual(elements.mapRoutePanel.hidden, false);
                assertEqual(elements.routeMapShell.hidden, false);
                assertEqual(elements.manualRoutePanel.hidden, true);
                assertEqual(elements.mapRouteStartText.textContent, "37.10000, -122.10000");
                assertEqual(elements.mapRouteDestinationText.textContent, "37.20000, -122.20000");
                assertEqual(planned.start.lat, 37.1);
                assertEqual(planned.destination.lng, -122.2);
                assertEqual(invalidationCount, 2);
                assertEqual(plannerModes.includes("select"), true);

                renderer.render({
                    route: {
                        source: "osm-exploration",
                        totalDistanceMeters: 1500,
                        totalElevationGainMeters: 0,
                        totalDescentMeters: 0,
                        hasElevationData: false,
                        points: [
                            { latitude: 37.1, longitude: -122.1 },
                            { latitude: 37.2, longitude: -122.2 }
                        ],
                        segments: []
                    },
                    routeSegments: []
                });
                const latestSelection = plannerSelections.at(-1);
                assertEqual(latestSelection, null);
                assertEqual(elements.setupElevationChartShell.hidden, false);
                assertEqual(elements.mapRouteSelectionStatus.textContent, "起步路线已生成，可开始骑行或重新选点");
                assertEqual(elements.planMapRouteBtn.hidden, true);
                assertEqual(elements.clearMapRouteSelectionBtn.textContent, "重新选点");

                elements.clearMapRouteSelectionBtn.dispatch("click");
                assertEqual(elements.mapRouteSelectionStatus.textContent, "点击地图选择起点");
                assertEqual(elements.planMapRouteBtn.hidden, false);
                assertEqual(elements.clearMapRouteSelectionBtn.textContent, "清空");
            }
        },
        {
            name: "keeps the shared map preview visible after importing a coordinate GPX route",
            run() {
                const elements = {
                    routeModeGpxBtn: createFakeElement(),
                    routeModeManualBtn: createFakeElement(),
                    routeModeMapBtn: createFakeElement(),
                    gpxRoutePanel: createFakeElement(),
                    manualRoutePanel: createFakeElement(),
                    mapRoutePanel: createFakeElement(),
                    routeMapShell: createFakeElement({ hidden: true }),
                    setupElevationChartShell: createFakeElement({ hidden: true }),
                    routeCurrentSourceRow: createFakeElement({ hidden: true }),
                    routeSummary: createFakeElement(),
                    routeSourceLabel: createFakeElement(),
                    addSegmentBtn: createFakeElement()
                };
                let syncedRoute = null;
                const renderer = createRouteRenderer({
                    elements,
                    mapController: {
                        syncRoute(route) { syncedRoute = route; },
                        syncPlannerSelection() {},
                        setPlannerMode() {},
                        setPlannerClickHandler() {},
                    },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });
                const route = {
                    source: "gpx",
                    name: "海岸线",
                    totalDistanceMeters: 1200,
                    totalElevationGainMeters: 0,
                    totalDescentMeters: 0,
                    hasElevationData: false,
                    points: [
                        { latitude: 31.2, longitude: 121.4, distanceMeters: 0 },
                        { latitude: 31.21, longitude: 121.41, distanceMeters: 1200 }
                    ],
                    segments: []
                };

                elements.routeModeGpxBtn.dispatch("click");
                renderer.render({
                    route: { source: "manual", points: [], segments: [] },
                    routeSegments: []
                });
                assertEqual(elements.setupElevationChartShell.hidden, true);
                renderer.render({ route, routeSegments: [] });

                assertEqual(elements.gpxRoutePanel.hidden, false);
                assertEqual(elements.mapRoutePanel.hidden, true);
                assertEqual(elements.routeMapShell.hidden, false);
                assertEqual(elements.setupElevationChartShell.hidden, false);
                assertEqual(syncedRoute, route);
            }
        },
        {
            name: "does not redraw map geometry when only exploration turn intent changes",
            run() {
                const elements = {
                    routeModeGpxBtn: createFakeElement(),
                    routeModeManualBtn: createFakeElement(),
                    routeModeMapBtn: createFakeElement(),
                    gpxRoutePanel: createFakeElement(),
                    manualRoutePanel: createFakeElement(),
                    mapRoutePanel: createFakeElement(),
                    routeMapShell: createFakeElement({ hidden: true }),
                    routeSummary: createFakeElement(),
                    routeSourceLabel: createFakeElement(),
                    addSegmentBtn: createFakeElement()
                };
                let mapRouteSyncCount = 0;
                const renderer = createRouteRenderer({
                    elements,
                    mapController: {
                        syncRoute() { mapRouteSyncCount += 1; },
                        syncPlannerSelection() {},
                        setPlannerMode() {},
                        setPlannerClickHandler() {},
                    },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });
                const route = {
                    source: "osm-exploration",
                    networkSource: "overpass",
                    totalDistanceMeters: 1400,
                    totalElevationGainMeters: 0,
                    totalDescentMeters: 0,
                    hasElevationData: false,
                    exploration: { pendingIntent: "straight" },
                    points: [
                        { latitude: 31.2, longitude: 121.4 },
                        { latitude: 31.21, longitude: 121.41 }
                    ],
                    segments: []
                };

                renderer.render({ route, routeSegments: [] });
                renderer.render({
                    route: {
                        ...route,
                        exploration: { pendingIntent: "left" }
                    },
                    routeSegments: []
                });

                assertEqual(mapRouteSyncCount, 1);
            }
        }
    ]
};
