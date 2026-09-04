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
        }
    ]
};
