import {
    createTrainerCommand,
    TRAINER_COMMAND_TYPES,
    TRAINER_CONTROL_MODES
} from "./trainer-command.js";

export function buildErgControlState({
    targetPowerWatts,
    previousTargetPowerWatts = null,
    confirmationRequired = false,
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
        ergConfirmationRequired: confirmationRequired,
        pendingTrainerCommand: active && hasTargetChanged
            ? createTrainerCommand({
                controlMode: TRAINER_CONTROL_MODES.ERG,
                type: TRAINER_COMMAND_TYPES.SET_ERG_POWER,
                requireConfirmation: confirmationRequired,
                payload: {
                    targetPowerWatts: normalizedTargetPower
                },
                rideId,
                sequence: commandSequence
            })
            : null,
        controlStatus: active
            ? `ERG 控制中：目标功率 ${normalizedTargetPower} W，${confirmationRequired ? "已启用确认模式" : "使用快速下发模式"}（开始骑行前已锁定控制模式）。`
            : `ERG 待命：目标功率 ${normalizedTargetPower} W，${confirmationRequired ? "已启用确认模式" : "使用快速下发模式"}（开始骑行前已锁定控制模式）。`
    };
}
