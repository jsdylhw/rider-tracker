import {
    advanceLiveHeartRateState,
    createInitialLiveHeartRateState,
    estimateHeartRate
} from "../../src/domain/physiology/heart-rate-model.js";
import { assertEqual, assertGreaterThan, assertLessThan } from "../helpers/test-harness.js";

export const suite = {
    name: "heart-rate-model",
    tests: [
        {
            name: "advanceLiveHeartRateState prefers fresh sensor heart rate",
            run() {
                const initialState = createInitialLiveHeartRateState({
                    initialHeartRate: 98,
                    restingHr: 58
                });

                const nextState = advanceLiveHeartRateState({
                    currentState: initialState,
                    sampledHeartRate: 124,
                    restingHr: 58
                });

                assertEqual(nextState.currentHeartRate, 124);
                assertEqual(nextState.source, "sensor");
            }
        },
        {
            name: "advanceLiveHeartRateState carries forward previous value when no new sample arrives",
            run() {
                const nextState = advanceLiveHeartRateState({
                    currentState: {
                        currentHeartRate: 119,
                        source: "sensor"
                    },
                    sampledHeartRate: null,
                    restingHr: 58
                });

                assertEqual(nextState.currentHeartRate, 119);
                assertEqual(nextState.source, "sensor");
            }
        },
        {
            name: "estimateHeartRate rises with power but stays below max heart rate",
            run() {
                const nextHeartRate = estimateHeartRate({
                    currentHeartRate: 168,
                    power: 400,
                    elapsedSeconds: 3500,
                    durationSeconds: 3600,
                    restingHr: 58,
                    maxHr: 182,
                    dt: 1
                });

                assertGreaterThan(nextHeartRate, 168);
                assertLessThan(nextHeartRate, 182.001);
            }
        }
    ]
};
