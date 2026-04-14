import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { buildGradeSimulationState } from "../../domain/workout/grade-sim-mode.js";
import { buildErgControlState } from "../../domain/workout/erg-mode.js";
import { buildResistanceControlState } from "../../domain/workout/resistance-mode.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { clamp } from "../../shared/utils/common.js";

export function createWorkoutService({ store }) {
    function updateWorkoutMode(mode) {
        const normalizedMode = mode === WORKOUT_MODES.GRADE_SIM
            ? WORKOUT_MODES.GRADE_SIM
            : mode === WORKOUT_MODES.FIXED_POWER
                ? WORKOUT_MODES.FIXED_POWER
                : WORKOUT_MODES.FREE_RIDE;

        store.setState((state) => ({
            ...state,
            workout: {
                ...state.workout,
                mode: normalizedMode,
                runtime: deriveRuntime(state, normalizedMode, state.workout.gradeSimulation)
            }
        }));
    }

    function updateGradeSimulationConfig(partialConfig) {
        store.setState((state) => {
            const current = state.workout.gradeSimulation;

            return {
                ...state,
                workout: {
                    ...state.workout,
                    gradeSimulation: {
                        difficultyPercent: clamp(partialConfig.difficultyPercent ?? current.difficultyPercent, 30, 150, current.difficultyPercent),
                        lookaheadMeters: clamp(partialConfig.lookaheadMeters ?? current.lookaheadMeters, 30, 500, current.lookaheadMeters),
                        maxUphillPercent: clamp(partialConfig.maxUphillPercent ?? current.maxUphillPercent, 3, 20, current.maxUphillPercent),
                        maxDownhillPercent: clamp(partialConfig.maxDownhillPercent ?? current.maxDownhillPercent, -10, 0, current.maxDownhillPercent),
                        smoothingFactor: clamp(partialConfig.smoothingFactor ?? current.smoothingFactor, 0.05, 1, current.smoothingFactor)
                    },
                    runtime: deriveRuntime(state, state.workout.mode, {
                        difficultyPercent: clamp(partialConfig.difficultyPercent ?? current.difficultyPercent, 30, 150, current.difficultyPercent),
                        lookaheadMeters: clamp(partialConfig.lookaheadMeters ?? current.lookaheadMeters, 30, 500, current.lookaheadMeters),
                        maxUphillPercent: clamp(partialConfig.maxUphillPercent ?? current.maxUphillPercent, 3, 20, current.maxUphillPercent),
                        maxDownhillPercent: clamp(partialConfig.maxDownhillPercent ?? current.maxDownhillPercent, -10, 0, current.maxDownhillPercent),
                        smoothingFactor: clamp(partialConfig.smoothingFactor ?? current.smoothingFactor, 0.05, 1, current.smoothingFactor)
                    })
                }
            };
        });
    }

    return {
        updateWorkoutMode,
        updateGradeSimulationConfig
    };
}

function deriveRuntime(state, mode, gradeSimulation) {
    const trainerControlMode = resolveTrainerControlModeForWorkoutMode(mode);

    if (trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return buildResistanceControlState({
            active: false
        });
    }

    if (trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return buildErgControlState({
            targetPowerWatts: state.settings.power,
            active: false
        });
    }

    const liveDistanceMeters = (state.liveRide.session?.summary?.distanceKm ?? 0) * 1000;
    const preview = buildGradeSimulationState({
        route: state.liveRide.session?.route ?? state.route,
        distanceMeters: liveDistanceMeters,
        previousTargetGradePercent: state.workout.runtime.targetTrainerGradePercent ?? 0,
        config: gradeSimulation,
        active: false
    });

    return state.liveRide.isActive
        ? preview
        : {
            ...preview,
            pendingTrainerCommand: null,
            controlStatus: preview.available
                ? `坡度模拟待命：已基于当前路线实时梯度生成目标模拟坡度，开始骑行后按预先锁定模式下发 trainer 指令。`
                : preview.controlStatus
        };
}
