import { buildGradeChartSvg, buildElevationProfileSvg, buildImmersiveElevationGradeSvg } from "../../src/ui/renderers/svg/route-charts.js";
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
            name: "沉浸街景底部图左侧显示海拔右侧显示附近坡度",
            run() {
                const svg = buildImmersiveElevationGradeSvg(createRoute(), { distanceKm: 5 });
                assert(svg.includes("距离 - 海拔"));
                assert(svg.includes("当前位置附近坡度"));
                assert(svg.includes(">135 m<"));
                assert(svg.includes(">+2.5%<"));
                assert(svg.includes("4.8 - 5.8 km"));
            }
        }
    ]
};
