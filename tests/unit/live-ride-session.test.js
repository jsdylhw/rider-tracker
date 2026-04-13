import { buildRouteFromTrackPoints } from "../../src/domain/course/route-builder.js";
import { advanceLiveRideSession, createLiveRideSession } from "../../src/domain/session/live-ride-session.js";
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

function createGeoRoute() {
    return buildRouteFromTrackPoints({
        name: "Live Route",
        points: [
            { latitude: 31.2, longitude: 121.4, elevationMeters: 10, distanceMeters: 0, gradePercent: 0 },
            { latitude: 31.201, longitude: 121.401, elevationMeters: 20, distanceMeters: 600, gradePercent: 2 },
            { latitude: 31.202, longitude: 121.402, elevationMeters: 40, distanceMeters: 1200, gradePercent: 4 }
        ],
        segments: [
            { name: "Live Route", distanceMeters: 1200, gradePercent: 3, elevationDelta: 30, startDistanceMeters: 0, endDistanceMeters: 1200 }
        ]
    });
}

export const suite = {
    name: "live-ride-session",
    tests: [
        {
            name: "createLiveRideSession initializes empty session state",
            run() {
                const session = createLiveRideSession({
                    route: createGeoRoute(),
                    settings,
                    startedAt: "2026-01-01T00:00:00.000Z",
                    initialHeartRate: 95
                });

                assertEqual(session.records.length, 0);
                assertEqual(session.physicsState.heartRate, 95);
                assertEqual(session.summary.elapsedSeconds, 0);
            }
        },
        {
            name: "advanceLiveRideSession appends records and computes live summary",
            run() {
                let session = createLiveRideSession({
                    route: createGeoRoute(),
                    settings,
                    startedAt: "2026-01-01T00:00:00.000Z",
                    initialHeartRate: 100
                });

                session = advanceLiveRideSession({
                    session,
                    power: 230,
                    heartRate: 110,
                    cadence: 88,
                    dt: 1
                });

                session = advanceLiveRideSession({
                    session,
                    power: 260,
                    heartRate: 120,
                    cadence: 90,
                    dt: 1
                });

                assertEqual(session.records.length, 2);
                assertGreaterThan(session.summary.averageSpeedKph, 0);
                assertEqual(session.summary.averageHeartRate, 115);
                assertEqual(session.summary.maxPower, 260);
                assertEqual(session.summary.averageCadence, 89);
                assertGreaterThan(session.summary.estimatedTss, 0);
            }
        },
        {
            name: "advanceLiveRideSession keeps geo position and progress data",
            run() {
                let session = createLiveRideSession({
                    route: createGeoRoute(),
                    settings,
                    startedAt: "2026-01-01T00:00:00.000Z"
                });

                for (let index = 0; index < 10; index += 1) {
                    session = advanceLiveRideSession({
                        session,
                        power: 220,
                        heartRate: 115,
                        cadence: 85,
                        dt: 1
                    });
                }

                const record = session.records.at(-1);
                assert(typeof record.positionLat === "number", "应携带 positionLat");
                assert(typeof record.positionLong === "number", "应携带 positionLong");
                assert(record.routeProgress > 0, "路线进度应已推进");
                assertApprox(session.summary.currentPower, record.power, 0.001);
            }
        }
    ]
};
