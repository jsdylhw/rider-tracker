import {
    buildActivityDetailPageHtml,
    buildActivityDetailHtml,
    buildHeartRateZoneHtml,
    buildPowerZoneHtml,
    buildTimeSeriesChartSvg,
    downsamplePoints,
    summarizeHeartRateZones,
    summarizePowerZones
} from "../../src/ui/renderers/activity-detail-renderer.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "activity-detail-renderer",
    tests: [
        {
            name: "renders activity detail summary and charts",
            run() {
                const html = buildActivityDetailHtml(buildActivity());

                assert(html.includes("Activity Detail"), "detail header should render");
                assert(html.includes("Power Test Ride"), "activity name should render");
                assert(html.includes("功率"), "power chart section should render");
                assert(html.includes("心率"), "heart-rate chart section should render");
                assert(html.includes("速度"), "speed chart section should render");
                assert(html.includes("data-activity-series-chart"), "series charts should expose interaction anchors");
                assert(html.includes('data-y-key="speedKph"'), "speed chart should expose its y field");
                assert(html.includes('data-role="series-line"'), "detail charts should use ride-series chart rendering");
                assert(html.includes("时间 (分:秒)"), "series charts should label the x axis with units");
                assert(html.includes("速度 (km/h)"), "speed chart should label the y axis with units");
                assert(!html.includes("x 轴: 时间 / y 轴: 速度"), "series charts should not render redundant axis prose");
                assert(html.includes("路线平面图"), "route map section should render");
                assert(html.includes("data-activity-route-map"), "route map should expose an interaction anchor");
                assert(html.includes('data-role="route-map-line"'), "route map should render a base route line");
                assert(html.includes('fill="#f8fafc"'), "activity detail charts should use a light analysis plot background");
                assert(html.includes("功率区间"), "power zone section should render");
                assert(html.includes("心率区间"), "heart-rate zone section should render");
                assert(html.includes("27 kcal"), "energy summary should render kcal");
                assert(!html.includes("27 kcal / 27 kJ"), "energy summary should not duplicate kcal and kJ");
            }
        },
        {
            name: "renders standalone detail page upload actions without download action",
            run() {
                const html = buildActivityDetailPageHtml({
                    ...buildActivity(),
                    fitFilePath: "data/files/fit/activity-1.fit",
                    fitFileSizeBytes: 4096
                });

                assert(html.includes("上传 Strava"), "standalone detail should expose Strava upload");
                assert(html.includes("FIT 已保存"), "standalone detail should show archived FIT status");
                assert(!html.includes("导出 FIT"), "standalone detail should not expose browser FIT download");
            }
        },
        {
            name: "builds time series chart when enough points exist",
            run() {
                const svg = buildTimeSeriesChartSvg(buildActivity().rawSession.records, {
                    field: "power",
                    color: "var(--primary)",
                    label: "W"
                });

                assert(svg.includes("<polyline"), "chart should include a polyline");
                assert(svg.includes("W"), "chart should include axis label");
                assert(svg.includes('data-chart-tooltip="01:00 · 130 W"'), "chart should expose hover values");
            }
        },
        {
            name: "downsamples dense chart points while preserving endpoints",
            run() {
                const points = Array.from({ length: 1200 }, (_, index) => ({
                    x: index,
                    y: index * 2
                }));
                const sampled = downsamplePoints(points, 500);

                assertEqual(sampled.length, 500);
                assertEqual(sampled[0].x, 0);
                assertEqual(sampled.at(-1).x, 1199);
            }
        },
        {
            name: "summarizes power zones by elapsed duration",
            run() {
                const zones = summarizePowerZones(buildActivity().rawSession.records, 200);
                const endurance = zones.find((zone) => zone.key === "endurance");
                const tempo = zones.find((zone) => zone.key === "tempo");
                const threshold = zones.find((zone) => zone.key === "threshold");

                assertEqual(endurance.seconds, 60);
                assertEqual(tempo.seconds, 60);
                assertEqual(threshold.seconds, 60);
            }
        },
        {
            name: "summarizes heart-rate reserve zones by elapsed duration",
            run() {
                const zones = summarizeHeartRateZones(buildActivity().rawSession.records, {
                    restingHr: 60,
                    maxHr: 180
                });
                const easy = zones.find((zone) => zone.key === "easy");
                const aerobic = zones.find((zone) => zone.key === "aerobic");

                assertEqual(easy.seconds, 60);
                assertEqual(aerobic.seconds, 120);
            }
        },
        {
            name: "exposes zone html builders for reuse",
            run() {
                const records = buildActivity().rawSession.records;
                const powerHtml = buildPowerZoneHtml(records, 200);
                const heartRateHtml = buildHeartRateZoneHtml(records, {
                    restingHr: 60,
                    maxHr: 180
                });

                assert(powerHtml.includes("zone-list"), "power zone builder should return zone list markup");
                assert(heartRateHtml.includes("heart-rate-zone-track"), "heart-rate zone builder should use heart-rate track");
            }
        }
    ]
};

function buildActivity() {
    return {
        id: "activity-1",
        source: "rider-tracker",
        sportType: "VirtualRide",
        name: "Power Test Ride",
        startedAt: "2026-04-29T12:00:00.000Z",
        elapsedSeconds: 180,
        distanceKm: 3,
        ascentMeters: 50,
        averagePower: 180,
        normalizedPower: 190,
        averageHr: 145,
        estimatedTss: 12,
        rawSession: {
            settings: {
                ftp: 200,
                restingHr: 60,
                maxHr: 180
            },
            summary: {
                metrics: {
                    ride: {
                        elapsedSeconds: 180,
                        distanceKm: 3,
                        ascentMeters: 50
                    },
                    speed: {
                        averageKph: 36
                    },
                    power: {
                        averageWatts: 180,
                        normalizedPowerWatts: 190,
                        intensityFactor: 0.95
                    },
                    heartRate: {
                        averageBpm: 145
                    },
                    load: {
                        estimatedTss: 12
                    },
                    energy: {
                        estimatedCaloriesKcal: 27,
                        mechanicalWorkKj: 27,
                        method: "power"
                    }
                }
            },
            route: {
                totalDistanceMeters: 3000,
                points: [
                    { distanceMeters: 0, latitude: 31.1, longitude: 121.1 },
                    { distanceMeters: 1000, latitude: 31.105, longitude: 121.11 },
                    { distanceMeters: 2000, latitude: 31.108, longitude: 121.12 },
                    { distanceMeters: 3000, latitude: 31.11, longitude: 121.13 }
                ]
            },
            records: [
                { elapsedSeconds: 0, power: 100, heartRate: 120, speedKph: 0, distanceKm: 0, positionLat: 31.1, positionLong: 121.1 },
                { elapsedSeconds: 60, power: 130, heartRate: 135, speedKph: 28, distanceKm: 1, positionLat: 31.105, positionLong: 121.11 },
                { elapsedSeconds: 120, power: 160, heartRate: 145, speedKph: 32, distanceKm: 2, positionLat: 31.108, positionLong: 121.12 },
                { elapsedSeconds: 180, power: 190, heartRate: 155, speedKph: 30, distanceKm: 3, positionLat: 31.11, positionLong: 121.13 }
            ]
        }
    };
}
