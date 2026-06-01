import { createIncrementalPowerState, advanceIncrementalPowerState, readIncrementalPowerMetrics, summarizePowerMetrics } from "../../src/domain/metrics/power-metrics.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function makeRecord(elapsedSeconds, power) {
    return { elapsedSeconds, power };
}

function buildRecordsFromPowerList(powers, intervalSec = 1) {
    return powers.map((power, i) => makeRecord(i * intervalSec, power));
}

export const suite = {
    name: "incremental-power-metrics",
    tests: [
        {
            name: "initial state has zero metrics",
            run() {
                const state = createIncrementalPowerState();
                const metrics = readIncrementalPowerMetrics(state);
                assertEqual(metrics.rolling3sWatts, 0);
                assertEqual(metrics.rolling10sWatts, 0);
                assertEqual(metrics.normalizedPowerWatts, 0);
            }
        },
        {
            name: "rolling 3s average reflects last 3 seconds of power",
            run() {
                let state = createIncrementalPowerState();
                // Power ramps: 100, 200, 300, 400 over 4 seconds
                state = advanceIncrementalPowerState(state, makeRecord(1, 100));
                state = advanceIncrementalPowerState(state, makeRecord(2, 200));
                state = advanceIncrementalPowerState(state, makeRecord(3, 300));
                state = advanceIncrementalPowerState(state, makeRecord(4, 400));

                const metrics = readIncrementalPowerMetrics(state);
                // Last 3s: t=2(200) + t=3(300) + t=4(400) = 900/3 = 300
                assertEqual(metrics.rolling3sWatts, 300);
            }
        },
        {
            name: "rolling 3s expires entries outside window",
            run() {
                let state = createIncrementalPowerState();
                state = advanceIncrementalPowerState(state, makeRecord(1, 100));
                state = advanceIncrementalPowerState(state, makeRecord(2, 200));
                state = advanceIncrementalPowerState(state, makeRecord(5, 500));

                const metrics = readIncrementalPowerMetrics(state);
                // Only t=5 (500) is within last 3s of t=5
                assertEqual(metrics.rolling3sWatts, 500);
            }
        },
        {
            name: "rolling 10s includes all entries within 10 seconds",
            run() {
                let state = createIncrementalPowerState();
                state = advanceIncrementalPowerState(state, makeRecord(1, 100));
                state = advanceIncrementalPowerState(state, makeRecord(5, 200));
                state = advanceIncrementalPowerState(state, makeRecord(9, 300));

                const metrics = readIncrementalPowerMetrics(state);
                // All three within 10s of t=9: (100+200+300)/3 = 200
                assertEqual(metrics.rolling10sWatts, 200);
            }
        },
        {
            name: "incremental NP matches full-algorithm NP for ramp power",
            run() {
                const powers = [];
                for (let i = 1; i <= 60; i++) {
                    powers.push(100 + i * 3);
                }
                const records = buildRecordsFromPowerList(powers);

                let state = createIncrementalPowerState();
                for (const r of records) {
                    state = advanceIncrementalPowerState(state, r);
                }
                const incMetrics = readIncrementalPowerMetrics(state);
                const fullMetrics = summarizePowerMetrics({ records });

                assertEqual(incMetrics.normalizedPowerWatts, fullMetrics.normalizedPowerWatts,
                    `ramp NP mismatch: inc ${incMetrics.normalizedPowerWatts} vs full ${fullMetrics.normalizedPowerWatts}`);
            }
        },
        {
            name: "incremental NP matches full-algorithm NP for steady power",
            run() {
                const powers = Array(120).fill(220);
                const records = buildRecordsFromPowerList(powers);

                let state = createIncrementalPowerState();
                for (const r of records) {
                    state = advanceIncrementalPowerState(state, r);
                }
                const incMetrics = readIncrementalPowerMetrics(state);
                const fullMetrics = summarizePowerMetrics({ records });

                assertEqual(incMetrics.normalizedPowerWatts, fullMetrics.normalizedPowerWatts,
                    `steady NP mismatch: inc ${incMetrics.normalizedPowerWatts} vs full ${fullMetrics.normalizedPowerWatts}`);
            }
        },
        {
            name: "incremental NP handles zero power early in ride",
            run() {
                let state = createIncrementalPowerState();
                state = advanceIncrementalPowerState(state, makeRecord(0, 0));
                state = advanceIncrementalPowerState(state, makeRecord(1, 0));
                state = advanceIncrementalPowerState(state, makeRecord(2, 0));

                const metrics = readIncrementalPowerMetrics(state);
                assertEqual(metrics.normalizedPowerWatts, 0);
            }
        },
        {
            name: "incremental NP with variable-interval data matches full NP",
            run() {
                const powers = [];
                for (let t = 5; t <= 120; t += 5) {
                    powers.push(150 + Math.sin(t * 0.2) * 50);
                }
                const records = powers.map((p, i) => makeRecord((i + 1) * 5, p));

                let state = createIncrementalPowerState();
                for (const r of records) {
                    state = advanceIncrementalPowerState(state, r);
                }
                const incMetrics = readIncrementalPowerMetrics(state);
                const fullMetrics = summarizePowerMetrics({ records });

                assertEqual(incMetrics.normalizedPowerWatts, fullMetrics.normalizedPowerWatts,
                    `variable-interval NP mismatch: inc ${incMetrics.normalizedPowerWatts} vs full ${fullMetrics.normalizedPowerWatts}`);
            }
        },
        {
            name: "incremental NP handles zero leading power correctly",
            run() {
                // [0W, 0W, 100W] — full NP should be 33W per findings repro
                const records = [
                    makeRecord(1, 0),
                    makeRecord(2, 0),
                    makeRecord(3, 100)
                ];
                let state = createIncrementalPowerState();
                for (const r of records) {
                    state = advanceIncrementalPowerState(state, r);
                }
                const incMetrics = readIncrementalPowerMetrics(state);
                const fullMetrics = summarizePowerMetrics({ records });

                assertEqual(incMetrics.normalizedPowerWatts, fullMetrics.normalizedPowerWatts,
                    `zero-leading NP mismatch: inc ${incMetrics.normalizedPowerWatts} vs full ${fullMetrics.normalizedPowerWatts}`);
            }
        },
        {
            name: "consumePowerRecords convenience function",
            run() {
                // Helper: utility for consuming multiple records at once
                const records = [
                    makeRecord(1, 100),
                    makeRecord(2, 200),
                    makeRecord(3, 300),
                    makeRecord(4, 400),
                    makeRecord(5, 500)
                ];

                let state = createIncrementalPowerState();
                for (const r of records) {
                    state = advanceIncrementalPowerState(state, r);
                }

                const metrics = readIncrementalPowerMetrics(state);
                assert(metrics.rolling3sWatts > 0, "should have non-zero rolling 3s after records");
                assert(metrics.rolling10sWatts > 0, "should have non-zero rolling 10s after records");
                assert(metrics.normalizedPowerWatts > 0, "should have non-zero NP after records");
            }
        }
    ]
};
