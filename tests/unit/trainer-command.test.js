import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { createTrainerCommand, resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
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
        },
        {
            name: "createTrainerCommand preserves confirmation flag",
            run() {
                const command = createTrainerCommand({
                    controlMode: TRAINER_CONTROL_MODES.ERG,
                    type: "set-erg-power",
                    payload: { targetPowerWatts: 250 },
                    requireConfirmation: true
                });

                assertEqual(command.requireConfirmation, true);
            }
        }
    ]
};
