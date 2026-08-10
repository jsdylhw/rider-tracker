import { createRouteRenderer } from "../../src/ui/renderers/route-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

function createRenderer({ onImportGpx, onListSavedGpxRoutes, onLoadSavedGpxRoute, onContinueSavedGpxRoute } = {}) {
    const gpxFileInput = createFakeElement();
    const savedGpxRouteSelect = createFakeElement();
    const loadSavedGpxRouteBtn = createFakeElement();
    const continueSavedGpxRouteBtn = createFakeElement();
    const refreshSavedGpxRoutesBtn = createFakeElement();
    const deleteSavedGpxRouteBtn = createFakeElement();
    const savedGpxRouteStatus = createFakeElement();
    const renderer = createRouteRenderer({
        elements: {
            gpxFileInput,
            savedGpxRouteSelect,
            loadSavedGpxRouteBtn,
            continueSavedGpxRouteBtn,
            refreshSavedGpxRoutesBtn,
            deleteSavedGpxRouteBtn,
            savedGpxRouteStatus
        },
        mapController: {
            syncRoute() {}
        },
        onAddSegment() {},
        onResetRoute() {},
        onImportGpx,
        onListSavedGpxRoutes,
        onLoadSavedGpxRoute,
        onContinueSavedGpxRoute,
        onUpdateRouteSegment() {},
        onRemoveRouteSegment() {}
    });
    return {
        renderer,
        gpxFileInput,
        savedGpxRouteSelect,
        loadSavedGpxRouteBtn,
        continueSavedGpxRouteBtn,
        savedGpxRouteStatus
    };
}

export const suite = {
    name: "route-renderer-import",
    tests: [
        {
            name: "点击文件选择器会清空 value，支持重复导入同一 GPX",
            run() {
                const { gpxFileInput } = createRenderer({
                    onImportGpx: async () => {}
                });

                gpxFileInput.value = "foo.gpx";
                gpxFileInput.dispatch("click");
                assertEqual(gpxFileInput.value, "");
            }
        },
        {
            name: "change 事件会调用 onImportGpx",
            async run() {
                let called = 0;
                const fakeFile = { name: "a.gpx" };
                const { gpxFileInput } = createRenderer({
                    onImportGpx: async () => { called += 1; }
                });

                gpxFileInput.dispatch("change", { target: { files: [fakeFile], value: "a.gpx" } });
                await Promise.resolve();
                assertEqual(called, 1);
            }
        },
        {
            name: "未选择文件时不会触发导入",
            async run() {
                let called = 0;
                const { gpxFileInput } = createRenderer({
                    onImportGpx: async () => { called += 1; }
                });

                gpxFileInput.dispatch("change", { target: { files: [], value: "" } });
                await Promise.resolve();
                assertEqual(called, 0);
            }
        },
        {
            name: "路线库会列出已保存 GPX 并加载选中的路线",
            async run() {
                let loadedId = "";
                let continuedId = "";
                const { renderer, savedGpxRouteSelect, loadSavedGpxRouteBtn, continueSavedGpxRouteBtn, savedGpxRouteStatus } = createRenderer({
                    onImportGpx: async () => {},
                    onListSavedGpxRoutes: async () => [{
                        id: "saved-1",
                        name: "Kyoto Climb",
                        totalDistanceMeters: 12345,
                        resumeDistanceMeters: 800
                    }],
                    onLoadSavedGpxRoute: async (id) => {
                        loadedId = id;
                        return { name: "Kyoto Climb" };
                    },
                    onContinueSavedGpxRoute: async (id) => {
                        continuedId = id;
                        return { name: "Kyoto Climb" };
                    }
                });

                renderer.render({
                    route: { source: "manual", segments: [], totalDistanceMeters: 0, totalElevationGainMeters: 0 },
                    liveRide: { isActive: false }
                });
                await Promise.resolve();
                await Promise.resolve();

                assert(savedGpxRouteSelect.innerHTML.includes("Kyoto Climb"), "saved GPX should appear in the select");
                savedGpxRouteSelect.value = "saved-1";
                loadSavedGpxRouteBtn.dispatch("click");
                await Promise.resolve();
                await Promise.resolve();
                assertEqual(loadedId, "saved-1");
                assertEqual(savedGpxRouteStatus.textContent, "已从起点加载：Kyoto Climb");
                assertEqual(continueSavedGpxRouteBtn.hidden, false);
                continueSavedGpxRouteBtn.dispatch("click");
                await Promise.resolve();
                await Promise.resolve();
                assertEqual(continuedId, "saved-1");
                assertEqual(savedGpxRouteStatus.textContent, "已从上次位置继续：Kyoto Climb");
            }
        }
    ]
};
