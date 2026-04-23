import { createLiveRideSession } from "../../domain/ride/live-ride-session.js";
import { simulateRide } from "../../domain/ride/simulator.js";
import { buildEffectiveSensorSnapshot } from "../realtime/sensor-sampling.js";
import {
    sanitizeCustomWorkoutTarget
} from "../../domain/workout/custom-workout-target.js";
import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import {
    buildInitialRideSnapshot,
    buildNextRideSnapshot,
    buildRideLogMessage,
    buildRuntimeByControlMode
} from "../realtime/ride-engine.js";
import { saveLastSession } from "../../adapters/storage/session-storage.js";
import { formatNumber } from "../../shared/format.js";

const DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS = 250;
const ADAPTIVE_PHYSICS_TICK_BUCKETS_MS = [200, 250, 500, 1000];
const TRAINER_COMMAND_MIN_INTERVAL_MS = 500;

export function createRideService({ store, deviceService, exportService }) {
    let liveRideTimerId = null;
    let liveRideTickIntervalMs = DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS;

    function startRide() {
        const state = store.getState();
        if (!state.liveRide.canStart || state.liveRide.isActive) {
            return;
        }

        const startedAt = new Date().toISOString();
        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const sampledSensors = buildEffectiveSensorSnapshot(state.ble.sampling);
        const session = createLiveRideSession({
            route: state.route,
            settings: state.settings,
            startedAt,
            initialHeartRate: sampledSensors.heartRate
        });

        session.exportMetadata = state.exportMetadata;

        restartLiveRideLoop(resolveAdaptivePhysicsTickMs(sampledSensors));

        const initialStatusMeta = `正在根据实时功率和路线坡度更新速度，当前模式：${getWorkoutModeLabel(state.workout.mode)}。`;

        store.setState((currentState) => ({
            ...currentState,
            liveRide: {
                ...currentState.liveRide,
                isActive: true,
                dashboardOpen: true,
                snapshot: buildInitialRideSnapshot({
                    session,
                    sampledSensors,
                    trainerControlMode,
                    customWorkoutTargetPlan: sanitizeCustomWorkoutTarget(currentState.workout.customWorkoutTarget),
                    workoutRuntime: currentState.workout.runtime,
                    statusMeta: initialStatusMeta
                }),
                session,
                startedAt,
                trainerControlMode,
                customWorkoutTargetPlan: sanitizeCustomWorkoutTarget(currentState.workout.customWorkoutTarget),
                commandSequence: 0,
                commandDispatch: createInitialCommandDispatchState(),
                statusMeta: initialStatusMeta
            },
            statusText: `已开始骑行，当前训练模式：${getWorkoutModeLabel(currentState.workout.mode)}。`
        }));
    }

    function stopRide() {
        const state = store.getState();
        if (!state.liveRide.isActive) {
            return;
        }

        stopLiveRideLoop();

        const completedSession = state.liveRide.session
            ? {
                ...state.liveRide.session,
                finishedAt: new Date().toISOString()
            }
            : null;
        if (completedSession) {
            saveLastSession(completedSession);
        }

        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const stoppedRuntime = buildRuntimeByControlMode({
            trainerControlMode,
            state,
            active: false
        });
        const stoppedStatusMeta = completedSession
            ? `骑行结束：${formatNumber(completedSession.summary.distanceKm, 2)} km / 平均速度 ${formatNumber(completedSession.summary.averageSpeedKph, 1)} km/h`
            : "骑行已停止。";
        const stoppedSnapshot = completedSession
            ? buildInitialRideSnapshot({
                session: completedSession,
                sampledSensors: buildEffectiveSensorSnapshot(state.ble.sampling),
                trainerControlMode,
                customWorkoutTargetPlan: state.liveRide.customWorkoutTargetPlan,
                workoutRuntime: stoppedRuntime,
                statusMeta: stoppedStatusMeta
            })
            : null;

        store.setState((currentState) => ({
            ...currentState,
            session: completedSession ?? currentState.session,
            hasPersistedSession: Boolean(completedSession) || currentState.hasPersistedSession,
            workout: {
                ...currentState.workout,
                runtime: stoppedRuntime
            },
            liveRide: {
                ...currentState.liveRide,
                isActive: false,
                dashboardOpen: false,
                snapshot: stoppedSnapshot,
                trainerControlMode: null,
                customWorkoutTargetPlan: null,
                commandSequence: 0,
                commandDispatch: createInitialCommandDispatchState(),
                lastCompletedAt: new Date().toISOString(),
                statusMeta: stoppedStatusMeta
            },
            statusText: stoppedStatusMeta
        }));

        // Trigger automatic FIT download for real rides that have recorded distance
        if (completedSession && completedSession.summary.distanceKm > 0) {
            setTimeout(() => {
                exportService.downloadFit();
            }, 500); // Small delay to let UI state settle
        }
    }

    function tickLiveRide() {
        const state = store.getState();
        if (!state.liveRide.isActive || !state.liveRide.session) {
            stopLiveRideLoop();
            return;
        }

        const currentTickIntervalMs = liveRideTickIntervalMs;
        const sampledSensors = buildEffectiveSensorSnapshot(state.ble.sampling);
        const nextTickIntervalMs = resolveAdaptivePhysicsTickMs(sampledSensors);
        const rideSnapshot = buildNextRideSnapshot({
            state,
            sampledSensors,
            dt: currentTickIntervalMs / 1000
        });

        const now = Date.now();
        const shouldDispatchTrainerCommand = canDispatchTrainerCommand({
            command: rideSnapshot.pendingTrainerCommand,
            dispatchState: state.liveRide.commandDispatch,
            now
        });

        if (rideSnapshot.pendingTrainerCommand && shouldDispatchTrainerCommand) {
            const cmd = rideSnapshot.pendingTrainerCommand;
            const controlMode = cmd.controlMode ?? cmd.mode;
            const targetGradePercent = cmd.targetGradePercent ?? cmd.payload?.gradePercent;
            const targetPowerWatts = cmd.targetPowerWatts ?? cmd.payload?.targetPowerWatts;
            const targetResistanceLevel = cmd.targetResistanceLevel ?? cmd.payload?.resistanceLevel;
            console.log(buildRideLogMessage(rideSnapshot));

            if (controlMode === TRAINER_CONTROL_MODES.SIM && targetGradePercent !== undefined) {
                void deviceService.setTrainerGrade(targetGradePercent).catch((error) => {
                    console.error("[RideService] 下发 trainer 坡度命令失败:", error);
                });
            } else if (controlMode === TRAINER_CONTROL_MODES.ERG && targetPowerWatts !== undefined) {
                void deviceService.setTrainerPower(targetPowerWatts).catch((error) => {
                    console.error("[RideService] 下发 trainer ERG 命令失败:", error);
                });
            } else if (controlMode === TRAINER_CONTROL_MODES.RESISTANCE && targetResistanceLevel !== undefined) {
                void deviceService.setTrainerResistance(targetResistanceLevel).catch((error) => {
                    console.error("[RideService] 下发 trainer 固定阻力命令失败:", error);
                });
            }
            rideSnapshot.workoutRuntime.pendingTrainerCommand = null;
            rideSnapshot.pendingTrainerCommand = null;
        } else if (!rideSnapshot.pendingTrainerCommand) {
            // 每隔约 5 秒打一次常规日志，防止刷屏
            if (shouldEmitRideLog({
                previousElapsedSeconds: state.liveRide.session.summary?.elapsedSeconds ?? 0,
                nextElapsedSeconds: rideSnapshot.session.summary.elapsedSeconds
            })) {
                console.log(buildRideLogMessage(rideSnapshot));
            }
        }

        const nextCommandDispatch = shouldDispatchTrainerCommand && rideSnapshot.workoutRuntime
            ? buildNextCommandDispatchState({
                dispatchState: state.liveRide.commandDispatch,
                runtime: rideSnapshot.workoutRuntime,
                now
            })
            : state.liveRide.commandDispatch ?? createInitialCommandDispatchState();

        store.setState((currentState) => ({
            ...currentState,
            workout: {
                ...currentState.workout,
                runtime: rideSnapshot.workoutRuntime
            },
            liveRide: {
                ...currentState.liveRide,
                snapshot: rideSnapshot,
                session: rideSnapshot.session,
                trainerControlMode: rideSnapshot.trainerControlMode,
                customWorkoutTargetPlan: rideSnapshot.customWorkoutTargetPlan,
                commandSequence: rideSnapshot.commandSequence,
                commandDispatch: nextCommandDispatch,
                statusMeta: rideSnapshot.statusMeta
            }
        }));

        if (nextTickIntervalMs !== currentTickIntervalMs) {
            restartLiveRideLoop(nextTickIntervalMs);
        }
    }

    function runSimulation() {
        const state = store.getState();
        const session = {
            ...simulateRide({ route: state.route, settings: state.settings }),
            exportMetadata: state.exportMetadata
        };

        saveLastSession(session);

        store.setState((currentState) => ({
            ...currentState,
            session,
            hasPersistedSession: true,
            statusText: `模拟完成：${formatNumber(session.summary.distanceKm, 2)} km / 平均速度 ${formatNumber(session.summary.averageSpeedKph, 1)} km/h`
        }));
    }

    function openRideDashboard() {
        store.setState((state) => ({
            ...state,
            liveRide: { ...state.liveRide, dashboardOpen: true }
        }));
    }

    function closeRideDashboard() {
        store.setState((state) => ({
            ...state,
            liveRide: { ...state.liveRide, dashboardOpen: false }
        }));
    }

    return {
        startRide,
        stopRide,
        runSimulation,
        openRideDashboard,
        closeRideDashboard
    };

    function restartLiveRideLoop(nextIntervalMs) {
        const safeIntervalMs = normalizePhysicsTickIntervalMs(nextIntervalMs);
        if (liveRideTimerId !== null) {
            clearInterval(liveRideTimerId);
        }
        liveRideTickIntervalMs = safeIntervalMs;
        liveRideTimerId = window.setInterval(tickLiveRide, safeIntervalMs);
    }

    function stopLiveRideLoop() {
        if (liveRideTimerId !== null) {
            clearInterval(liveRideTimerId);
        }
        liveRideTimerId = null;
        liveRideTickIntervalMs = DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS;
    }
}

