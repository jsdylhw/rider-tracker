import { createRouteEditorService } from "../../src/app/services/route-editor-service.js";
import { createRouteDetailsRenderer } from "../../src/ui/renderers/route-details-renderer.js";
import { createStravaRouteImportRenderer } from "../../src/ui/renderers/strava-route-import-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

const GPX = `<?xml version="1.0"?><gpx><trk><name>上游名称</name><trkseg>
<trkpt lat="35" lon="139"><ele>10</ele></trkpt>
<trkpt lat="35.01" lon="139.01"><ele>30</ele></trkpt>
</trkseg></trk></gpx>`;

export const suite = {
    name: "strava-route-import",
    tests: [
        {
            name: "imports Strava GPX through the existing parser and saves source metadata",
            async run() {
                let state = { route: { source: "manual" }, statusText: "" };
                let savedInput = null;
                const operations = {
                    ensureRouteEditingAllowed: () => true,
                    beginRouteRequest: () => ({ requestId: 1 }),
                    isCurrent: () => true,
                    discardAfterRideStart: () => false,
                    commitRoute: (route, statusText) => { state = { ...state, route, statusText }; },
                    clearRouteLoading: (statusText) => { state = { ...state, statusText }; }
                };
                const service = createRouteEditorService({
                    store: { getState: () => state, setState: () => {} },
                    operations,
                    defaultRouteSegments: [],
                    invalidateExploration() {},
                    stravaRouteLibrary: {
                        listStravaRoutes: async () => [{ id: "123", name: "三都经典线" }],
                        loadStravaRouteGpx: async () => GPX
                    },
                    routeLibrary: {
                        saveRoute: async (input) => {
                            savedInput = input;
                            return { id: "saved-1", resumeDistanceMeters: 0 };
                        }
                    }
                });

                const route = await service.importStravaRoute({ routeId: "123", name: "三都经典线" });

                assertEqual(route.source, "strava");
                assertEqual(route.name, "三都经典线");
                assertEqual(route.hasElevationData, true);
                assertEqual(route.savedRouteId, "saved-1");
                assertEqual(savedInput.source, "strava");
                assertEqual(savedInput.metadata.stravaRouteId, "123");
            }
        },
        {
            name: "loads cached choices without refreshing Strava and refreshes only on request",
            async run() {
                const elements = {
                    refreshStravaRoutesBtn: createFakeElement(),
                    stravaRouteSelect: createFakeElement(),
                    importStravaRouteBtn: createFakeElement(),
                    stravaRouteImportStatus: createFakeElement()
                };
                let imported = null;
                let refreshCalls = 0;
                const renderer = createStravaRouteImportRenderer({
                    elements,
                    onListStravaRoutes: async () => ({
                        hasCache: false, routes: []
                    }),
                    onRefreshStravaRoutes: async () => {
                        refreshCalls += 1;
                        return { hasCache: true, cachedAt: "2026-09-03T08:00:00Z", routes: [{
                            id: "123", name: "三都经典线", distanceMeters: 51182,
                            elevationGainMeters: 423, estimatedMovingTimeSeconds: 9813
                        }] };
                    },
                    onImportStravaRoute: async (route) => { imported = route; return { source: "strava" }; }
                });
                renderer.bindEvents();
                renderer.render({ route: {}, liveRide: { isActive: false } });

                await renderer.ensureLoaded();
                assertEqual(elements.importStravaRouteBtn.disabled, true);
                await renderer.refreshLatest();
                assertEqual(refreshCalls, 1);
                assertEqual(elements.stravaRouteSelect.value, "123");
                assertEqual(elements.importStravaRouteBtn.disabled, false);
                await renderer.importSelected();
                assertEqual(imported.name, "三都经典线");
                assertEqual(elements.stravaRouteImportStatus.textContent.includes("已导入"), true);
            }
        },
        {
            name: "keeps imported Strava geometry read-only in manual route mode",
            run() {
                const route = {
                    source: "strava",
                    totalDistanceMeters: 10_000,
                    totalElevationGainMeters: 100,
                    totalDescentMeters: 90,
                    hasElevationData: true,
                    points: [
                        { latitude: 35, longitude: 139 },
                        { latitude: 35.01, longitude: 139.01 }
                    ],
                    segments: []
                };
                let state = { route, liveRide: { isActive: false } };
                let addCalls = 0;
                let commitCalls = 0;
                const elements = {
                    addSegmentBtn: createFakeElement(),
                    routeSummary: createFakeElement(),
                    routeSourceLabel: createFakeElement(),
                    routeTableShell: createFakeElement()
                };
                const renderer = createRouteDetailsRenderer({
                    elements,
                    hasRouteModeControls: true,
                    getInputMode: () => "manual",
                    onAddSegment: () => { addCalls += 1; },
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });
                renderer.bindEvents();
                renderer.render(state);

                assertEqual(elements.addSegmentBtn.disabled, true);
                elements.addSegmentBtn.dispatch("click");
                assertEqual(addCalls, 0);

                const service = createRouteEditorService({
                    store: { getState: () => state },
                    operations: {
                        ensureRouteEditingAllowed: () => true,
                        commitRoute: () => { commitCalls += 1; }
                    },
                    defaultRouteSegments: [],
                    invalidateExploration() {}
                });
                service.addSegment();

                assertEqual(commitCalls, 0);
                assertEqual(state.route, route);
            }
        }
    ]
};
