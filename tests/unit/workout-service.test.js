import { createStore } from "../../src/app/store/app-store.js";
import { createWorkoutService } from "../../src/app/services/workout-service.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual } from "../helpers/test-harness.js";

function createBaseState(mode = WORKOUT_MODES.FIXED_POWER) {
    return {
        settings: {
            power: 220,
            ftp: 250
        },
        route: {
            totalDistanceMeters: 1000,
            hasElevationData: true,
            points: [{ distanceMeters: 0, gradePercent: 2 }],
            source: "manual",
            name: "测试路线",
            segments: []
        },
        workout: {
            mode,
            erg: {
                confirmationRequired: false
            },
            gradeSimulation: {
                difficultyPercent: 75,
                lookaheadMeters: 120,
                maxUphillPercent: 10,
                maxDownhillPercent: -3,
                smoothingFactor: 0.35
            },
            runtime: {
                targetTrainerGradePercent: 0
            },
            customWorkoutTarget: {
                enabled: false,
                steps: []
            }
        },
        liveRide: {
            session: null,
            isActive: false
        },
        statusText: ""
    };
}

export const suite = {
    name: "workout-service",
    tests: [
        {
            name: "updateErgTargetPower 会更新 settings.power 与 ERG runtime",
            async run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgTargetPower(278.4);
                const state = store.getState();

                assertEqual(state.settings.power, 278.4);
                assertEqual(state.workout.runtime.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assertEqual(state.workout.runtime.targetErgPowerWatts, 278);
            }
        },
        {
            name: "updateErgTargetPower 会按范围限制功率",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgTargetPower(10);
                assertEqual(store.getState().settings.power, 80);

                service.updateErgTargetPower(9999);
                assertEqual(store.getState().settings.power, 600);
            }
        },
        {
            name: "updateErgConfirmationMode 会更新 ERG 确认模式与 runtime",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.updateErgConfirmationMode(true);
                let state = store.getState();
                assertEqual(state.workout.erg.confirmationRequired, true);
                assertEqual(state.workout.runtime.ergConfirmationRequired, true);

                service.updateErgConfirmationMode(false);
                state = store.getState();
                assertEqual(state.workout.erg.confirmationRequired, false);
                assertEqual(state.workout.runtime.ergConfirmationRequired, false);
            }
        },
        {
            name: "updateWorkoutMode 会尝试按训练模式预激活 trainer 控制",
            async run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FREE_RIDE));
                const invokedModes = [];
                const service = createWorkoutService({
                    store,
                    deviceService: {
                        async prepareTrainerControlForWorkoutMode(mode) {
                            invokedModes.push(mode);
                            return true;
                        }
                    }
                });

                await service.updateWorkoutMode(WORKOUT_MODES.GRADE_SIM);

                assertEqual(store.getState().workout.mode, WORKOUT_MODES.GRADE_SIM);
                assertEqual(invokedModes.length, 1);
                assertEqual(invokedModes[0], WORKOUT_MODES.GRADE_SIM);
            }
        },
        {
            name: "骑行中模式切换会原子更新 session 并清理命令去重状态",
            async run() {
                const state = createBaseState(WORKOUT_MODES.FREE_RIDE);
                state.liveRide = {
                    isActive: true,
                    session: { startedAt: "ride-1", trainerControlMode: "resistance", commandSequence: 2, customWorkoutTargetPlan: { enabled: false, steps: [] } },
                    summary: { metrics: { ride: { elapsedSeconds: 30, distanceKm: 0.2 } } },
                    commandDispatch: { lastSentControlMode: "resistance", lastSentResistanceLevel: 35, inFlightCommandKey: "resistance:35" }
                };
                const store = createStore(state);
                const service = createWorkoutService({ store, deviceService: {
                    async prepareTrainerControlForWorkoutMode() { return true; }
                } });

                await service.updateWorkoutMode(WORKOUT_MODES.FIXED_POWER);

                assertEqual(store.getState().workout.mode, WORKOUT_MODES.FIXED_POWER);
                assertEqual(store.getState().liveRide.session.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assertEqual(store.getState().liveRide.commandDispatch.lastSentControlMode, null);
                assertEqual(store.getState().liveRide.commandDispatch.inFlightCommandKey, null);
            }
        },
        {
            name: "骑行中目标模式激活失败会保留原模式",
            async run() {
                const state = createBaseState(WORKOUT_MODES.FREE_RIDE);
                state.liveRide = { isActive: true, session: { trainerControlMode: "resistance" } };
                const store = createStore(state);
                const service = createWorkoutService({ store, deviceService: {
                    async prepareTrainerControlForWorkoutMode() { return false; }
                } });

                await service.updateWorkoutMode(WORKOUT_MODES.FIXED_POWER);

                assertEqual(store.getState().workout.mode, WORKOUT_MODES.FREE_RIDE);
                assertEqual(store.getState().liveRide.session.trainerControlMode, "resistance");
                assertEqual(store.getState().workout.modeTransition.status, "error");
            }
        },
        {
            name: "applyCustomWorkoutTargetPreset 会套用预设 ERG 课程",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.applyCustomWorkoutTargetPreset("ramp-test");
                const state = store.getState();

                assertEqual(state.workout.customWorkoutTarget.enabled, true);
                assertEqual(state.workout.customWorkoutTarget.source, "preset");
                assertEqual(state.workout.customWorkoutTarget.presetKey, "ramp-test");
                assertEqual(state.workout.customWorkoutTarget.steps.length, 3);
                assertEqual(state.workout.customWorkoutTarget.steps[1].blockType, "ramp-up");
                assertEqual(state.workout.runtime.customWorkoutTargetEnabled, true);
                assertEqual(state.statusText, "已套用预设训练课程。");
            }
        },
        {
            name: "editCustomWorkoutTarget 会切换回可编辑自定义课程",
            run() {
                const store = createStore(createBaseState(WORKOUT_MODES.FIXED_POWER));
                const service = createWorkoutService({ store });

                service.applyCustomWorkoutTargetPreset("ramp-test");
                service.editCustomWorkoutTarget();
                const state = store.getState();

                assertEqual(state.workout.customWorkoutTarget.enabled, true);
                assertEqual(state.workout.customWorkoutTarget.source, "custom");
                assertEqual(state.workout.customWorkoutTarget.presetKey, null);
                assertEqual(state.workout.customWorkoutTarget.steps.length, 3);
                assertEqual(state.statusText, "已切换为自定义训练课程。");
            }
        }
    ]
};
