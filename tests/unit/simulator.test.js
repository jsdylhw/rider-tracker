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

                assertGreaterThan(session.records.length, 10);
                assertApprox(session.summary.distanceKm, route.totalDistanceMeters / 1000, 0.05);
                assertGreaterThan(session.summary.elapsedSeconds, 0);
                assertGreaterThan(session.summary.averageSpeedKph, 0);
                assert(session.summary.routeProgress >= 0.99, "模拟完成后路线进度应接近 100%");
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
            name: "simulateRide falls back to resting heart rate for empty route summary",
            run() {
                const route = buildRoute([]);
                const session = simulateRide({ route, settings });

                assertEqual(session.summary.averageHeartRate, settings.restingHr);
                assertEqual(session.summary.distanceKm, 0);
            }
        }
    ]
};
