import { createRouteLibraryRenderer } from "../../src/ui/renderers/route-library-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "route-library-renderer",
    tests: [
        {
            name: "loads the route library only when its independent button opens",
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
                renderer.bindEvents();

                assertEqual(listCalls, 0);
                await renderer.toggleLibrary();
                assertEqual(listCalls, 1);
                assertEqual(elements.routeLibraryPanel.hidden, false);
                assertEqual(elements.routeLibraryToggleBtn.attributes["aria-expanded"], "true");
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
        }
    ]
};

function buildElements() {
    return {
        routeLibraryToggleBtn: createFakeElement(),
        routeLibraryPanel: createFakeElement({ hidden: true }),
        savedRouteLibraryStatus: createFakeElement(),
        savedRouteSelect: createFakeElement(),
        refreshSavedRoutesBtn: createFakeElement(),
        loadSavedRouteBtn: createFakeElement(),
        continueSavedRouteBtn: createFakeElement(),
        saveCurrentRouteBtn: createFakeElement(),
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
