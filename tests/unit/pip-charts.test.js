import {
    buildDualSeriesChartSvg,
    buildPipChartsHtml,
    buildPowerZoneChartSvg
} from "../../src/ui/pip/pip-charts.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

const records = [
    { elapsedSeconds: 0, power: 100, heartRate: 120, speedKph: 20, cadence: 80 },
    { elapsedSeconds: 60, power: 150, heartRate: 135, speedKph: 24, cadence: 85 },
    { elapsedSeconds: 120, power: 230, heartRate: 150, speedKph: 28, cadence: 90 }
];

export const suite = {
    name: "pip-charts",
    tests: [
        {
            name: "渲染选中的 PiP 图表卡片",
            run() {
                const html = buildPipChartsHtml({
                    chartKeys: ["elevation", "powerHeartRate", "speedCadence", "powerZone"],
                    route: {
                        totalDistanceMeters: 1000,
                        points: [
                            { distanceMeters: 0, gradePercent: 0 },
                            { distanceMeters: 1000, gradePercent: 5 }
                        ]
                    },
                    currentRecord: { distanceKm: 0.4 },
                    records,
                    ftp: 200
                });

                assert(html.includes("坡度图"));
                assert(html.includes("功率 / 心率"));
                assert(html.includes("速度 / 踏频"));
                assert(html.includes("功率区间"));
            }
        },
        {
            name: "无图表选择时显示空状态",
            run() {
                const html = buildPipChartsHtml({ chartKeys: [] });

                assert(html.includes("请在 PiP 显示中选择图表。"));
            }
        },
        {
            name: "双轴时间图渲染两条曲线",
            run() {
                const svg = buildDualSeriesChartSvg(records, {
                    left: { field: "heartRate", label: "bpm", color: "#fb7185" },
                    right: { field: "power", label: "W", color: "#22c55e" }
                });

                assertEqual((svg.match(/<polyline/g) ?? []).length, 2);
                assert(svg.includes("bpm"));
                assert(svg.includes("W"));
            }
        },
        {
            name: "功率区间图按 FTP 渲染分段",
            run() {
                const svg = buildPowerZoneChartSvg(records, 200);

                assert(svg.includes("Z1"));
                assert(svg.includes("Z4"));
                assert(svg.includes("<rect"));
            }
        }
    ]
};
