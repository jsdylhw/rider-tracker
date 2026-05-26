import { resolveFitExportSummary, downsampleTo1Hz, exportSessionAsFit } from "../../src/adapters/export/fit-exporter.js";
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
            name: "resolveFitExportSummary carries NP/IF/TSS/FTP into export",
            run() {
                const exportSummary = resolveFitExportSummary({
                    summary: {
                        settings: { ftp: 250 },
                        metrics: {
                            ride: { elapsedSeconds: 3600, distanceKm: 40, ascentMeters: 500 },
                            speed: { averageKph: 40, maxKph: 55 },
                            heartRate: { averageBpm: 150, maxBpm: 175 },
                            power: {
                                averageWatts: 200,
                                maxWatts: 400,
                                normalizedPowerWatts: 230,
                                intensityFactor: 0.92
                            },
                            grade: {
                                averagePercent: 1.2,
                                averagePositivePercent: 2.5,
                                averageNegativePercent: -1.0,
                                maxPositivePercent: 8,
                                maxNegativePercent: -5
                            },
                            load: { estimatedTss: 85 }
                        }
                    },
                    records: [{ elapsedSeconds: 3600, distanceKm: 40, speedKph: 55, heartRate: 175, power: 400, ascentMeters: 500 }],
                    ftp: 250
                });

                assertEqual(exportSummary.normalizedPowerWatts, 230);
                assertEqual(exportSummary.intensityFactor, 0.92);
                assertEqual(exportSummary.trainingStressScore, 85);
                assertEqual(exportSummary.thresholdPowerWatts, 250);
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
        },
        {
            name: "exportSessionAsFit round-trip: profile + zones + NP/IF/TSS/FTP/cadence",
            async run() {
                const session = {
                    startedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
                    finishedAt: new Date("2026-01-01T01:00:00Z").toISOString(),
                    settings: { ftp: 250, mass: 70.5, restingHr: 58, maxHr: 190 },
                    summary: {
                        elapsedSeconds: 3600,
                        distanceKm: 40,
                        averageSpeedKph: 40,
                        maxSpeedKph: 55,
                        averageHeartRate: 150,
                        maxHeartRate: 175,
                        averagePower: 200,
                        maxPower: 400,
                        averageGradePercent: 1.2,
                        averagePositiveGradePercent: 2.5,
                        averageNegativeGradePercent: -1.0,
                        maxPositiveGradePercent: 8,
                        maxNegativeGradePercent: -5,
                        metrics: {
                            ride: {
                                elapsedSeconds: 3600,
                                distanceKm: 40,
                                ascentMeters: 500
                            },
                            speed: { averageKph: 40, maxKph: 55 },
                            heartRate: { averageBpm: 150, maxBpm: 175 },
                            power: {
                                averageWatts: 200,
                                maxWatts: 400,
                                normalizedPowerWatts: 230,
                                intensityFactor: 0.92
                            },
                            cadence: { averageRpm: 85, maxRpm: 105 },
                            grade: {
                                averagePercent: 1.2,
                                averagePositivePercent: 2.5,
                                averageNegativePercent: -1.0,
                                maxPositivePercent: 8,
                                maxNegativePercent: -5
                            },
                            load: { estimatedTss: 85 }
                        }
                    },
                    records: [
                        { elapsedSeconds: 0, heartRate: 140, cadence: 80, speedKph: 35, power: 180, distanceKm: 0, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 1800, heartRate: 155, cadence: 90, speedKph: 42, power: 220, distanceKm: 20, elevationMeters: 300, gradePercent: 2.5 },
                        { elapsedSeconds: 3600, heartRate: 160, cadence: 105, speedKph: 55, power: 400, distanceKm: 40, elevationMeters: 500, gradePercent: 0 }
                    ]
                };

                const fitBytes = await exportSessionAsFit(session, {}, { markVirtualActivity: false });
                const { Decoder, Stream } = await import("@garmin/fitsdk");
                const decoder = new Decoder(Stream.fromBuffer(fitBytes));
                const { messages } = decoder.read();

                // userProfile: weight 传原始 kg，SDK 自动 ×10
                const up = messages.userProfileMesgs?.[0];
                assertEqual(up != null, true);
                assertApprox(up.weight, 70.5, 0.1);
                assertEqual(up.restingHeartRate, 58);
                assertEqual(up.defaultMaxBikingHeartRate, 190);

                // bikeProfile: 无车重，仅有 name/sport
                const bp = messages.bikeProfileMesgs?.[0];
                assertEqual(bp != null, true);
                assertEqual(bp.name, "Rider Tracker Virtual Bike");
                assertEqual(bp.sport, "cycling");

                // hrZone ×5
                assertEqual(messages.hrZoneMesgs?.length, 5);
                assertEqual(messages.hrZoneMesgs[4].highBpm, 190);

                // zonesTarget: FTP + maxHR
                const zt = messages.zonesTargetMesgs?.[0];
                assertEqual(zt != null, true);
                assertEqual(zt.functionalThresholdPower, 250);
                assertEqual(zt.maxHeartRate, 190);

                // powerZone ×7
                assertEqual(messages.powerZoneMesgs?.length, 7);
                assertEqual(messages.powerZoneMesgs[3].highValue, 263);
                assertEqual(messages.powerZoneMesgs[3].name, "Z4 Threshold");

                // SESSION NP/IF/TSS/FTP/cadence
                const sessionMsg = messages.sessionMesgs?.[0];
                assertEqual(sessionMsg != null, true);
                assertApprox(sessionMsg.normalizedPower, 230, 1);
                assertApprox(sessionMsg.intensityFactor, 0.92, 0.01);
                assertApprox(sessionMsg.trainingStressScore, 85, 1);
                assertApprox(sessionMsg.thresholdPower, 250, 1);
                assertEqual(sessionMsg.avgCadence, 85);
                assertEqual(sessionMsg.maxCadence, 105);

                // 分区时间：t=1800 的 220W→Z3, t=3600 的 400W→Z7
                assertEqual(sessionMsg.timeInPowerZone[2], 1800);
                assertEqual(sessionMsg.timeInPowerZone[6], 1800);
                // HR: t=1800 的 155bpm→Z3, t=3600 的 160bpm→Z3，各 1800s，Z3 合计 3600s
                assertEqual(sessionMsg.timeInHrZone[2], 3600);
                assertApprox(sessionMsg.timeInHrZone.reduce((a, b) => a + b, 0), 3600, 1);
            }
        },
        {
            name: "exportSessionAsFit zone times preserve sub-second precision",
            async run() {
                const session = {
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    settings: { ftp: 250, mass: 70, restingHr: 58, maxHr: 190 },
                    summary: {
                        metrics: {
                            ride: { elapsedSeconds: 1, distanceKm: 0.01, ascentMeters: 0 },
                            speed: { averageKph: 36, maxKph: 36 },
                            heartRate: { averageBpm: 150, maxBpm: 150 },
                            power: { averageWatts: 180, maxWatts: 180, normalizedPowerWatts: 180, intensityFactor: 0.72 },
                            cadence: { averageRpm: 85, maxRpm: 85 },
                            load: { estimatedTss: 1 }
                        }
                    },
                    records: [
                        { elapsedSeconds: 0, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 0.2, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0.002, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 0.4, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0.004, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 0.6, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0.006, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 0.8, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0.008, elevationMeters: 100, gradePercent: 1 },
                        { elapsedSeconds: 1.0, power: 180, heartRate: 140, cadence: 85, speedKph: 30, distanceKm: 0.010, elevationMeters: 100, gradePercent: 1 }
                    ]
                };

                const fitBytes = await exportSessionAsFit(session, {}, { markVirtualActivity: false });
                const { Decoder, Stream } = await import("@garmin/fitsdk");
                const decoder = new Decoder(Stream.fromBuffer(fitBytes));
                const { messages } = decoder.read();

                const pz = messages.sessionMesgs?.[0]?.timeInPowerZone;
                const hz = messages.sessionMesgs?.[0]?.timeInHrZone;

                // 180W / 250 FTP = 0.72 → Z2 (0.55-0.75)，1 秒合计
                assertApprox(pz[1], 1, 0.1);
                // HR 140, maxHr=190, restHr=58, hrr=132 → (140-58)/132=0.621 → Z2 (0.60-0.70)
                assertApprox(hz[1], 1, 0.1);
            }
        },
        {
            name: "exportSessionAsFit omits undefined optional fields instead of exporting 0",
            async run() {
                const session = {
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    settings: {},
                    summary: {
                        metrics: {
                            ride: { elapsedSeconds: 1, distanceKm: 0.01 },
                            speed: { averageKph: 36, maxKph: 36 },
                            heartRate: { averageBpm: 0, maxBpm: 0 },
                            power: { averageWatts: 0, maxWatts: 0, normalizedPowerWatts: 0, intensityFactor: null },
                            cadence: { averageRpm: null, maxRpm: null },
                            load: { estimatedTss: null }
                        }
                    },
                    records: [
                        { elapsedSeconds: 0, speedKph: 36, distanceKm: 0 },
                        { elapsedSeconds: 1, speedKph: 36, distanceKm: 0.01 }
                    ]
                };

                const fitBytes = await exportSessionAsFit(session, {}, { markVirtualActivity: false });
                const { Decoder, Stream } = await import("@garmin/fitsdk");
                const decoder = new Decoder(Stream.fromBuffer(fitBytes));
                const { messages } = decoder.read();

                const msg = messages.sessionMesgs?.[0];
                // 缺失字段不应出现 0
                assertEqual(msg.normalizedPower, undefined);
                assertEqual(msg.intensityFactor, undefined);
                assertEqual(msg.trainingStressScore, undefined);
                assertEqual(msg.thresholdPower, undefined);
                assertEqual(msg.avgCadence, undefined);
                assertEqual(msg.maxCadence, undefined);
                assertEqual(msg.timeInPowerZone, undefined);
                assertEqual(msg.timeInHrZone, undefined);
                // 必选字段仍正常
                assertEqual(msg.totalElapsedTime, 1);
            }
        }
    ]
};
