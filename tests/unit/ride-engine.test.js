import { buildNextRideSessionState, buildInitialRideSessionState } from "../../src/app/realtime/ride-engine.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { createLiveRideSession } from "../../src/domain/ride/live-ride-session.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function makeBaseState(mode, overrides = {}) {
    return {
        route: {
            totalDistanceMeters: 10000,
            name: "Test Route",
            segments: [{ name: "Test Segment", distanceKm: 10, gradePercent: 3 }],
            points: [
                { latitude: 31.0, longitude: 121.0, distanceMeters: 0, gradePercent: 3, elevationMeters: 0 },
                { latitude: 31.1, longitude: 121.1, distanceMeters: 5000, gradePercent: 5, elevationMeters: 100 },
                { latitude: 31.2, longitude: 121.2, distanceMeters: 10000, gradePercent: -2, elevationMeters: 50 }
            ]
        },
        settings: { power: 220, ftp: 250, mass: 78, restingHr: 58, maxHr: 182, cda: 0.35, crr: 0.004, windSpeed: 0 },
        workout: {
            mode,
            gradeSimulation: { difficultyPercent: 100, lookaheadMeters: 120, maxUphillPercent: 20, maxDownhillPercent: -5, smoothingFactor: 0.7 },
            erg: { confirmationRequired: false },
            resistance: { level: 35 },
            customWorkoutTarget: { enabled: false, steps: [], totalSeconds: 0 },
            runtime: {
                available: false, trainerControlMode: TRAINER_CONTROL_MODES.SIM,
                currentGradePercent: 0, lookaheadGradePercent: 0, targetTrainerGradePercent: 0,
                targetErgPowerWatts: null, targetResistanceLevel: 35,
                customWorkoutTargetEnabled: false
            }
        },
        liveRide: {
            isActive: true,
            canStart: false,
            dashboardOpen: true,
            session: null,
            records: [],
            summary: null,
            commandDispatch: {
                lastSentAtMs: null, lastAttemptedAtMs: null,
                lastSentControlMode: null, lastSentGradePercent: 0,
                lastSentPowerWatts: null, lastSentResistanceLevel: null, inFlightCommandKey: null
            },
            statusMeta: ""
        },
        ...overrides
    };
}

function applyRideState(state, result) {
    state.liveRide.session = result.session;
    state.liveRide.records = result.records;
    state.liveRide.summary = result.summary;
}

function initSessionForMode(state, mode) {
    const tm = resolveTrainerControlModeForWorkoutMode(mode);
    state.workout.mode = mode;
    const session = createLiveRideSession({
        route: state.route, settings: state.settings,
        startedAt: new Date().toISOString(), initialHeartRate: null
    });
    const initialRideState = buildInitialRideSessionState({
        session,
        sampledSensors: { power: 200, heartRate: 120, cadence: 85 },
        trainerControlMode: tm,
        customWorkoutTargetPlan: state.workout.customWorkoutTarget,
        workoutRuntime: state.workout.runtime,
        statusMeta: ""
    });
    state.liveRide.session = initialRideState.session;
    state.liveRide.records = initialRideState.records;
    state.liveRide.summary = initialRideState.summary;
}

