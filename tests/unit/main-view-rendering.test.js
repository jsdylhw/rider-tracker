import { hasRouteGeometryChanged, shouldRenderDashboard } from "../../src/ui/renderers/main-view.js";
import { assertEqual } from "../helpers/test-harness.js";

function createState(settings) {
    return {
        liveRide: {},
        route: {},
        ble: {},
        workout: {},
        settings,
        uiMode: "live"
    };
}

export const suite = {
    name: "main-view-rendering",
    tests: [
        {
            name: "profile settings 更新会重新渲染 dashboard 指标",
            run() {
                const previousState = createState({ ftp: 250, mass: 75 });
                const state = createState({ ftp: 280, mass: 75 });

                assertEqual(shouldRenderDashboard(state, previousState), true);
            }
        },
        {
            name: "无 dashboard 依赖变化时跳过 dashboard 渲染",
            run() {
                const dependencies = {
                    liveRide: {},
                    route: {},
                    ble: {},
                    workout: {},
                    settings: { ftp: 250 },
                    uiMode: "live"
                };

                assertEqual(shouldRenderDashboard(dependencies, dependencies), false);
            }
        },
        {
            name: "海拔补全不应被当作路线几何切换",
            run() {
                const route = {
                    source: "osm-exploration",
                    points: [
                        { latitude: 31.1, longitude: 121.1, elevation: 12 },
                        { latitude: 31.2, longitude: 121.2, elevation: 18 }
                    ]
                };
                const elevationLoadingRoute = {
                    ...route,
                    isLoading: true
                };
                const elevatedRoute = {
                    ...route,
                    points: route.points.map((point, index) => ({ ...point, elevation: 100 + index * 20 })),
                    hasElevationData: true
                };
                const rerouted = {
                    ...route,
                    points: [
                        route.points[0],
                        { latitude: 31.25, longitude: 121.2, elevation: 18 }
                    ]
                };

                assertEqual(hasRouteGeometryChanged(route, elevationLoadingRoute), false);
                assertEqual(hasRouteGeometryChanged(route, elevatedRoute), false);
                assertEqual(hasRouteGeometryChanged(route, rerouted), true);
            }
        }
    ]
};
