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
            name: "downsampleTo1Hz 动态 tick 200/250/500/1000ms 无重复秒级 timestamp",
            run() {
                const tickRates = [0.2, 0.25, 0.5, 1.0];
                const durationSec = 30;
                for (const dt of tickRates) {
                    const records = [];
                    const steps = Math.floor(durationSec / dt);
                    for (let i = 0; i <= steps; i += 1) {
                        const t = i * dt;
                        records.push({
                            elapsedSeconds: t,
                            power: 150 + i,
                            heartRate: 130 + i,
                            cadence: 85,
                            speedKph: 32,
                            gradePercent: 1.5,
                            distanceKm: t * (32 / 3600),
                            elevationMeters: 100 + t * 0.3
                        });
                    }
                    const result = downsampleTo1Hz(records);

                    // 首条 t=0
                    assertEqual(result[0].elapsedSeconds, 0);
                    assertEqual(result[0].distanceKm, 0);

                    // 除首条外，所有 bucket 输出在整秒边界
                    for (let i = 1; i < result.length; i += 1) {
                        assertEqual(Number.isInteger(result[i].elapsedSeconds), true);
                    }

                    // FIT 秒级 timestamp 无重复
                    const fitTimestamps = result.map(r => Math.round(r.elapsedSeconds));
                    const unique = new Set(fitTimestamps);
                    assertEqual(unique.size, fitTimestamps.length);

                    // 严格递增
                    for (let i = 1; i < result.length; i += 1) {
                        assertEqual(result[i].elapsedSeconds > result[i - 1].elapsedSeconds, true);
                    }

                    // 末尾累计值匹配原始最后一条（覆盖整秒结束 200/250/500ms）
                    assertEqual(result.at(-1).distanceKm, records.at(-1).distanceKm);
                }
            }
        },
        {
            name: "downsampleTo1Hz 非整秒结束无重复秒级 timestamp 且末尾累计值正确",
            run() {
                // dt=0.2, endTime=60.2/60.4/60.6 都落在非整秒
                const endings = [60.2, 60.4, 60.6];
                const dt = 0.2;
                for (const endTime of endings) {
                    const records = [];
                    const steps = Math.floor(endTime / dt);
                    for (let i = 0; i <= steps; i += 1) {
                        const t = i * dt;
                        records.push({
                            elapsedSeconds: t,
                            power: 150 + i,
                            heartRate: 130 + i,
                            cadence: 85,
                            speedKph: 32,
                            gradePercent: 1.5,
                            distanceKm: t * (32 / 3600),
                            elevationMeters: 100 + t * 0.3
                        });
                    }
                    const result = downsampleTo1Hz(records);

                    // FIT 秒级 timestamp 全部唯一
                    const fitTimestamps = result.map(r => Math.round(r.elapsedSeconds));
                    const dups = fitTimestamps.filter((t, i) => fitTimestamps.indexOf(t) !== i);
                    assertEqual(dups.length, 0);

                    // 最后一条 elapsed 在整秒边界
                    assertEqual(Number.isInteger(result.at(-1).elapsedSeconds), true);

                    // 末尾累计值来自原始最后一条 record
                    const expectedDist = records.at(-1).distanceKm;
                    assertEqual(result.at(-1).distanceKm, expectedDist);
                }
            }
        },
        {
            name: "downsampleTo1Hz live ride 记录从 dt 开始也能正确分桶",
            run() {
                // live ride 首条记录是 dt（如 0.25s），不是 0
                const tickRates = [0.2, 0.25, 0.5];
                const durationSec = 30;
                for (const dt of tickRates) {
                    const records = [];
                    const steps = Math.floor(durationSec / dt);
                    for (let i = 1; i <= steps; i += 1) {
                        const t = Number((i * dt).toFixed(5));
                        records.push({
                            elapsedSeconds: t,
                            power: 150 + i,
                            heartRate: 130 + i,
                            cadence: 85,
                            speedKph: 32,
                            gradePercent: 1.5,
                            distanceKm: t * (32 / 3600),
                            elevationMeters: 100 + t * 0.3
                        });
                    }
                    const result = downsampleTo1Hz(records);

                    // 亚秒首条归入第一桶，result 全由整秒 bucket 组成
                    for (let i = 0; i < result.length; i += 1) {
                        assertEqual(Number.isInteger(result[i].elapsedSeconds), true);
                    }
                    // 除首条外，bucket 输出在整秒边界
                    for (let i = 1; i < result.length; i += 1) {
                        assertEqual(Number.isInteger(result[i].elapsedSeconds), true);
                    }
                    // FIT 秒级无重复
                    const stamps = result.map(r => Math.round(r.elapsedSeconds));
                    assertEqual(new Set(stamps).size, stamps.length);
                    // 末尾合并
                    assertEqual(result.at(-1).distanceKm, records.at(-1).distanceKm);
                }
            }
        },
        {
            name: "downsampleTo1Hz 不到1秒多条 sub-second record 不会变空数组",
            run() {
                // [0.25, 0.5] endBucket < startBucket → 聚合到 t=1
                const records = [
                    { elapsedSeconds: 0.25, power: 150, heartRate: 140, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.002, elevationMeters: 100 },
                    { elapsedSeconds: 0.50, power: 155, heartRate: 141, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.004, elevationMeters: 101 }
                ];
                const result = downsampleTo1Hz(records);
                assertEqual(result.length >= 1, true);
                assertEqual(result[0].elapsedSeconds, 1);
                assertEqual(result[0].distanceKm, 0.004);
            }
        },
        {
            name: "downsampleTo1Hz 1秒短骑行 sub-second 首条归入 bucket",
            run() {
                // 4 条 [0.25, 0.5, 0.75, 1.0]，首条不是整秒，归入 t=1 bucket
                const records = [
                    { elapsedSeconds: 0.25, power: 150, heartRate: 140, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.002, elevationMeters: 100 },
                    { elapsedSeconds: 0.50, power: 155, heartRate: 141, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.004, elevationMeters: 101 },
                    { elapsedSeconds: 0.75, power: 160, heartRate: 142, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.006, elevationMeters: 102 },
                    { elapsedSeconds: 1.00, power: 165, heartRate: 143, cadence: 85, speedKph: 30, gradePercent: 1, distanceKm: 0.008, elevationMeters: 103 }
                ];
                const result = downsampleTo1Hz(records);
                assertEqual(result.length, 1);
                assertEqual(result[0].elapsedSeconds, 1);
                assertEqual(result[0].distanceKm, 0.008);
                assertEqual(result[0].power > 150 && result[0].power < 165, true);
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
