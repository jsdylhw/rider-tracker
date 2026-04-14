import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "trainer-command",
    tests: [
        {
            name: "resolveTrainerControlModeForWorkoutMode maps three workout modes",
            run() {
                assertEqual(
                    resolveTrainerControlModeForWorkoutMode(WORKOUT_MODES.FREE_RIDE),
                    TRAINER_CONTROL_MODES.RESISTANCE
                );
                assertEqual(
                    resolveTrainerControlModeForWorkoutMode(WORKOUT_MODES.FIXED_POWER),
                    TRAINER_CONTROL_MODES.ERG
                );
                assertEqual(
                    resolveTrainerControlModeForWorkoutMode(WORKOUT_MODES.GRADE_SIM),
                    TRAINER_CONTROL_MODES.SIM
                );
            }
        }
    ]
};
