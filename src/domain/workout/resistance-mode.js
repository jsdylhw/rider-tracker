import {
    createTrainerCommand,
    TRAINER_COMMAND_TYPES,
    TRAINER_CONTROL_MODES
} from "./trainer-command.js";

const DEFAULT_RESISTANCE_LEVEL = 35;

export function buildResistanceControlState({
    resistanceLevel = DEFAULT_RESISTANCE_LEVEL,
    previousResistanceLevel = null,
    active = false,
    rideId = null,
    commandSequence = 0
}) {
    const normalizedResistanceLevel = Math.max(0, Math.min(100, Math.round(Number(resistanceLevel) || 0)));
    const hasResistanceChanged = normalizedResistanceLevel !== previousResistanceLevel;

    return {
        available: true,
        trainerControlMode: TRAINER_CONTROL_MODES.RESISTANCE,
        currentGradePercent: 0,
        lookaheadGradePercent: 0,
        targetTrainerGradePercent: 0,
        targetErgPowerWatts: null,
        targetResistanceLevel: normalizedResistanceLevel,
        pendingTrainerCommand: active && hasResistanceChanged
            ? createTrainerCommand({
                controlMode: TRAINER_CONTROL_MODES.RESISTANCE,
                type: TRAINER_COMMAND_TYPES.SET_RESISTANCE,
                payload: {
                    resistanceLevel: normalizedResistanceLevel
                },
                rideId,
                sequence: commandSequence
            })
            : null,
        controlStatus: active
            ? `固定阻力控制中：阻力等级 ${normalizedResistanceLevel}%（开始骑行前已锁定控制模式）。`
            : `固定阻力待命：阻力等级 ${normalizedResistanceLevel}%（开始骑行前已锁定控制模式）。`
    };
}
