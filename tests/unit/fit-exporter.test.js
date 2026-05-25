import { resolveFitExportSummary, downsampleTo1Hz } from "../../src/adapters/export/fit-exporter.js";
import { assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "fit-exporter",
    tests: [
        {
            name: "resolveFitExportSummary prefers summary.metrics values",
            run() {
                const exportSummary = resolveFitExportSummary({
                    summary: {
                        elapsedSeconds: 1,
                        distanceKm: 0.01,
                        averageSpeedKph: 10,
                        maxSpeedKph: 11,
                        averageHeartRate: 100,
                        maxHeartRate: 110,
                        averagePower: 120,
                        maxPower: 150,
                        ascentMeters: 5,
                        metrics: {
                            ride: {
                                elapsedSeconds: 120,
                                distanceKm: 1.2,
                                ascentMeters: 32
                            },
                            speed: {
                                averageKph: 36,
                                maxKph: 42
                            },
                            heartRate: {
                                averageBpm: 145,
                                maxBpm: 168
                            },
                            power: {
                                averageWatts: 210,
                                maxWatts: 330
                            },
                            grade: {
                                averagePercent: 2.4,
                                averagePositivePercent: 3.2,
                                averageNegativePercent: -1.5,
                                maxPositivePercent: 6,
                                maxNegativePercent: -4
                            }
                        }
                    },
                    records: [
                        {
                            elapsedSeconds: 120,
                            distanceKm: 1.2,
                            speedKph: 42,
                            heartRate: 168,
                            power: 330,
                            ascentMeters: 32
                        }
                    ]
                });

                assertEqual(exportSummary.elapsedSeconds, 120);
                assertEqual(exportSummary.distanceMeters, 1200);
                assertEqual(exportSummary.ascentMeters, 32);
                assertApprox(exportSummary.averageSpeedMps, 10, 0.0001);
                assertApprox(exportSummary.maxSpeedMps, 42 / 3.6, 0.0001);
                assertEqual(exportSummary.averageHeartRate, 145);
                assertEqual(exportSummary.maxHeartRate, 168);
                assertEqual(exportSummary.averagePower, 210);
                assertEqual(exportSummary.maxPower, 330);
                assertEqual(exportSummary.grade.averagePercent, 2.4);
                assertEqual(exportSummary.grade.averagePositivePercent, 3.2);
                assertEqual(exportSummary.grade.averageNegativePercent, -1.5);
                assertEqual(exportSummary.grade.maxPositivePercent, 6);
                assertEqual(exportSummary.grade.maxNegativePercent, -4);
            }
        },
        {
            name: "downsampleTo1Hz 空/单条记录时原样返回",
            run() {
                assertEqual(downsampleTo1Hz(null).length, 0);
                assertEqual(downsampleTo1Hz([]).length, 0);
                const single = [{ elapsedSeconds: 1, power: 100 }];
                assertEqual(downsampleTo1Hz(single).length, 1);
                assertEqual(downsampleTo1Hz(single)[0].power, 100);
            }
        },
        {
            name: "downsampleTo1Hz 密度 ≤1Hz 时不做降采样",
            run() {
                const records = [
                    { elapsedSeconds: 0, power: 100 },
                    { elapsedSeconds: 1, power: 110 },
                    { elapsedSeconds: 2, power: 120 }
                ];
                const result = downsampleTo1Hz(records);
                assertEqual(result.length, 3);
            }
        },
        {
            name: "downsampleTo1Hz 60s 10Hz → 约61条，每桶平均且无重复",
            run() {
                const records = [];
                const N = 600; // 60 seconds at 100ms = 601 records (0..60s)
                for (let i = 0; i <= N; i += 1) {
                    records.push({
                        elapsedSeconds: i * 0.1,
                        power: 100 + i * 2,
                        heartRate: 120 + i,
                        cadence: 80 + (i % 5),
                        speedKph: 30 + (i % 3) * 0.5,
                        gradePercent: 2,
                        distanceKm: i * 0.003,
                        elevationMeters: 100 + i * 0.2
                    });
                }
                const result = downsampleTo1Hz(records);

                // 60 秒 → 61 条左右（每整秒一条 + 最后一条）
                assertEqual(result.length >= 60, true);
                assertEqual(result.length <= 62, true);

                // 最后一条是原始末尾，且不重复
                assertEqual(result.at(-1).elapsedSeconds, 60);
                if (result.length >= 2) {
                    const secondToLast = result[result.length - 2].elapsedSeconds;
                    assertEqual(secondToLast < 60, true);
                }

                // timestamp 严格递增
                for (let i = 1; i < result.length; i += 1) {
                    assertEqual(result[i].elapsedSeconds > result[i - 1].elapsedSeconds, true);
                }
            }
        },
        {
            name: "downsampleTo1Hz 峰值功率由 SESSION/LAP 全量数据保留",
            run() {
                const records = [];
                const N = 600;
                for (let i = 0; i <= N; i += 1) {
                    const power = (i === 120) ? 999 : 200;
                    records.push({
                        elapsedSeconds: i * 0.1,
                        power,
                        heartRate: 140,
                        cadence: 85,
                        speedKph: 35,
                        gradePercent: 1,
                        distanceKm: i * 0.003,
                        elevationMeters: 100 + i * 0.2
                    });
                }

                const result = downsampleTo1Hz(records);
                assertEqual(result.length >= 60, true);

                // 降采样后的 record 里尖峰被平均掉了
                const has999 = result.some(r => r.power === 999);
                assertEqual(has999, false);

                // 但 SESSION/LAP 的 maxPower 来自全量 records
                const exportSummary = resolveFitExportSummary({
                    summary: {},
                    records
                });
                assertEqual(exportSummary.maxPower, 999);
            }
        },
        {
            name: "resolveFitExportSummary derives export data from records when metrics are absent",
            run() {
                const exportSummary = resolveFitExportSummary({
                    summary: {
                        elapsedSeconds: 90,
                        distanceKm: 0.9,
                        averageSpeedKph: 36,
                        averageHeartRate: 140,
                        averagePower: 200,
                        ascentMeters: 18,
                        averageGradePercent: 1.8,
                        averagePositiveGradePercent: 2.1,
                        averageNegativeGradePercent: -0.8,
                        maxPositiveGradePercent: 5,
                        maxNegativeGradePercent: -3
                    },
                    records: [
                        {
                            elapsedSeconds: 30,
                            distanceKm: 0.3,
                            speedKph: 32,
                            heartRate: 135,
                            power: 180,
                            ascentMeters: 6
                        },
                        {
                            elapsedSeconds: 90,
                            distanceKm: 0.9,
                            speedKph: 40,
                            heartRate: 155,
                            power: 260,
                            ascentMeters: 18
                        }
                    ]
                });

                assertEqual(exportSummary.elapsedSeconds, 90);
                assertEqual(exportSummary.distanceMeters, 900);
                assertEqual(exportSummary.ascentMeters, 18);
                assertApprox(exportSummary.averageSpeedMps, 10, 0.0001);
                assertApprox(exportSummary.maxSpeedMps, 40 / 3.6, 0.0001);
                assertEqual(exportSummary.averageHeartRate, 145);
                assertEqual(exportSummary.maxHeartRate, 155);
                assertEqual(exportSummary.averagePower, 220);
                assertEqual(exportSummary.maxPower, 260);
                assertEqual(exportSummary.grade.averagePercent, 0);
                assertEqual(exportSummary.grade.averagePositivePercent, 0);
                assertEqual(exportSummary.grade.averageNegativePercent, 0);
                assertEqual(exportSummary.grade.maxPositivePercent, 0);
                assertEqual(exportSummary.grade.maxNegativePercent, 0);
            }
        }
    ]
};
