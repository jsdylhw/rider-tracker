import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { buildGradeSimulationState } from "../../domain/workout/grade-sim-mode.js";
import { buildErgControlState } from "../../domain/workout/erg-mode.js";
import { buildResistanceControlState } from "../../domain/workout/resistance-mode.js";
import {
    buildWorkoutTargetRuntime,
    createWorkoutTargetStep,
    enrichRuntimeWithWorkoutTarget,
    sanitizeCustomWorkoutTarget
} from "../../domain/workout/custom-workout-target.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { clamp } from "../../shared/utils/common.js";

export function createWorkoutService({ store, deviceService = null }) {
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
                runtime: deriveRuntime(state, normalizedMode, state.workout.gradeSimulation, state.workout.customWorkoutTarget)
            }
        }));

        if (deviceService?.prepareTrainerControlForWorkoutMode) {
            void deviceService.prepareTrainerControlForWorkoutMode(normalizedMode);
        }
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
                    }, state.workout.customWorkoutTarget)
                }
            };
        });
    }

    function updateErgTargetPower(powerWatts) {
        store.setState((state) => {
            const normalizedPower = clamp(Number(powerWatts), 80, 600, state.settings.power);
            const nextSettings = {
                ...state.settings,
                power: normalizedPower
            };

            return {
                ...state,
                settings: nextSettings,
                workout: {
                    ...state.workout,
                    runtime: deriveRuntime(
                        { ...state, settings: nextSettings },
                        state.workout.mode,
                        state.workout.gradeSimulation,
                        state.workout.customWorkoutTarget
                    )
                },
                statusText: `目标功率已更新为 ${Math.round(normalizedPower)} W`
            };
        });
    }

    function updateErgConfirmationMode(enabled) {
        store.setState((state) => {
            const nextErg = {
                ...state.workout.erg,
                confirmationRequired: Boolean(enabled)
            };

            return {
                ...state,
                workout: {
                    ...state.workout,
                    erg: nextErg,
                    runtime: deriveRuntime(
                        { ...state, workout: { ...state.workout, erg: nextErg } },
                        state.workout.mode,
                        state.workout.gradeSimulation,
                        state.workout.customWorkoutTarget
                    )
                },
                statusText: nextErg.confirmationRequired
                    ? "已启用 ERG 确认模式。"
                    : "已关闭 ERG 确认模式。"
            };
        });
    }

    function updateResistanceLevel(resistanceLevel) {
        store.setState((state) => {
            const normalizedResistance = clamp(Number(resistanceLevel), 0, 100, state.workout.resistance?.level ?? 35);
            const nextResistance = {
                ...state.workout.resistance,
                level: Math.round(normalizedResistance)
            };

            return {
                ...state,
                workout: {
                    ...state.workout,
                    resistance: nextResistance,
                    runtime: deriveRuntime(
                        { ...state, workout: { ...state.workout, resistance: nextResistance } },
                        state.workout.mode,
                        state.workout.gradeSimulation,
                        state.workout.customWorkoutTarget
                    )
                },
                statusText: `固定阻力已更新为 ${nextResistance.level}%`
            };
        });
    }

    function updateCustomWorkoutTargetEnabled(enabled) {
        store.setState((state) => {
            const nextTarget = sanitizeCustomWorkoutTarget({
                ...state.workout.customWorkoutTarget,
                enabled
            });

            return {
                ...state,
                workout: {
                    ...state.workout,
                    customWorkoutTarget: nextTarget,
                    runtime: deriveRuntime(state, state.workout.mode, state.workout.gradeSimulation, nextTarget)
                },
                statusText: enabled ? "已启用自定义训练目标。" : "已关闭自定义训练目标。"
            };
        });
    }

    function addCustomWorkoutTargetStep() {
        store.setState((state) => {
            const nextTarget = sanitizeCustomWorkoutTarget({
                ...state.workout.customWorkoutTarget,
                steps: [
                    ...state.workout.customWorkoutTarget.steps,
                    createWorkoutTargetStep()
                ]
            });

            return {
                ...state,
                workout: {
                    ...state.workout,
                    customWorkoutTarget: nextTarget,
                    runtime: deriveRuntime(state, state.workout.mode, state.workout.gradeSimulation, nextTarget)
                },
                statusText: "已新增一个训练目标阶段。"
            };
        });
    }

    function updateCustomWorkoutTargetStep(stepId, partialStep) {
        store.setState((state) => {
            const nextTarget = sanitizeCustomWorkoutTarget({
                ...state.workout.customWorkoutTarget,
                steps: state.workout.customWorkoutTarget.steps.map((step) => step.id === stepId
                    ? { ...step, ...partialStep }
                    : step)
            });

            return {
                ...state,
                workout: {
                    ...state.workout,
                    customWorkoutTarget: nextTarget,
                    runtime: deriveRuntime(state, state.workout.mode, state.workout.gradeSimulation, nextTarget)
                }
            };
        });
    }

    function removeCustomWorkoutTargetStep(stepId) {
        store.setState((state) => {
            const nextTarget = sanitizeCustomWorkoutTarget({
                ...state.workout.customWorkoutTarget,
                steps: state.workout.customWorkoutTarget.steps.filter((step) => step.id !== stepId)
            });

            return {
                ...state,
                workout: {
                    ...state.workout,
                    customWorkoutTarget: nextTarget,
                    runtime: deriveRuntime(state, state.workout.mode, state.workout.gradeSimulation, nextTarget)
                },
                statusText: "已移除一个训练目标阶段。"
            };
        });
    }

    return {
        updateWorkoutMode,
        updateGradeSimulationConfig,
        updateErgTargetPower,
        updateErgConfirmationMode,
        updateResistanceLevel,
        updateCustomWorkoutTargetEnabled,
        addCustomWorkoutTargetStep,
        updateCustomWorkoutTargetStep,
        removeCustomWorkoutTargetStep
    };
}

