import {
    buildDashboardViewModel,
    buildPipViewModel,
    selectRecentChartRecords
} from "../../src/app/view-models/live-ride-view-model.js";
import { DEFAULT_METRIC_SELECTION } from "../../src/shared/live-metrics.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "live-ride-view-model",
    tests: [
        {
            name: "数据面板暴露强度、路线和设备信号指标",
            run() {
                const timestamp = Date.now();
                const state = {
                    route: null,
                    settings: {
                        power: 220,
                        mass: 80,
                        ftp: 250,
                        restingHr: 58,
                        maxHr: 190
                    },
                    ble: {
                        heartRate: { value: 150, timestamp },
                        powerMeter: { power: 300, cadence: 90, sourceType: "external-power-meter", lastUpdated: timestamp },
                        sampling: {
                            heartRate: { value: 150, timestamp },
                            power: {
                                value: 300,
                                timestamp,
                                sourceType: "external-power-meter",
                                estimatedHz: 1.2,
                                jitterMs: 24,
                                isSignalStable: true,
                                intervalSampleCount: 8
                            },
                            cadence: { value: 90, timestamp, sourceType: "external-power-meter" },
                            lastUpdated: timestamp
                        }
                    },
                    liveRide: {
                        dashboardOpen: true,
                        isActive: true,
                        canStart: true,
                        statusMeta: "",
                        session: {
                            route: { totalDistanceMeters: 2000 }
                        },
                        records: [
                            { elapsedSeconds: 1, distanceKm: 0.01, speedKph: 20, power: 200, targetPowerWatts: 220, heartRate: 140, cadence: 85, gradePercent: 2, ascentMeters: 2, routeProgress: 0.1 },
                            { elapsedSeconds: 2, distanceKm: 0.03, speedKph: 30, power: 300, targetPowerWatts: 240, heartRate: 150, cadence: 90, gradePercent: 5, ascentMeters: 8, routeProgress: 0.3 }
                        ]
                    },
                    workout: {
                        mode: "grade-sim",
                        runtime: {
                            targetTrainerGradePercent: 5,
                            lookaheadGradePercent: 4,
                            customWorkoutTargetEnabled: true,
                            customWorkoutTargetActive: true,
                            customWorkoutTargetStepIndex: 0,
                            customWorkoutTargetStepLabel: "第 1 段 · 恒定",
                            customWorkoutTargetPowerWatts: 220,
                            customWorkoutTargetSteps: [{ durationMinutes: 8 }],
                            customWorkoutTargetRemainingSeconds: 420
                        }
                    },
                    pipChartConfig: {
                        elevation: true,
                        powerHeartRate: true,
                        powerTarget: true,
                        speedCadence: false,
                        powerZone: false
                    }
                };

                const viewModel = buildDashboardViewModel({
                    state,
                    customMetricsState: DEFAULT_METRIC_SELECTION
                });

                assertEqual(viewModel.metricsData.powerPerKg.value, "3.75");
                assertEqual(viewModel.metricsData.avgPowerPerKg.value, "3.13");
                assertEqual(viewModel.metricsData.powerZone.value, "Z6");
                assertEqual(viewModel.metricsData.hrZone.value, "Z3");
                assertEqual(viewModel.metricsData.routeProgress.value, 30);
                assertEqual(viewModel.metricsData.ascentMeters.value, 8);
                assertEqual(viewModel.metricsData.powerSource.value, "外置功率计");
                assertEqual(viewModel.metricsData.powerSignalStatus.value, "稳定");
                assertEqual(viewModel.metricsData.workoutTargetStep.value, "Ride at 220W");
                assertEqual(viewModel.metricsData.workoutTargetStep.unit, "01:00 / 剩 07:00");
                const pipViewModel = buildPipViewModel(state);
                assertEqual(pipViewModel.enabledChartKeys.includes("elevation"), true);
                assertEqual(pipViewModel.enabledChartKeys.includes("powerHeartRate"), true);
                assertEqual(pipViewModel.enabledChartKeys.includes("powerTarget"), true);
                assertEqual(pipViewModel.records.length, 2);
                assertEqual(pipViewModel.ftp, 250);
            }
        },
        {
            name: "街景调试模式允许未连接功率源时开始骑行",
            run() {
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } }
                };
                try {
                    const viewModel = buildDashboardViewModel({
                        state: {
                            route: {
                                totalDistanceMeters: 1000,
                                points: [],
                                segments: []
                            },
                            settings: { power: 220, mass: 75, ftp: 250 },
                            ble: {
                                heartRate: { value: null },
                                powerMeter: { power: null, cadence: null, sourceType: "none" },
                                sampling: {
                                    heartRate: { value: null, timestamp: null },
                                    power: { value: null, timestamp: null, sourceType: "none" },
                                    cadence: { value: null, timestamp: null, sourceType: "none" }
                                }
                            },
                            liveRide: {
                                dashboardOpen: true,
                                isActive: false,
                                canStart: false,
                                session: null,
                                records: []
                            },
                            workout: { mode: "grade-sim", runtime: {} }
                        },
                        customMetricsState: DEFAULT_METRIC_SELECTION
                    });

                    assertEqual(viewModel.ride.canStart, true);
                    assertEqual(viewModel.streetViewDebugEnabled, true);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "PiP 图表记录只保留最近窗口并限制点数",
            run() {
                const records = Array.from({ length: 1200 }, (_, index) => ({
                    elapsedSeconds: index,
                    power: index
                }));

                const selected = selectRecentChartRecords(records, {
                    windowSeconds: 300,
                    maxRecords: 200
                });

                assertEqual(selected.length, 200);
                assertEqual(selected[0].elapsedSeconds >= 899, true);
                assertEqual(selected.at(-1).elapsedSeconds, 1199);
            }
        },
        {
            name: "PiP 图表记录少于上限时仍按时间窗口裁剪",
            run() {
                const records = Array.from({ length: 500 }, (_, index) => ({
                    elapsedSeconds: index * 10,
                    power: index
                }));

                const selected = selectRecentChartRecords(records, {
                    windowSeconds: 300,
                    maxRecords: 600
                });

                assertEqual(selected.length < records.length, true);
                assertEqual(selected[0].elapsedSeconds >= 4690, true);
                assertEqual(selected.at(-1).elapsedSeconds, 4990);
            }
        }
    ]
};
