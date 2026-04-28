import { buildPipElevationChartSvg } from "../../src/ui/pip/pip-elevation-chart.js";
import { assert } from "../helpers/test-harness.js";

function createRoute() {
    return {
        totalDistanceMeters: 3000,
        points: [
            { distanceMeters: 0, gradePercent: 0 },
            { distanceMeters: 1000, gradePercent: 5 },
            { distanceMeters: 2000, gradePercent: -3 },
            { distanceMeters: 3000, gradePercent: 11 }
        ]
    };
}

export const suite = {
    name: "pip-elevation-chart",
    tests: [
        {
            name: "无路线时渲染空状态",
            run() {
                const svg = buildPipElevationChartSvg(null, null);

                assert(svg.includes("暂无路线数据"));
            }
        },
        {
            name: "根据路线坡度渲染颜色分段",
            run() {
                const svg = buildPipElevationChartSvg(createRoute(), null);

                assert(svg.includes("#f97316"));
                assert(svg.includes("#38bdf8"));
                assert(svg.includes("#e11d48"));
            }
        },
        {
            name: "有当前位置时渲染进度遮罩和当前位置标记",
            run() {
                const svg = buildPipElevationChartSvg(createRoute(), { distanceKm: 1.5 });

                assert(svg.includes("rgba(0, 0, 0, 0.2)"));
                assert(svg.includes("stroke-dasharray=\"2 2\""));
                assert(svg.includes("<circle"));
            }
        }
    ]
};
