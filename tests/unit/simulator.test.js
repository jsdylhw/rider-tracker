import { buildRoute, buildRouteFromTrackPoints } from "../../src/domain/route/route-builder.js";
import { simulateRide } from "../../src/domain/ride/simulator.js";
import {
    assert,
    assertApprox,
    assertEqual,
    assertGreaterThan
} from "../helpers/test-harness.js";

const settings = {
    power: 220,
    mass: 78,
    ftp: 250,
    crr: 0.004,
    cda: 0.32,
    windSpeed: 0,
    restingHr: 58,
    maxHr: 182
};

function simulateFixedGradeRide({ gradePercent, power }) {
    const route = buildRoute([
        { name: `Grade ${gradePercent}%`, distanceKm: 5, gradePercent }
    ]);

    return simulateRide({
        route,
        settings: {
            ...settings,
            power
        }
    });
}

export const suite = {
    name: "simulator",
    tests: [
        {
            name: "simulateRide completes a manual route and returns summary",
            run() {
                const route = buildRoute([
                    { name: "Flat", distanceKm: 1.2, gradePercent: 0 },
                    { name: "Climb", distanceKm: 0.8, gradePercent: 4 }
                ]);
                const session = simulateRide({ route, settings });
                const metrics = session.summary.metrics;

                assertGreaterThan(session.records.length, 10);
                assertApprox(metrics.ride.distanceKm, route.totalDistanceMeters / 1000, 0.05);
                assertGreaterThan(metrics.ride.elapsedSeconds, 0);
                assertGreaterThan(metrics.speed.averageKph, 0);
                assert(metrics.ride.routeProgress >= 0.99, "模拟完成后路线进度应接近 100%");
            }
        },
        {
            name: "simulateRide carries GPX-derived GPS coordinates into records",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Geo Route",
                    points: [
                        { latitude: 31, longitude: 121, elevationMeters: 10, distanceMeters: 0, gradePercent: 0 },
                        { latitude: 31.001, longitude: 121.002, elevationMeters: 12, distanceMeters: 500, gradePercent: 2 },
                        { latitude: 31.002, longitude: 121.004, elevationMeters: 16, distanceMeters: 1000, gradePercent: 4 }
                    ],
                    segments: [
                        { name: "Geo Route", distanceMeters: 1000, gradePercent: 3, elevationDelta: 6, startDistanceMeters: 0, endDistanceMeters: 1000 }
                    ]
                });
                const session = simulateRide({ route, settings });
                const firstGeoRecord = session.records.find((record) => typeof record.positionLat === "number");

                assert(firstGeoRecord, "应至少存在一条带 GPS 的记录");
                assertGreaterThan(firstGeoRecord.positionLat, 30.9);
                assertGreaterThan(firstGeoRecord.positionLong, 120.9);
            }
        },
        {
            name: "simulateRide computes consistent metrics on a flat route",
            run() {
                const lowerPowerSession = simulateFixedGradeRide({ gradePercent: 0, power: 180 });
                const higherPowerSession = simulateFixedGradeRide({ gradePercent: 0, power: 220 });
                const lowerMetrics = lowerPowerSession.summary.metrics;
                const higherMetrics = higherPowerSession.summary.metrics;

                assertEqual(lowerMetrics.grade.averagePercent, 0);
                assertEqual(higherMetrics.grade.averagePercent, 0);
                assertEqual(lowerMetrics.ride.ascentMeters, 0);
                assertEqual(higherMetrics.ride.ascentMeters, 0);
                assertEqual(lowerMetrics.power.averageWatts, 180);
                assertEqual(higherMetrics.power.averageWatts, 220);
                assertApprox(lowerMetrics.power.normalizedPowerWatts, 180, 5);
                assertApprox(higherMetrics.power.normalizedPowerWatts, 220, 5);
                assertGreaterThan(higherMetrics.speed.averageKph, lowerMetrics.speed.averageKph);
            }
        },
        {
            name: "simulateRide keeps uphill and downhill metrics consistent across powers",
            run() {
                const uphill180 = simulateFixedGradeRide({ gradePercent: 3, power: 180 }).summary.metrics;
                const uphill220 = simulateFixedGradeRide({ gradePercent: 3, power: 220 }).summary.metrics;
                const flat220 = simulateFixedGradeRide({ gradePercent: 0, power: 220 }).summary.metrics;
                const downhill180 = simulateFixedGradeRide({ gradePercent: -3, power: 180 }).summary.metrics;
                const downhill220 = simulateFixedGradeRide({ gradePercent: -3, power: 220 }).summary.metrics;

                assertApprox(uphill180.grade.averagePercent, 3, 0.01);
                assertApprox(uphill220.grade.averagePercent, 3, 0.01);
                assertApprox(downhill180.grade.averagePercent, -3, 0.01);
                assertApprox(downhill220.grade.averagePercent, -3, 0.01);

                assertGreaterThan(uphill180.ride.ascentMeters, 0);
                assertGreaterThan(uphill220.ride.ascentMeters, 0);
                assertEqual(downhill180.ride.ascentMeters, 0);
                assertEqual(downhill220.ride.ascentMeters, 0);

                assertEqual(uphill180.power.averageWatts, 180);
                assertEqual(uphill220.power.averageWatts, 220);
                assertEqual(downhill180.power.averageWatts, 180);
                assertEqual(downhill220.power.averageWatts, 220);

                assertApprox(uphill180.power.normalizedPowerWatts, 180, 5);
                assertApprox(uphill220.power.normalizedPowerWatts, 220, 5);
                assertApprox(downhill180.power.normalizedPowerWatts, 180, 5);
                assertApprox(downhill220.power.normalizedPowerWatts, 220, 5);

                assertGreaterThan(uphill220.speed.averageKph, uphill180.speed.averageKph);
                assertGreaterThan(downhill220.speed.averageKph, downhill180.speed.averageKph);
                assertGreaterThan(flat220.speed.averageKph, uphill220.speed.averageKph);
                assertGreaterThan(downhill220.speed.averageKph, flat220.speed.averageKph);
            }
        },
        {
            name: "simulateRide returns empty metrics for empty route summary",
            run() {
                const route = buildRoute([]);
                const session = simulateRide({ route, settings });

                assertEqual(session.summary.metrics.heartRate.averageBpm, 0);
                assertEqual(session.summary.metrics.ride.distanceKm, 0);
            }
        }
    ]
};
