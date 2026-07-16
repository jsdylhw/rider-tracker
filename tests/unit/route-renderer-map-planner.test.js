import { createRouteRenderer } from "../../src/ui/renderers/route-renderer.js";
import { assertEqual } from "../helpers/test-harness.js";
import { createFakeElement } from "../helpers/fake-dom.js";

export const suite = {
    name: "route-renderer-map-planner",
    tests: [
        {
            name: "selects map route points and calls planner callback",
            run() {
                let plannerClickHandler = null;
                let planned = null;
                const plannerModes = [];
                const elements = {
                    routeModeGpxBtn: createFakeElement(),
                    routeModeManualBtn: createFakeElement(),
                    routeModeMapBtn: createFakeElement(),
                    gpxRoutePanel: createFakeElement(),
                    manualRoutePanel: createFakeElement(),
                    mapRoutePanel: createFakeElement(),
                    routeMapShell: createFakeElement({ hidden: true }),
                    routeTableShell: createFakeElement(),
                    clearMapRouteSelectionBtn: createFakeElement(),
                    planMapRouteBtn: createFakeElement(),
                    mapRouteGoogleApiKeyInput: createFakeElement({ value: "test-key" }),
                    mapRouteSelectionStatus: createFakeElement(),
                    mapRouteStartText: createFakeElement(),
                    mapRouteDestinationText: createFakeElement()
                };

                const renderer = createRouteRenderer({
                    elements,
                    mapController: {
                        setMapProvider() {},
                        syncRoute() {},
                        syncPlannerSelection() {},
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
                    onPlanMapRoute(plan) {
                        planned = plan;
                    },
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                renderer.render({ route: { source: "manual", points: [], segments: [] }, routeSegments: [] });

                assertEqual(elements.mapRoutePanel.hidden, false);
                assertEqual(elements.manualRoutePanel.hidden, true);
                assertEqual(elements.routeModeMapBtn.classList.contains("active"), true);
                plannerClickHandler({ mode: "select", point: { lat: 37.1, lng: -122.1 } });
                plannerClickHandler({ mode: "select", point: { lat: 37.2, lng: -122.2 } });
                elements.planMapRouteBtn.dispatch("click");

                assertEqual(elements.mapRoutePanel.hidden, false);
                assertEqual(elements.routeMapShell.hidden, false);
                assertEqual(elements.manualRoutePanel.hidden, true);
                assertEqual(elements.mapRouteStartText.textContent, "37.10000, -122.10000");
                assertEqual(elements.mapRouteDestinationText.textContent, "37.20000, -122.20000");
                assertEqual(planned.googleApiKey, "test-key");
                assertEqual(planned.start.lat, 37.1);
                assertEqual(planned.destination.lng, -122.2);
                assertEqual(plannerModes.includes("select"), true);
            }
        }
    ]
};
