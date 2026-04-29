import {
    buildActivityDetailHtml,
    buildTimeSeriesChartSvg,
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
                assert(html.includes("功率 / 时间"), "power chart section should render");
                assert(html.includes("心率 / 时间"), "heart-rate chart section should render");
                assert(html.includes("功率区间"), "power zone section should render");
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
                ftp: 200
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
                    }
                }
            },
            records: [
                { elapsedSeconds: 0, power: 100, heartRate: 120 },
                { elapsedSeconds: 60, power: 130, heartRate: 135 },
                { elapsedSeconds: 120, power: 160, heartRate: 145 },
                { elapsedSeconds: 180, power: 190, heartRate: 155 }
            ]
        }
    };
}
