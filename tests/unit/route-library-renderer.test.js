import { createRouteLibraryRenderer } from "../../src/ui/renderers/route-library-renderer.js";
import { createRouteLibrarySourceController } from "../../src/ui/renderers/route-library-source-controller.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "route-library-renderer",
    tests: [
        {
            name: "loads the local route library once when its source is shown",
            async run() {
                const elements = buildElements();
                let listCalls = 0;
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => {
                        listCalls += 1;
                        return [savedRoute()];
                    }
                });
                assertEqual(listCalls, 0);
                await renderer.ensureLoaded();
                await renderer.ensureLoaded();
                assertEqual(listCalls, 1);
            }
        },
        {
            name: "switches between local Strava and GPX sources without changing the current route",
            run() {
                const elements = buildElements();
                let localCalls = 0;
                let stravaCalls = 0;
                const controller = createRouteLibrarySourceController({
                    elements,
                    onShowLocalRoutes: () => { localCalls += 1; },
                    onShowStravaRoutes: () => { stravaCalls += 1; }
                });
                controller.bindEvents();

                elements.routeLibraryStravaTabBtn.dispatch("click");
                assertEqual(controller.getSource(), "strava");
                assertEqual(elements.routeLibraryStravaPanel.hidden, false);
                assertEqual(elements.routeLibraryLocalPanel.hidden, true);
                assertEqual(stravaCalls, 1);

                elements.routeLibraryGpxTabBtn.dispatch("click");
                assertEqual(elements.routeLibraryGpxPanel.hidden, false);
                elements.routeLibraryLocalTabBtn.dispatch("click");
                assertEqual(localCalls, 1);
            }
        },
        {
            name: "replaces the restoring message after continuation succeeds",
            async run() {
                const elements = buildElements();
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => [savedRoute()],
                    onContinueSavedRoute: async () => ({ source: "gpx", savedRouteId: "route-1" })
                });

                await renderer.refresh();
                elements.savedRouteSelect.value = "route-1";
                const loaded = await renderer.loadSelected(true);

                assertEqual(loaded.savedRouteId, "route-1");
                assert(elements.savedRouteLibraryStatus.textContent.startsWith("已从 12.5 km 继续"));
                assertEqual(elements.continueSavedRouteBtn.disabled, false);
            }
        },
        {
            name: "changing the selected route keeps available load actions enabled",
            async run() {
                const elements = buildElements();
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => [savedRoute()]
                });
                renderer.bindEvents();
                await renderer.refresh();

                elements.savedRouteSelect.value = "route-1";
                elements.savedRouteSelect.dispatch("change");

                assertEqual(elements.loadSavedRouteBtn.disabled, false);
                assertEqual(elements.continueSavedRouteBtn.disabled, false);
            }
        },
        {
            name: "keeps the user's next selection after loading a route from the start",
            async run() {
                const elements = buildElements();
                const routes = [savedRoute(), {
                    ...savedRoute(), id: "route-2", name: "第二条路线", resumeDistanceMeters: 0
                }];
                const loadedIds = [];
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => routes,
                    onLoadSavedRoute: async (routeId) => {
                        loadedIds.push(routeId);
                        return { source: "gpx", savedRouteId: routeId };
                    }
                });
                renderer.bindEvents();
                renderer.render({ route: { source: "manual" }, liveRide: { isActive: false } });
                await renderer.refresh();

                elements.savedRouteSelect.value = "route-1";
                await renderer.loadSelected(false);
                elements.savedRouteSelect.value = "route-2";
                elements.savedRouteSelect.dispatch("change");
                await renderer.loadSelected(false);

                assertEqual(loadedIds.join(","), "route-1,route-2");
                assertEqual(elements.savedRouteSelect.value, "route-2");
                assertEqual(elements.loadSavedRouteBtn.disabled, false);
                assertEqual(elements.savedRouteLibraryStatus.textContent, "已从起点加载：第二条路线");
            }
        },
        {
            name: "re-enables route selection after the loading-state render completes",
            async run() {
                const elements = buildElements();
                let renderer;
                renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => [savedRoute()],
                    onLoadSavedRoute: async () => {
                        renderer.render({
                            route: { source: "gpx", isLoading: true },
                            liveRide: { isActive: false }
                        });
                        return { source: "gpx", savedRouteId: "route-1" };
                    }
                });
                renderer.bindEvents();
                renderer.render({ route: { source: "manual" }, liveRide: { isActive: false } });
                await renderer.refresh();

                await renderer.loadSelected(false);

                assertEqual(elements.savedRouteSelect.disabled, false);
                assertEqual(elements.refreshSavedRoutesBtn.disabled, false);
                assertEqual(elements.loadSavedRouteBtn.disabled, false);
            }
        },
        {
            name: "shows a terminal error instead of leaving a loading message",
            async run() {
                const elements = buildElements();
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onListSavedRoutes: async () => [savedRoute()],
                    onContinueSavedRoute: async () => { throw new Error("route unavailable"); }
                });

                await renderer.refresh();
                elements.savedRouteSelect.value = "route-1";
                assertEqual(await renderer.loadSelected(true), null);
                assertEqual(elements.savedRouteLibraryStatus.textContent, "路线加载失败：route unavailable");
            }
        },
        {
            name: "exports the current AI preview without requiring a saved route",
            run() {
                const elements = buildElements();
                let exportCalls = 0;
                const renderer = createRouteLibraryRenderer({
                    elements,
                    onExportCurrentRouteGpx: () => { exportCalls += 1; }
                });
                renderer.bindEvents();
                renderer.render({
                    route: {
                        source: "agent-planned",
                        isDraft: true,
                        totalDistanceMeters: 30000,
                        points: [
                            { latitude: 35, longitude: 139 },
                            { latitude: 35.1, longitude: 139.1 }
                        ]
                    },
                    liveRide: { isActive: false }
                });

                assertEqual(elements.exportCurrentRouteGpxBtn.disabled, false);
                elements.exportCurrentRouteGpxBtn.dispatch("click");
                assertEqual(exportCalls, 1);
            }
        },
        {
            name: "disables current GPX export while route geometry is loading",
            run() {
                const elements = buildElements();
                const renderer = createRouteLibraryRenderer({ elements });

                renderer.render({
                    route: {
                        isLoading: true,
                        totalDistanceMeters: 30000,
                        points: [
                            { latitude: 35, longitude: 139 },
                            { latitude: 35.1, longitude: 139.1 }
                        ]
                    },
                    liveRide: { isActive: false }
                });

                assertEqual(elements.exportCurrentRouteGpxBtn.disabled, true);
            }
        },
        {
            name: "reports missing export wiring instead of silently doing nothing",
            run() {
                const elements = buildElements();
                const renderer = createRouteLibraryRenderer({ elements });
                renderer.bindEvents();
                renderer.render({
                    route: {
                        totalDistanceMeters: 30000,
                        points: [
                            { latitude: 35, longitude: 139 },
                            { latitude: 35.1, longitude: 139.1 }
                        ]
                    },
                    liveRide: { isActive: false }
                });

                elements.exportCurrentRouteGpxBtn.dispatch("click");

                assertEqual(
                    elements.savedRouteLibraryStatus.textContent,
                    "GPX 导出失败：GPX 导出功能尚未初始化。"
                );
            }
        }
    ]
};

function buildElements() {
    return {
        routeLibraryLocalTabBtn: createFakeElement(),
        routeLibraryStravaTabBtn: createFakeElement(),
        routeLibraryGpxTabBtn: createFakeElement(),
        routeLibraryLocalPanel: createFakeElement(),
        routeLibraryStravaPanel: createFakeElement({ hidden: true }),
        routeLibraryGpxPanel: createFakeElement({ hidden: true }),
        savedRouteLibraryStatus: createFakeElement(),
        savedRouteSelect: createFakeElement(),
        refreshSavedRoutesBtn: createFakeElement(),
        loadSavedRouteBtn: createFakeElement(),
        continueSavedRouteBtn: createFakeElement(),
        saveCurrentRouteBtn: createFakeElement(),
        exportCurrentRouteGpxBtn: createFakeElement(),
        deleteSavedRouteBtn: createFakeElement()
    };
}

function savedRoute() {
    return {
        id: "route-1",
        name: "测试路线",
        totalDistanceMeters: 30000,
        resumeDistanceMeters: 12500
    };
}
