import { createRouteRenderer } from "../../src/ui/renderers/route-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";
import { createFakeElement, createFakeClassList } from "../helpers/fake-dom.js";

function makeRoute() {
    return {
        source: "gpx",
        name: "test-route",
        totalDistanceMeters: 10000,
        points: [
            { latitude: 31.0, longitude: 121.0, distanceMeters: 0, gradePercent: 0, elevationMeters: 0 },
            { latitude: 31.1, longitude: 121.1, distanceMeters: 5000, gradePercent: 5, elevationMeters: 100 },
            { latitude: 31.2, longitude: 121.2, distanceMeters: 10000, gradePercent: -2, elevationMeters: 50 }
        ]
    };
}

function makeElements(immersiveMode = false) {
    const rideDashboard = createFakeElement();
    if (immersiveMode) {
        rideDashboard.classList.add("immersive-street-view");
    }

    return {
        rideDashboard,
        rideDashboardElevationChart: createFakeElement(),
        elevationChart: createFakeElement()
    };
}

export const suite = {
    name: "route-renderer-immersive-guard",
    tests: [
        {
            name: "非沉浸模式时 renderElevationChart 写入 rideDashboardElevationChart",
            run() {
                const elements = makeElements(false);
                const route = makeRoute();
                const renderer = createRouteRenderer({
                    elements,
                    mapController: { syncRoute() {} },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                elements.rideDashboardElevationChart.innerHTML = "";
                renderer.renderElevationChart(route, null);

                assert(elements.rideDashboardElevationChart.innerHTML.length > 0,
                    "should write chart content when not immersive");
            }
        },
        {
            name: "沉浸模式时 renderElevationChart 不写入 rideDashboardElevationChart",
            run() {
                const elements = makeElements(true);
                const route = makeRoute();
                const renderer = createRouteRenderer({
                    elements,
                    mapController: { syncRoute() {} },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                elements.rideDashboardElevationChart.innerHTML = "";
                renderer.renderElevationChart(route, null);

                assertEqual(elements.rideDashboardElevationChart.innerHTML, "",
                    "should NOT write chart content when immersive");
            }
        },
        {
            name: "沉浸模式时空路线不写 rideDashboardElevationChart",
            run() {
                const elements = makeElements(true);
                const renderer = createRouteRenderer({
                    elements,
                    mapController: { syncRoute() {} },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                elements.rideDashboardElevationChart.innerHTML = "existing";
                renderer.renderElevationChart(null, null);

                assertEqual(elements.rideDashboardElevationChart.innerHTML, "existing",
                    "should preserve existing content when immersive and no route");
            }
        },
        {
            name: "沉浸模式时无海拔数据的 GPX 也不写入",
            run() {
                const elements = makeElements(true);
                const noElevRoute = { source: "gpx", name: "flat", points: [{ latitude: 0, longitude: 0 }], hasElevationData: false };
                const renderer = createRouteRenderer({
                    elements,
                    mapController: { syncRoute() {} },
                    onAddSegment() {},
                    onResetRoute() {},
                    onImportGpx() {},
                    onUpdateRouteSegment() {},
                    onRemoveRouteSegment() {}
                });

                elements.rideDashboardElevationChart.innerHTML = "keep";
                renderer.renderElevationChart(noElevRoute, null);

                assertEqual(elements.rideDashboardElevationChart.innerHTML, "keep",
                    "should preserve content when immersive and no elevation data");
            }
        }
    ]
};
