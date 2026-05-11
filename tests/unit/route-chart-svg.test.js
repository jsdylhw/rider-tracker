import { buildGradeChartSvg, buildElevationProfileSvg } from "../../src/ui/renderers/svg/route-charts.js";
import { buildTrajectoryOverviewSvg } from "../../src/ui/renderers/svg/dashboard-charts.js";
import { buildRouteMapSvg, collectRouteMapPoints } from "../../src/ui/renderers/svg/route-map-chart.js";
import { assert } from "../helpers/test-harness.js";

function createRoute() {
    return {
        totalDistanceMeters: 10000,
        points: [
            { distanceMeters: 0, gradePercent: 1, elevationMeters: 32, latitude: 31.100, longitude: 121.100 },
            { distanceMeters: 2000, gradePercent: 4, elevationMeters: 76, latitude: 31.105, longitude: 121.112 },
            { distanceMeters: 4000, gradePercent: 7, elevationMeters: 148, latitude: 31.112, longitude: 121.128 },
            { distanceMeters: 6000, gradePercent: -2, elevationMeters: 122, latitude: 31.118, longitude: 121.145 },
            { distanceMeters: 8000, gradePercent: -5, elevationMeters: 84, latitude: 31.121, longitude: 121.156 },
            { distanceMeters: 10000, gradePercent: 3, elevationMeters: 130, latitude: 31.128, longitude: 121.168 }
        ]
    };
}

export const suite = {
    name: "route-chart-svg",
    tests: [
        {
            name: "坡度图在实时骑行时显示当前位置跟随视图",
            run() {
                const svg = buildGradeChartSvg(createRoute(), { distanceKm: 5 });
                assert(svg.includes("当前位置跟随"));
                assert(svg.includes("4.1 - 5.9 km"));
                assert(svg.includes(">7.5 km<"));
                assert(svg.includes(">距离<"));
                assert(svg.includes(">+2.5%<"));
            }
        },
        {
            name: "透明坡度图不渲染白色背景并保留当前位置坡度",
            run() {
                const svg = buildGradeChartSvg(createRoute(), { distanceKm: 5 }, { transparent: true });
                assert(!svg.includes('fill="#ffffff" stroke="rgba(148, 163, 184, 0.28)"'));
                assert(svg.includes(">+2.5%<"));
            }
        },
        {
            name: "距离海拔图在有当前位置时显示当前位置海拔标签",
            run() {
                const svg = buildElevationProfileSvg(createRoute(), { distanceKm: 5 });
                assert(svg.includes("距离 - 海拔"));
                assert(svg.includes(">135 m<"));
            }
        },
        {
            name: "路线总览图复用北向二维平面图",
            run() {
                const svg = buildTrajectoryOverviewSvg(createRoute(), {
                    distanceKm: 5,
                    positionLat: 31.115,
                    positionLong: 121.136
                });
                assert(svg.includes("路线平面图"));
                assert(svg.includes('data-role="route-map-line"'));
                assert(svg.includes('data-role="route-map-current"'));
                assert(!svg.includes("当前位置局部放大"));
                assert(!svg.includes("全程路线"));
                assert(svg.includes(">5.0 km<"));
            }
        },
        {
            name: "基础路线平面图优先使用路线轨迹点并显示当前位置",
            run() {
                const svg = buildRouteMapSvg({
                    route: createRoute(),
                    currentRecord: {
                        distanceKm: 5,
                        positionLat: 31.115,
                        positionLong: 121.136
                    }
                });

                assert(svg.includes("路线平面图"));
                assert(svg.includes('data-role="route-map-line"'));
                assert(svg.includes('data-role="route-map-current"'));
                assert(!svg.includes('data-role="route-map-shadow"'));
                assert(svg.includes(">5.0 km<"));
            }
        },
        {
            name: "基础路线平面图可以从活动记录位置生成兜底轨迹",
            run() {
                const records = [
                    { distanceKm: 0, positionLat: 31.1, positionLong: 121.1 },
                    { distanceKm: 0.5, positionLat: 31.102, positionLong: 121.104 },
                    { distanceKm: 1, positionLat: 31.104, positionLong: 121.11 }
                ];
                const points = collectRouteMapPoints({ records });
                const svg = buildRouteMapSvg({ records });

                assert(points.length === 3, "records should produce route map points");
                assert(svg.includes('data-role="route-map-line"'));
                assert(svg.includes(">1.0 km<"));
            }
        },
        {
            name: "基础路线平面图保持北向俯视方向",
            run() {
                const svg = buildRouteMapSvg({
                    route: {
                        totalDistanceMeters: 2000,
                        points: [
                            { distanceMeters: 0, latitude: 31, longitude: 121 },
                            { distanceMeters: 1000, latitude: 31.01, longitude: 121 },
                            { distanceMeters: 2000, latitude: 31.01, longitude: 121.01 }
                        ]
                    }
                });
                const polyline = svg.match(/data-role="route-map-line" points="([^"]+)"/)?.[1] ?? "";
                const [south, north, east] = polyline.split(" ").map((pair) => {
                    const [x, y] = pair.split(",").map(Number);
                    return { x, y };
                });

                assert(north.y < south.y, "higher latitude should render farther up");
                assert(east.x > north.x, "higher longitude should render farther right");
                assert(Math.abs(east.y - north.y) < 0.2, "same latitude should stay horizontally aligned");
            }
        }
    ]
};
