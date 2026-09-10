import { createRouteEditorService } from "../../src/app/services/route-editor-service.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-current-gpx-export",
    tests: [
        {
            name: "downloads the current transient route without saving it",
            run() {
                const route = {
                    source: "agent-planned",
                    name: "AI 预览路线",
                    isDraft: true,
                    totalDistanceMeters: 30000,
                    points: [
                        { latitude: 35, longitude: 139 },
                        { latitude: 35.1, longitude: 139.1 }
                    ]
                };
                let state = { route, statusText: "" };
                let downloadedRoute = null;
                let saveCalls = 0;
                const service = createRouteEditorService({
                    store: {
                        getState: () => state,
                        setState: (updater) => { state = updater(state); }
                    },
                    operations: {},
                    defaultRouteSegments: [],
                    invalidateExploration: () => {},
                    routeLibrary: {
                        saveRoute: () => { saveCalls += 1; }
                    },
                    downloadRouteGpx: (value) => {
                        downloadedRoute = value;
                        return { fileName: "AI 预览路线.gpx", sizeBytes: 512 };
                    }
                });

                const result = service.exportCurrentRouteGpx();

                assertEqual(downloadedRoute, route);
                assertEqual(result.fileName, "AI 预览路线.gpx");
                assertEqual(saveCalls, 0);
                assertEqual(state.route, route);
                assertEqual(state.statusText, "已导出“AI 预览路线.gpx”，可在 Strava 路线页面中导入。");
            }
        },
        {
            name: "saves an eligible unsaved route before riding and returns its durable identity",
            async run() {
                const route = {
                    source: "map-drawn",
                    name: "地图选点路线",
                    totalDistanceMeters: 1000,
                    points: [
                        { latitude: 31.1, longitude: 121.1 },
                        { latitude: 31.2, longitude: 121.2 }
                    ]
                };
                let savedInput = null;
                const service = createRouteEditorService({
                    store: { getState: () => ({ route }) },
                    operations: {},
                    defaultRouteSegments: [],
                    routeLibrary: {
                        saveRoute: async (input) => {
                            savedInput = input;
                            return { id: "saved-map", resumeDistanceMeters: 0, progressStatus: null };
                        }
                    }
                });

                const result = await service.ensureRouteSavedForRide(route);

                assertEqual(savedInput.source, "map-drawn");
                assertEqual(result.saved, true);
                assertEqual(result.route.savedRouteId, "saved-map");
            }
        },
        {
            name: "does not auto-save exploration routes or track their progress",
            async run() {
                const route = {
                    source: "osm-exploration",
                    name: "地图探索",
                    savedRouteId: "unexpected-id",
                    totalDistanceMeters: 1000,
                    points: [
                        { latitude: 31.1, longitude: 121.1 },
                        { latitude: 31.2, longitude: 121.2 }
                    ]
                };
                let saveCalls = 0;
                let progressCalls = 0;
                const service = createRouteEditorService({
                    store: { getState: () => ({ route }) },
                    operations: {},
                    defaultRouteSegments: [],
                    routeLibrary: {
                        saveRoute: async () => { saveCalls += 1; },
                        saveRouteProgress: async () => { progressCalls += 1; }
                    }
                });

                const result = await service.ensureRouteSavedForRide(route);
                await service.updateSavedRouteProgress({ route, sessionDistanceMeters: 500 });

                assertEqual(result.saved, false);
                assertEqual(saveCalls, 0);
                assertEqual(progressCalls, 0);
            }
        },
        {
            name: "writes paused or completed progress instead of deleting completion",
            async run() {
                const route = {
                    source: "gpx",
                    savedRouteId: "saved-gpx",
                    totalDistanceMeters: 1000,
                    points: [
                        { latitude: 31.1, longitude: 121.1 },
                        { latitude: 31.2, longitude: 121.2 }
                    ]
                };
                const writes = [];
                const service = createRouteEditorService({
                    store: { getState: () => ({ route }) },
                    operations: {},
                    defaultRouteSegments: [],
                    routeLibrary: {
                        saveRouteProgress: async (_id, progress) => { writes.push(progress); }
                    }
                });

                await service.updateSavedRouteProgress({ route, sessionDistanceMeters: 400 });
                await service.updateSavedRouteProgress({ route, sessionDistanceMeters: 995 });

                assertEqual(writes[0].status, "paused");
                assertEqual(writes[0].resumeDistanceMeters, 400);
                assertEqual(writes[1].status, "completed");
                assertEqual(writes[1].resumeDistanceMeters, 995);
            }
        }
    ]
};
