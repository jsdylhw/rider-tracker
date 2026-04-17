import { getRouteSampleAtDistance } from "../route/route-builder.js";
import {
    createTrainerCommand,
    TRAINER_COMMAND_TYPES,
    TRAINER_CONTROL_MODES
} from "./trainer-command.js";

const DEFAULT_LOOKAHEAD_STEP_METERS = 20;

export function buildGradeSimulationState({
    route,
    distanceMeters,
    previousTargetGradePercent = 0,
    config,
    active = false,
    rideId = null,
    commandSequence = 0
}) {
    if (!route || route.totalDistanceMeters <= 0) {
        return createUnavailableState("未选择路线，无法计算坡度模拟。");
    }

    if (route.hasElevationData === false) {
        return createUnavailableState("当前路线缺少海拔数据，坡度模拟不可用。");
    }

    const currentSample = getRouteSampleAtDistance(route, distanceMeters);
    const currentGradePercent = currentSample.gradePercent ?? 0;
    const lookaheadGradePercent = calculateLookaheadGrade(route, distanceMeters, config.lookaheadMeters);
    
    // 应用平滑因子和骑行台真实度 (Trainer Difficulty)
    const rawTargetGrade = (currentGradePercent * config.smoothingFactor) + (lookaheadGradePercent * (1 - config.smoothingFactor));
    const difficultyRatio = (config.difficultyPercent ?? 100) / 100;
    const scaledGrade = rawTargetGrade * difficultyRatio;

    const targetTrainerGradePercent = clampGrade(
        scaledGrade,
        config.maxDownhillPercent,
        config.maxUphillPercent
    );

    return {
        available: true,
        trainerControlMode: TRAINER_CONTROL_MODES.SIM,
        currentGradePercent,
        lookaheadGradePercent,
        targetTrainerGradePercent,
        targetErgPowerWatts: null,
        targetResistanceLevel: null,
        pendingTrainerCommand: active && Math.abs(targetTrainerGradePercent - previousTargetGradePercent) >= 0.05
            ? createTrainerCommand({
                controlMode: TRAINER_CONTROL_MODES.SIM,
                type: TRAINER_COMMAND_TYPES.SET_SIM_GRADE,
                payload: {
                    gradePercent: targetTrainerGradePercent
                },
                rideId,
                sequence: commandSequence
            })
            : null,
        controlStatus: active
            ? `坡度模拟中：当前坡度 ${formatSignedGrade(currentGradePercent)}，前方坡度 ${formatSignedGrade(lookaheadGradePercent)}，目标模拟坡度 ${formatSignedGrade(targetTrainerGradePercent)}（实时跟随当前坡度）。`
            : `坡度模拟待命：当前坡度 ${formatSignedGrade(currentGradePercent)}，前方坡度 ${formatSignedGrade(lookaheadGradePercent)}，预估目标模拟坡度 ${formatSignedGrade(targetTrainerGradePercent)}（实时跟随当前坡度）。`
    };
}

function calculateLookaheadGrade(route, distanceMeters, lookaheadMeters) {
    const totalDistance = Math.min(route.totalDistanceMeters, distanceMeters + lookaheadMeters);

    if (totalDistance <= distanceMeters) {
        return getRouteSampleAtDistance(route, distanceMeters).gradePercent ?? 0;
    }

    let totalWeightedGrade = 0;
    let totalWeight = 0;

    for (let sampleDistance = distanceMeters; sampleDistance < totalDistance; sampleDistance += DEFAULT_LOOKAHEAD_STEP_METERS) {
        const nextDistance = Math.min(totalDistance, sampleDistance + DEFAULT_LOOKAHEAD_STEP_METERS);
        const sample = getRouteSampleAtDistance(route, sampleDistance);
        const weight = nextDistance - sampleDistance;

        totalWeightedGrade += (sample.gradePercent ?? 0) * weight;
        totalWeight += weight;
    }

    return totalWeight > 0 ? totalWeightedGrade / totalWeight : 0;
}

function clampGrade(value, minDownhillPercent, maxUphillPercent) {
    return Math.min(maxUphillPercent, Math.max(minDownhillPercent, value));
}

function createUnavailableState(controlStatus) {
    return {
        available: false,
        trainerControlMode: TRAINER_CONTROL_MODES.SIM,
        currentGradePercent: 0,
        lookaheadGradePercent: 0,
        targetTrainerGradePercent: 0,
        targetErgPowerWatts: null,
        targetResistanceLevel: null,
        pendingTrainerCommand: null,
        controlStatus
    };
}

function formatSignedGrade(value) {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}
