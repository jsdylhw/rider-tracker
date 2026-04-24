import {
    createTrainerCommand,
    TRAINER_COMMAND_TYPES,
    TRAINER_CONTROL_MODES
} from "./trainer-command.js";

export function buildErgControlState({
    targetPowerWatts,
    previousTargetPowerWatts = null,
    active = false,
    rideId = null,
    commandSequence = 0
}) {
    const normalizedTargetPower = Math.max(0, Math.round(Number(targetPowerWatts) || 0));
    const hasTargetChanged = normalizedTargetPower !== previousTargetPowerWatts;

    return {
        available: true,
        trainerControlMode: TRAINER_CONTROL_MODES.ERG,
        currentGradePercent: 0,
        lookaheadGradePercent: 0,
        targetTrainerGradePercent: 0,
        targetErgPowerWatts: normalizedTargetPower,
        targetResistanceLevel: null,
        pendingTrainerCommand: active && hasTargetChanged
            ? createTrainerCommand({
                controlMode: TRAINER_CONTROL_MODES.ERG,
                type: TRAINER_COMMAND_TYPES.SET_ERG_POWER,
                payload: {
                    targetPowerWatts: normalizedTargetPower
                },
                rideId,
                sequence: commandSequence
            })
            : null,
        controlStatus: active
            ? `ERG 控制中：目标功率 ${normalizedTargetPower} W（开始骑行前已锁定控制模式）。`
            : `ERG 待命：目标功率 ${normalizedTargetPower} W（开始骑行前已锁定控制模式）。`
    };
}
