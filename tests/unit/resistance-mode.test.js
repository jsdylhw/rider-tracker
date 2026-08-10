import { buildResistanceControlState } from "../../src/domain/workout/resistance-mode.js";
import { TRAINER_COMMAND_TYPES, TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "resistance-mode",
    tests: [
        {
            name: "buildResistanceControlState emits resistance command when active",
            run() {
                const runtime = buildResistanceControlState({
                    resistanceLevel: 42.4,
                    active: true,
                    rideId: "ride-res",
                    commandSequence: 5
                });

                assertEqual(runtime.trainerControlMode, TRAINER_CONTROL_MODES.RESISTANCE);
                assertEqual(runtime.targetResistanceLevel, 42);
                assertEqual(runtime.pendingTrainerCommand.protocolVersion, 1);
                assertEqual(runtime.pendingTrainerCommand.type, TRAINER_COMMAND_TYPES.SET_RESISTANCE);
                assertEqual(runtime.pendingTrainerCommand.payload.resistanceLevel, 42);
                assertEqual(runtime.pendingTrainerCommand.rideId, "ride-res");
                assertEqual(runtime.pendingTrainerCommand.sequence, 5);
            }
        }
    ]
};
