import { buildErgControlState } from "../../src/domain/workout/erg-mode.js";
import { TRAINER_COMMAND_TYPES, TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "erg-mode",
    tests: [
        {
            name: "buildErgControlState emits pre-ride-locked ERG command when active",
            run() {
                const runtime = buildErgControlState({
                    targetPowerWatts: 223.8,
                    active: true,
                    rideId: "ride-erg",
                    commandSequence: 3
                });

                assertEqual(runtime.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assertEqual(runtime.targetErgPowerWatts, 224);
                assertEqual(runtime.pendingTrainerCommand.protocolVersion, 1);
                assertEqual(runtime.pendingTrainerCommand.controlMode, TRAINER_CONTROL_MODES.ERG);
                assertEqual(runtime.pendingTrainerCommand.type, TRAINER_COMMAND_TYPES.SET_ERG_POWER);
                assertEqual(runtime.pendingTrainerCommand.payload.targetPowerWatts, 224);
                assertEqual(runtime.pendingTrainerCommand.rideId, "ride-erg");
                assertEqual(runtime.pendingTrainerCommand.sequence, 3);
            }
        }
    ]
};
