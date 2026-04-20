import { createRouteRenderer } from "../../src/ui/renderers/route-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

function createRenderer({ onImportGpx }) {
    const gpxFileInput = createFakeElement();
    const renderer = createRouteRenderer({
        elements: {
            gpxFileInput
        },
        mapController: {
            setMapProvider() {},
            syncRoute() {}
        },
        onAddSegment() {},
        onResetRoute() {},
        onImportGpx,
        onUpdateRouteSegment() {},
        onRemoveRouteSegment() {}
    });
    return { renderer, gpxFileInput };
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
        }
    ]
};
