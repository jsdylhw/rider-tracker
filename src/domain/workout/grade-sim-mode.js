import { getRouteSampleAtDistance } from "../route/route-builder.js";

const DEFAULT_LOOKAHEAD_STEP_METERS = 20;

export function buildGradeSimulationState({ route, distanceMeters, previousTargetGradePercent = 0, config }) {
    if (!route || route.totalDistanceMeters <= 0) {
        return createUnavailableState("未选择路线，无法计算坡度模拟。");
    }

    if (route.hasElevationData === false) {
        return createUnavailableState("当前路线缺少海拔数据，坡度模拟不可用。");
    }

    const currentSample = getRouteSampleAtDistance(route, distanceMeters);
    const currentGradePercent = currentSample.gradePercent ?? 0;
    const lookaheadGradePercent = calculateLookaheadGrade(route, distanceMeters, config.lookaheadMeters);
    const blendedGrade = blendGrades(currentGradePercent, lookaheadGradePercent);
    const difficultyScaledGrade = blendedGrade * (config.difficultyPercent / 100);
    const boundedTargetGrade = clampGrade(difficultyScaledGrade, config.maxDownhillPercent, config.maxUphillPercent);
    const targetTrainerGradePercent = smoothGrade(previousTargetGradePercent, boundedTargetGrade, config.smoothingFactor);

    return {
        available: true,
        currentGradePercent,
        lookaheadGradePercent,
        targetTrainerGradePercent,
        pendingTrainerCommand: {
            type: "set-sim-grade",
            gradePercent: targetTrainerGradePercent
        },
        controlStatus: `坡度模拟中：直接使用当前路线实时梯度。当前坡度 ${formatSignedGrade(currentGradePercent)}，前方坡度 ${formatSignedGrade(lookaheadGradePercent)}，目标模拟坡度 ${formatSignedGrade(targetTrainerGradePercent)}`
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

function blendGrades(currentGradePercent, lookaheadGradePercent) {
    return currentGradePercent * 0.65 + lookaheadGradePercent * 0.35;
}

function smoothGrade(previousTargetGradePercent, nextTargetGradePercent, smoothingFactor) {
    return previousTargetGradePercent + (nextTargetGradePercent - previousTargetGradePercent) * smoothingFactor;
}

function clampGrade(value, minDownhillPercent, maxUphillPercent) {
    return Math.min(maxUphillPercent, Math.max(minDownhillPercent, value));
}

function createUnavailableState(controlStatus) {
    return {
        available: false,
        currentGradePercent: 0,
        lookaheadGradePercent: 0,
        targetTrainerGradePercent: 0,
        pendingTrainerCommand: null,
        controlStatus
    };
}

function formatSignedGrade(value) {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}
