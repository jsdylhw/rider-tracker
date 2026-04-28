import {
    buildRideSeriesChartSvg,
    collectSeriesPoints,
    getRideSeriesAxisFields
} from "../../src/ui/renderers/svg/ride-series-chart.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createRecords() {
    return [
        { elapsedSeconds: 0, distanceKm: 0, power: 120, heartRate: 118, cadence: 80, speedKph: 0, gradePercent: -1, ascentMeters: 0, routeProgress: 0 },
        { elapsedSeconds: 60, distanceKm: 0.6, power: 180, heartRate: 132, cadence: 86, speedKph: 28, gradePercent: 3, ascentMeters: 12, routeProgress: 0.2 },
        { elapsedSeconds: 120, distanceKm: 1.3, power: 240, heartRate: 148, cadence: 92, speedKph: 32, gradePercent: 7, ascentMeters: 38, routeProgress: 0.45 },
        { elapsedSeconds: 180, distanceKm: 2.1, power: 210, heartRate: 152, cadence: 88, speedKph: 30, gradePercent: -4, ascentMeters: 40, routeProgress: 0.7 }
    ];
}

export const suite = {
    name: "ride-series-chart",
    tests: [
        {
            name: "暴露时间距离 x 轴和骑行指标 y 轴字段",
            run() {
                const xFields = getRideSeriesAxisFields("x").map((field) => field.key);
                const yFields = getRideSeriesAxisFields("y").map((field) => field.key);

                assert(xFields.includes("elapsedSeconds"));
                assert(xFields.includes("distanceKm"));
                assert(yFields.includes("power"));
                assert(yFields.includes("heartRate"));
                assert(yFields.includes("cadence"));
                assert(yFields.includes("speedKph"));
                assert(yFields.includes("gradePercent"));
                assert(yFields.includes("ascentMeters"));
                assert(yFields.includes("routeProgress"));
            }
        },
        {
            name: "按 x 轴排序并过滤缺失的 x/y 数据",
            run() {
                const xField = getRideSeriesAxisFields("x").find((field) => field.key === "elapsedSeconds");
                const yField = getRideSeriesAxisFields("y").find((field) => field.key === "power");
                const points = collectSeriesPoints([
                    { elapsedSeconds: 30, power: 150 },
                    { elapsedSeconds: 10, power: null },
                    { elapsedSeconds: 20, power: 130 },
                    { elapsedSeconds: 5, power: 100 }
                ], xField, yField);

                assertEqual(points.length, 3);
                assertEqual(points[0].xValue, 5);
                assertEqual(points[2].xValue, 30);
            }
        },
        {
            name: "可以渲染时间功率图并显示当前游标",
            run() {
                const svg = buildRideSeriesChartSvg({
                    records: createRecords(),
                    xKey: "elapsedSeconds",
                    yKey: "power",
                    currentRecord: { elapsedSeconds: 120, power: 240 }
                });

                assert(svg.includes("时间 - 功率"));
                assert(svg.includes("x 轴: 时间 / y 轴: 功率"));
                assert(svg.includes("data-role=\"series-line\""));
                assert(svg.includes("data-role=\"series-area\""));
                assert(svg.includes("data-role=\"current-cursor\""));
                assert(svg.includes(">240W<"));
                assert(svg.includes(">03:00<"));
            }
        },
        {
            name: "可以渲染距离坡度图并包含零线",
            run() {
                const svg = buildRideSeriesChartSvg({
                    records: createRecords(),
                    xKey: "distanceKm",
                    yKey: "gradePercent",
                    currentRecord: { distanceKm: 1.3, gradePercent: 7 }
                });

                assert(svg.includes("距离 - 坡度"));
                assert(svg.includes("x 轴: 距离 / y 轴: 坡度"));
                assert(svg.includes("data-role=\"zero-line\""));
                assert(svg.includes(">+7.0%<"));
                assert(svg.includes(">2.10 km<"));
            }
        },
        {
            name: "路线进度会从 0-1 值转换为百分比",
            run() {
                const svg = buildRideSeriesChartSvg({
                    records: createRecords(),
                    xKey: "elapsedSeconds",
                    yKey: "routeProgress"
                });

                assert(svg.includes("时间 - 路线进度"));
                assert(svg.includes(">70%<"));
                assert(svg.includes(">100%<"));
            }
        },
        {
            name: "数据不足或字段无效时返回空状态",
            run() {
                const notEnough = buildRideSeriesChartSvg({
                    records: [{ elapsedSeconds: 0, power: 120 }],
                    xKey: "elapsedSeconds",
                    yKey: "power"
                });
                const invalid = buildRideSeriesChartSvg({
                    records: createRecords(),
                    xKey: "unknown",
                    yKey: "power"
                });

                assert(notEnough.includes("暂无足够图表数据"));
                assert(invalid.includes("不支持的图表字段"));
            }
        }
    ]
};
