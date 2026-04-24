import { buildRideMetrics, createEmptyRideMetrics, resolveRideMetrics } from "../../src/domain/metrics/ride-metrics.js";
import { assertApprox, assertEqual } from "../helpers/test-harness.js";

function createRecords() {
    return [
        {
            elapsedSeconds: 1,
            distanceKm: 0.01,
            speedKph: 20,
            power: 100,
            heartRate: 110,
            cadence: 80,
            gradePercent: 1,
            ascentMeters: 2,
            routeProgress: 0.1
        },
        {
            elapsedSeconds: 2,
            distanceKm: 0.02,
            speedKph: 22,
            power: 200,
            heartRate: 120,
            cadence: 82,
            gradePercent: 2,
            ascentMeters: 4,
            routeProgress: 0.2
        },
        {
            elapsedSeconds: 3,
            distanceKm: 0.03,
            speedKph: 24,
            power: 300,
            heartRate: 130,
            cadence: 84,
            gradePercent: 3,
            ascentMeters: 6,
            routeProgress: 0.3
        },
        {
            elapsedSeconds: 4,
            distanceKm: 0.04,
            speedKph: 26,
            power: 400,
            heartRate: 140,
            cadence: 86,
            gradePercent: 4,
            ascentMeters: 8,
            routeProgress: 0.4
        }
    ];
}

export const suite = {
    name: "ride-metrics",
    tests: [
        {
            name: "createEmptyRideMetrics returns zeroed metrics payload",
            run() {
                const metrics = createEmptyRideMetrics();

                assertEqual(metrics.power.rolling3sWatts, 0);
                assertEqual(metrics.speed.averageKph, 0);
                assertEqual(metrics.cadence.averageRpm, null);
                assertEqual(metrics.power.windows["10s"], 0);
            }
        },
        {
            name: "buildRideMetrics aggregates summary fields and rolling windows",
            run() {
                const metrics = buildRideMetrics({
                    records: createRecords(),
                    ftp: 250
                });

                assertEqual(metrics.power.currentWatts, 400);
                assertEqual(metrics.power.averageWatts, 250);
                assertEqual(metrics.power.maxWatts, 400);
                assertEqual(metrics.power.rolling3sWatts, 300);
                assertEqual(metrics.power.rolling10sWatts, 250);
                assertEqual(metrics.power.windows["3s"], 300);
                assertEqual(metrics.heartRate.averageBpm, 125);
                assertEqual(metrics.cadence.averageRpm, 83);
                assertEqual(metrics.speed.maxKph, 26);
                assertEqual(metrics.grade.averagePercent, 2.5);
                assertEqual(metrics.grade.maxPositivePercent, 4);
                assertApprox(metrics.speed.averageKph, 36, 0.0001);
                assertEqual(metrics.load.estimatedTss > 0, true);
                assertEqual(metrics.power.normalizedPowerWatts > 0, true);
            }
        },
        {
            name: "buildRideMetrics uses elapsed time instead of last N records for rolling power",
            run() {
                const metrics = buildRideMetrics({
                    ftp: 250,
                    records: [
                        {
                            elapsedSeconds: 0.5,
                            distanceKm: 0.001,
                            speedKph: 10,
                            power: 100,
                            heartRate: 100,
                            cadence: 80,
                            gradePercent: 0,
                            ascentMeters: 0,
                            routeProgress: 0.01
                        },
                        {
                            elapsedSeconds: 1.5,
                            distanceKm: 0.003,
                            speedKph: 12,
                            power: 200,
                            heartRate: 105,
                            cadence: 82,
                            gradePercent: 0.5,
                            ascentMeters: 1,
                            routeProgress: 0.02
                        },
                        {
                            elapsedSeconds: 2.5,
                            distanceKm: 0.006,
                            speedKph: 14,
                            power: 300,
                            heartRate: 110,
                            cadence: 84,
                            gradePercent: 1,
                            ascentMeters: 2,
                            routeProgress: 0.03
                        },
                        {
                            elapsedSeconds: 6.0,
                            distanceKm: 0.015,
                            speedKph: 16,
                            power: 600,
                            heartRate: 120,
                            cadence: 88,
                            gradePercent: 2,
                            ascentMeters: 4,
                            routeProgress: 0.05
                        }
                    ]
                });

                assertEqual(metrics.power.rolling3sWatts, 600);
                assertEqual(metrics.power.rolling10sWatts, 300);
            }
        },
        {
            name: "resolveRideMetrics falls back to legacy summary when metrics are missing",
            run() {
                const metrics = resolveRideMetrics({
                    summary: {
                        elapsedSeconds: 180,
                        distanceKm: 1.5,
                        averageSpeedKph: 30,
                        currentSpeedKph: 32,
                        averageHeartRate: 145,
                        currentHeartRate: 150,
                        averagePower: 210,
                        currentPower: 220,
                        maxPower: 350,
                        averageCadence: 88,
                        currentCadence: 90,
                        ascentMeters: 25,
                        currentGradePercent: 3,
                        routeProgress: 0.5,
                        estimatedTss: 12.5
                    }
                });

                assertEqual(metrics.ride.elapsedSeconds, 180);
                assertEqual(metrics.ride.distanceKm, 1.5);
                assertEqual(metrics.speed.averageKph, 30);
                assertEqual(metrics.speed.currentKph, 32);
                assertEqual(metrics.heartRate.averageBpm, 145);
                assertEqual(metrics.power.maxWatts, 350);
                assertEqual(metrics.cadence.averageRpm, 88);
                assertEqual(metrics.grade.currentPercent, 3);
                assertEqual(metrics.load.estimatedTss, 12.5);
            }
        }
    ]
};
