import { resolveFitExportSummary } from "../../src/adapters/export/fit-exporter.js";
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
