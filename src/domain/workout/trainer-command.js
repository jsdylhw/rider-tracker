import { WORKOUT_MODES } from "./workout-mode.js";

export const TRAINER_COMMAND_PROTOCOL_VERSION = 1;

export const TRAINER_CONTROL_MODES = {
    RESISTANCE: "resistance",
    ERG: "erg",
    SIM: "sim"
};

export const TRAINER_COMMAND_TYPES = {
    SET_RESISTANCE: "set-resistance",
    SET_ERG_POWER: "set-erg-power",
    SET_SIM_GRADE: "set-sim-grade"
};

export function resolveTrainerControlModeForWorkoutMode(workoutMode) {
    if (workoutMode === WORKOUT_MODES.GRADE_SIM) {
        return TRAINER_CONTROL_MODES.SIM;
    }

    if (workoutMode === WORKOUT_MODES.FIXED_POWER) {
        return TRAINER_CONTROL_MODES.ERG;
    }

    return TRAINER_CONTROL_MODES.RESISTANCE;
}

export function createTrainerCommand({
    controlMode,
    type,
    payload,
    rideId,
    sequence = 0,
    source = "live-ride-loop",
    requireConfirmation = false
}) {
    return {
        protocolVersion: TRAINER_COMMAND_PROTOCOL_VERSION,
        decisionPolicy: "pre-ride-locked",
        controlMode,
        type,
        payload,
        rideId,
        sequence,
        source,
        requireConfirmation,
        createdAtMs: Date.now()
    };
}
