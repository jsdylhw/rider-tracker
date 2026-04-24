import { createStore } from "../../src/app/store/app-store.js";
import { createWorkoutService } from "../../src/app/services/workout-service.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual } from "../helpers/test-harness.js";

function createBaseState(mode = WORKOUT_MODES.FIXED_POWER) {
    return {
        settings: {
            power: 220
        },
        route: {
            totalDistanceMeters: 1000,
            hasElevationData: true,
            points: [{ distanceMeters: 0, gradePercent: 2 }],
            source: "manual",
            name: "测试路线",
            segments: []
        },
        workout: {
            mode,
            erg: {
                confirmationRequired: false
            },
            gradeSimulation: {
                difficultyPercent: 75,
                lookaheadMeters: 120,
                maxUphillPercent: 10,
                maxDownhillPercent: -3,
                smoothingFactor: 0.35
            },
            runtime: {
                targetTrainerGradePercent: 0
            }
        },
        liveRide: {
            session: null,
            isActive: false
        },
        statusText: ""
    };
}

export const suite = {
    name: "workout-service",
    tests: [
        {
            name: "updateErgTargetPower 会更新 settings.power 与 ERG runtime",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgTargetPower(278.4);
                const state = store.getState();

                assertEqual(state.settings.power, 278.4);
                assertEqual(state.workout.runtime.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assertEqual(state.workout.runtime.targetErgPowerWatts, 278);
            }
        },
        {
            name: "updateErgTargetPower 会按范围限制功率",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgTargetPower(10);
                assertEqual(store.getState().settings.power, 80);

                service.updateErgTargetPower(9999);
                assertEqual(store.getState().settings.power, 600);
            }
        },
        {
            name: "updateErgConfirmationMode 会更新 ERG 确认模式与 runtime",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgConfirmationMode(true);
                let state = store.getState();
                assertEqual(state.workout.erg.confirmationRequired, true);
                assertEqual(state.workout.runtime.ergConfirmationRequired, true);

                service.updateErgConfirmationMode(false);
                state = store.getState();
                assertEqual(state.workout.erg.confirmationRequired, false);
                assertEqual(state.workout.runtime.ergConfirmationRequired, false);
            }
        }
    ]
};
