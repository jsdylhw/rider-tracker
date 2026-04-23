import { resolveSpeedTarget, simulateStep } from "../../src/domain/physics/cycling-model.js";
import {
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
            name: "resolveSpeedTarget rises with power on flat, 3% climb and -3% descent",
            run() {
                const powers = [120, 180, 240, 300];
                const grades = [0, 3, -3];

                for (const gradePercent of grades) {
                    const speeds = powers.map((power) => resolveSpeedTarget({
                        power,
                        gradePercent,
                        mass: settings.mass,
                        crr: settings.crr,
                        cda: settings.cda,
                        windSpeed: 0
                    }));

                    for (let index = 1; index < speeds.length; index += 1) {
                        assertGreaterThan(
                            speeds[index],
                            speeds[index - 1],
                            `Expected higher power to yield higher speed at grade ${gradePercent}%`
                        );
                    }
                }
            }
        },
        {
            name: "resolveSpeedTarget keeps climb < flat < descent for multiple power levels at +/-3%",
            run() {
                const powers = [120, 180, 240, 300];

                for (const power of powers) {
                    const climb = resolveSpeedTarget({ power, gradePercent: 3, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                    const flat = resolveSpeedTarget({ power, gradePercent: 0, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });
                    const descent = resolveSpeedTarget({ power, gradePercent: -3, mass: settings.mass, crr: settings.crr, cda: settings.cda, windSpeed: 0 });

                    assertLessThan(climb, flat, `Expected climb speed to be lower than flat at power ${power}W`);
                    assertGreaterThan(descent, flat, `Expected descent speed to be higher than flat at power ${power}W`);
                }
            }
        },
        {
            name: "resolveSpeedTarget responds to wind direction on flat route",
            run() {
                const power = 220;
                const tailwind = resolveSpeedTarget({
                    power,
                    gradePercent: 0,
                    mass: settings.mass,
                    crr: settings.crr,
                    cda: settings.cda,
                    windSpeed: -4
                });
                const calm = resolveSpeedTarget({
                    power,
                    gradePercent: 0,
                    mass: settings.mass,
                    crr: settings.crr,
                    cda: settings.cda,
                    windSpeed: 0
                });
                const headwind = resolveSpeedTarget({
                    power,
                    gradePercent: 0,
                    mass: settings.mass,
                    crr: settings.crr,
                    cda: settings.cda,
                    windSpeed: 4
                });

                assertGreaterThan(tailwind, calm, "Expected tailwind to increase speed");
                assertGreaterThan(calm, headwind, "Expected headwind to decrease speed");
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
                    gradePercent: 4,
                    elapsedSeconds: 10,
                    settings,
                    durationSeconds: 3600,
                    dt: 1
                });

                assertGreaterThan(next.distanceMeters, 100);
                assertGreaterThan(next.elevationMeters, 10);
                assertGreaterThan(next.ascentMeters, 5);
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
                    gradePercent: -20,
                    elapsedSeconds: 100,
                    settings,
                    durationSeconds: 3600,
                    dt: 1
                });

                assertGreaterThan(coasting.speed + 1, 0);
                assertLessThan(downhill.speed, 33.31);
            }
        }
    ]
};