function deriveRuntime(state, mode, gradeSimulation, customWorkoutTarget) {
    const trainerControlMode = resolveTrainerControlModeForWorkoutMode(mode);
    const activeWorkoutTarget = state.liveRide.customWorkoutTargetPlan ?? customWorkoutTarget;
    const workoutTargetRuntime = buildWorkoutTargetRuntime({
        target: activeWorkoutTarget,
        elapsedSeconds: state.liveRide.session?.summary?.elapsedSeconds ?? 0,
        ftp: state.settings.ftp
    });

    if (trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return enrichRuntimeWithWorkoutTarget(buildResistanceControlState({
            resistanceLevel: state.workout.resistance?.level,
            active: false
        }), workoutTargetRuntime);
    }

    if (trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return enrichRuntimeWithWorkoutTarget(buildErgControlState({
            targetPowerWatts: workoutTargetRuntime.customWorkoutTargetPowerWatts ?? state.settings.power,
            confirmationRequired: state.workout.erg?.confirmationRequired === true,
            active: false
        }), workoutTargetRuntime);
    }

    const liveDistanceMeters = (state.liveRide.session?.summary?.distanceKm ?? 0) * 1000;
    const preview = buildGradeSimulationState({
        route: state.liveRide.session?.route ?? state.route,
        distanceMeters: liveDistanceMeters,
        previousTargetGradePercent: state.workout.runtime.targetTrainerGradePercent ?? 0,
        config: gradeSimulation,
        active: false
    });

    const previewRuntime = state.liveRide.isActive
        ? preview
        : {
            ...preview,
            pendingTrainerCommand: null,
            controlStatus: preview.available
                ? `坡度模拟待命：已基于当前路线实时梯度生成目标模拟坡度，开始骑行后按预先锁定模式下发 trainer 指令。`
                : preview.controlStatus
        };

    return enrichRuntimeWithWorkoutTarget(previewRuntime, workoutTargetRuntime);
}