export const suite = {
    name: "ride-engine",
    tests: [
        {
            name: "GRADE_SIM start produces SIM trainerControlMode",
            run() {
                const state = makeBaseState(WORKOUT_MODES.GRADE_SIM);
                initSessionForMode(state, WORKOUT_MODES.GRADE_SIM);

                const result = buildNextRideSessionState({
                    state,
                    sampledSensors: { power: 200, heartRate: 120, cadence: 85 },
                    dt: 1
                });

                assertEqual(result.session.trainerControlMode, TRAINER_CONTROL_MODES.SIM);
            }
        },
        {
            name: "FIXED_POWER start produces ERG trainerControlMode with command",
            run() {
                const state = makeBaseState(WORKOUT_MODES.FIXED_POWER);
                initSessionForMode(state, WORKOUT_MODES.FIXED_POWER);

                const result = buildNextRideSessionState({
                    state,
                    sampledSensors: { power: 200, heartRate: 120, cadence: 85 },
                    dt: 1
                });

                assertEqual(result.session.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assert(result.session.pendingTrainerCommand != null, "should have pending ERG command");
            }
        },
        {
            name: "switching workout.mode mid-ride from GRADE_SIM to FIXED_POWER changes trainerControlMode",
            run() {
                const state = makeBaseState(WORKOUT_MODES.GRADE_SIM);
                initSessionForMode(state, WORKOUT_MODES.GRADE_SIM);

                // Tick once to simulate a ride
                const r1 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, r1);

                // Switch to FIXED_POWER mid-ride
                state.workout.mode = WORKOUT_MODES.FIXED_POWER;

                const result = buildNextRideSessionState({
                    state,
                    sampledSensors: { power: 200, heartRate: 120, cadence: 85 },
                    dt: 1
                });

                assertEqual(result.session.trainerControlMode, TRAINER_CONTROL_MODES.ERG,
                    "trainerControlMode should follow workout.mode after mid-ride switch");
            }
        },
        {
            name: "mode change forces first ERG command even if power matches previous mode",
            run() {
                const state = makeBaseState(WORKOUT_MODES.GRADE_SIM);
                initSessionForMode(state, WORKOUT_MODES.GRADE_SIM);

                // Tick once in SIM mode
                const r1 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, r1);

                // Record what was sent
                state.liveRide.commandDispatch.lastSentPowerWatts = 220;
                state.liveRide.commandDispatch.lastSentControlMode = TRAINER_CONTROL_MODES.SIM;

                // Switch to FIXED_POWER — even if ERG target (220W) matches lastSentPowerWatts
                state.workout.mode = WORKOUT_MODES.FIXED_POWER;
                state.settings.power = 220;

                const r2 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });

                assertEqual(r2.session.trainerControlMode, TRAINER_CONTROL_MODES.ERG);
                assert(r2.session.pendingTrainerCommand != null,
                    "mode switch should force ERG command even when power matches old value");
            }
        },
        {
            name: "FIXED_POWER to GRADE_SIM mode switch forces SIM command even at 0% grade",
            run() {
                const state = makeBaseState(WORKOUT_MODES.FIXED_POWER);
                initSessionForMode(state, WORKOUT_MODES.FIXED_POWER);

                // Tick once in ERG
                const r1 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, r1);
                state.liveRide.commandDispatch.lastSentGradePercent = 0;
                state.liveRide.commandDispatch.lastSentControlMode = TRAINER_CONTROL_MODES.ERG;

                // Switch to GRADE_SIM with a route that gives 0% at start
                state.workout.mode = WORKOUT_MODES.GRADE_SIM;
                state.route.points[0].gradePercent = 0;

                const result = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });

                assertEqual(result.session.trainerControlMode, TRAINER_CONTROL_MODES.SIM);
                assert(result.session.pendingTrainerCommand != null,
                    "SIM switch should force grade command even at 0% grade");
            }
        },
        {
            name: "ERG mode mid-ride always reads customWorkoutTarget from state",
            run() {
                const state = makeBaseState(WORKOUT_MODES.FIXED_POWER);
                state.workout.customWorkoutTarget = {
                    enabled: true,
                    steps: [{ label: "pace", durationMinutes: 5, ftpPercent: 80, blockType: "steady" }],
                    totalSeconds: 300
                };
                initSessionForMode(state, WORKOUT_MODES.FIXED_POWER);

                // Tick once with initial target
                const rInit = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, rInit);

                // Modify custom workout target mid-ride: change the step
                state.workout.customWorkoutTarget = {
                    enabled: true,
                    steps: [{ label: "hard", durationMinutes: 5, ftpPercent: 95, blockType: "steady" }],
                    totalSeconds: 300
                };

                const result = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                // session.customWorkoutTargetPlan should be refreshed from state
                const plan = result.session.customWorkoutTargetPlan;
                assert(plan && plan.steps && plan.steps[0].ftpPercent === 95,
                    `customWorkoutTargetPlan should use updated state with 95% step, got ftpPercent=${plan?.steps?.[0]?.ftpPercent}`);
            }
        },
        {
            name: "ERG commands are produced when target power changes",
            run() {
                const state = makeBaseState(WORKOUT_MODES.FIXED_POWER);
                initSessionForMode(state, WORKOUT_MODES.FIXED_POWER);

                // First tick: power 200
                const r1 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, r1);
                assert(r1.session.pendingTrainerCommand != null, "first tick should produce ERG command at 220W");

                // Dispatch the command (simulating ride-service dispatch)
                state.liveRide.commandDispatch.lastSentPowerWatts = 220;
                state.liveRide.commandDispatch.lastSentControlMode = TRAINER_CONTROL_MODES.ERG;

                // Second tick: same power → no command
                state.settings.power = 220;
                const r2 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                applyRideState(state, r2);
                assertEqual(r2.session.pendingTrainerCommand, null, "same power should not produce command");

                // Third tick: user changes ERG power to 250
                state.settings.power = 250;
                const r3 = buildNextRideSessionState({ state, sampledSensors: { power: 200, heartRate: 120, cadence: 85 }, dt: 1 });
                assert(r3.session.pendingTrainerCommand != null, "changed ERG power should produce new command");
            }
        }
    ]
};