function createInitialCommandDispatchState() {
    return {
        lastSentAtMs: null,
        lastSentControlMode: null,
        lastSentGradePercent: 0,
        lastSentPowerWatts: null,
        lastSentResistanceLevel: null
    };
}

function canDispatchTrainerCommand({ command, dispatchState, now }) {
    if (!command) {
        return false;
    }

    const lastSentAtMs = dispatchState?.lastSentAtMs ?? null;
    if (!Number.isFinite(lastSentAtMs)) {
        return true;
    }

    return now - lastSentAtMs >= TRAINER_COMMAND_MIN_INTERVAL_MS;
}

function buildNextCommandDispatchState({ dispatchState, runtime, now }) {
    return {
        ...createInitialCommandDispatchState(),
        ...dispatchState,
        lastSentAtMs: now,
        lastSentControlMode: runtime.trainerControlMode ?? null,
        lastSentGradePercent: runtime.targetTrainerGradePercent ?? 0,
        lastSentPowerWatts: runtime.targetErgPowerWatts ?? null,
        lastSentResistanceLevel: runtime.targetResistanceLevel ?? null
    };
}

function shouldEmitRideLog({ previousElapsedSeconds, nextElapsedSeconds }) {
    const previousBucket = Math.floor((Number(previousElapsedSeconds) || 0) / 5);
    const nextBucket = Math.floor((Number(nextElapsedSeconds) || 0) / 5);
    return nextBucket > previousBucket;
}

function resolveAdaptivePhysicsTickMs(sampledSensors) {
    const estimatedIntervalMs = sampledSensors?.powerSignal?.estimatedIntervalMs;
    const intervalSampleCount = sampledSensors?.powerSignal?.intervalSampleCount ?? 0;
    const signalStable = sampledSensors?.powerSignal?.isStable === true;
    const powerFresh = sampledSensors?.freshness?.power === true;

    if (!powerFresh || !Number.isFinite(estimatedIntervalMs) || intervalSampleCount < 4 || !signalStable) {
        return DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS;
    }

    return normalizePhysicsTickIntervalMs(estimatedIntervalMs);
}

function normalizePhysicsTickIntervalMs(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS;
    }

    return ADAPTIVE_PHYSICS_TICK_BUCKETS_MS.reduce((closest, candidate) => {
        const currentDelta = Math.abs(candidate - intervalMs);
        const bestDelta = Math.abs(closest - intervalMs);
        return currentDelta < bestDelta ? candidate : closest;
    }, DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS);
}
