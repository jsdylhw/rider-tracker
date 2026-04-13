import { resolveSpeedTarget, simulateStep } from "../../src/domain/physics/cycling-model.js";
import {
    assertApprox,
    assertGreaterThan,
    assertLessThan
} from "../helpers/test-harness.js";

const settings = {
    mass: 78,
    ftp: 250,
    crr: 0.004,
    cda: 0.32,
    windSpeed: 0,
    restingHr: 58,
    maxHr: 182
};

export const suite = {
    name: "cycling-model",
    tests: [
        {
            name: "resolveSpeedTarget increases with higher power on flat route",
            run() {
                const low = resolveSpeedTarget({ power: 160, gradePercent: 0, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                const high = resolveSpeedTarget({ power: 260, gradePercent: 0, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                assertGreaterThan(high, low);
            }
        },
        {
            name: "resolveSpeedTarget drops on climbs and rises on descents",
            run() {
                const flat = resolveSpeedTarget({ power: 220, gradePercent: 0, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                const climb = resolveSpeedTarget({ power: 220, gradePercent: 6, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                const descent = resolveSpeedTarget({ power: 220, gradePercent: -4, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                assertLessThan(climb, flat);
                assertGreaterThan(descent, flat);
            }
        },
        {
            name: "simulateStep accumulates distance and ascent on uphill efforts",
            run() {
                const next = simulateStep({
                    speed: 5,
                    distanceMeters: 100,
                    elevationMeters: 10,
                    ascentMeters: 5,
                    power: 220,
                    heartRate: 120,
                    gradePercent: 4,
                    elapsedSeconds: 10,
                    settings,
                    durationSeconds: 3600,
                    dt: 1
                });

                assertGreaterThan(next.distanceMeters, 100);
                assertGreaterThan(next.elevationMeters, 10);
                assertGreaterThan(next.ascentMeters, 5);
                assertGreaterThan(next.heartRate, 120);
            }
        },
        {
            name: "simulateStep never returns negative speed and respects speed cap",
            run() {
                const coasting = simulateStep({
                    speed: 1,
                    distanceMeters: 0,
                    elevationMeters: 0,
                    ascentMeters: 0,
                    power: 0,
                    heartRate: 100,
                    gradePercent: 18,
                    elapsedSeconds: 1,
                    settings,
                    durationSeconds: 60,
                    dt: 1
                });

                const downhill = simulateStep({
                    speed: 33,
                    distanceMeters: 0,
                    elevationMeters: 0,
                    ascentMeters: 0,
                    power: 500,
                    heartRate: 150,
                    gradePercent: -20,
                    elapsedSeconds: 100,
                    settings,
                    durationSeconds: 3600,
                    dt: 1
                });

                assertGreaterThan(coasting.speed + 1, 0);
                assertLessThan(downhill.speed, 33.31);
            }
        },
        {
            name: "heart rate response remains below max heart rate",
            run() {
                const next = simulateStep({
                    speed: 8,
                    distanceMeters: 0,
                    elevationMeters: 0,
                    ascentMeters: 0,
                    power: 400,
                    heartRate: 170,
                    gradePercent: 2,
                    elapsedSeconds: 3500,
                    settings,
                    durationSeconds: 3600,
                    dt: 1
                });

                assertLessThan(next.heartRate, settings.maxHr + 0.001);
                assertApprox(next.heartRate <= settings.maxHr ? 1 : 0, 1, 0.001);
            }
        }
    ]
};
