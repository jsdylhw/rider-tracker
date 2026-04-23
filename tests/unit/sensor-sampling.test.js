import {
    buildEffectiveSensorSnapshot,
    createInitialSensorSamplingState,
    ingestPowerSample
} from "../../src/app/realtime/sensor-sampling.js";
import { assertApprox, assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

export const suite = {
    name: "sensor-sampling",
    tests: [
        {
            name: "ingestPowerSample estimates stable trainer signal interval",
            run() {
                let sampling = createInitialSensorSamplingState();
                const timestamps = [1000, 1250, 1500, 1750, 2000];

                timestamps.forEach((timestamp, index) => {
                    sampling = ingestPowerSample(sampling, {
                        power: 220 + index,
                        cadence: 85,
                        sourceType: "trainer",
                        timestamp
                    });
                });

                const snapshot = buildEffectiveSensorSnapshot(sampling, { now: 2050 });

                assertApprox(snapshot.powerSignal.estimatedIntervalMs, 250, 0.001);
                assertGreaterThan(snapshot.powerSignal.estimatedHz, 3.9);
                assertEqual(snapshot.powerSignal.intervalSampleCount, 4);
                assertEqual(snapshot.powerSignal.isStable, true);
            }
        },
        {
            name: "ingestPowerSample resets signal estimate after power source switch",
            run() {
                let sampling = createInitialSensorSamplingState();

                sampling = ingestPowerSample(sampling, {
                    power: 220,
                    cadence: 85,
                    sourceType: "trainer",
                    timestamp: 1000
                });
                sampling = ingestPowerSample(sampling, {
                    power: 225,
                    cadence: 86,
                    sourceType: "trainer",
                    timestamp: 1250
                });
                sampling = ingestPowerSample(sampling, {
                    power: 228,
                    cadence: 86,
                    sourceType: "external-power-meter",
                    timestamp: 1500
                });

                const snapshot = buildEffectiveSensorSnapshot(sampling, { now: 1550 });

                assertEqual(snapshot.powerSourceType, "external-power-meter");
                assertEqual(snapshot.powerSignal.estimatedIntervalMs, null);
                assertEqual(snapshot.powerSignal.intervalSampleCount, 0);
                assertEqual(snapshot.powerSignal.isStable, false);
            }
        }
    ]
};
