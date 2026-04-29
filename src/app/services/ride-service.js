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
import { saveRiderSessionActivity } from "../../adapters/storage/activity-history-client.js";
import { formatNumber } from "../../shared/format.js";
import { sanitizeSessionExportMetadata } from "../store/initial-state.js";

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

        session.exportMetadata = sanitizeSessionExportMetadata(state.exportMetadata);

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
        const activitySavePromise = completedSession
            ? saveSessionToActivityHistory(completedSession)
            : Promise.resolve(null);

        if (completedSession) {
            saveLastSession(completedSession);
        }

        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const stoppedRuntime = buildRuntimeByControlMode({
            trainerControlMode,
            state,
            active: false
        });
        const completedMetrics = completedSession?.summary?.metrics ?? null;
        const stoppedStatusMeta = completedSession
            ? `骑行结束：${formatNumber(completedMetrics?.ride.distanceKm ?? 0, 2)} km / 平均速度 ${formatNumber(completedMetrics?.speed.averageKph ?? 0, 1)} km/h`
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

        if ((completedMetrics?.ride.distanceKm ?? 0) > 0) {
            void activitySavePromise
                .then(async (activity) => {
                    const fitActivity = typeof exportService.archiveFitForSession === "function"
                        ? await exportService.archiveFitForSession(completedSession)
                        : null;
                    const nextActivity = {
                        ...(activity ?? {}),
                        ...(fitActivity ?? {}),
                        rawSession: completedSession
                    };
                    store.setState((currentState) => ({
                        ...currentState,
                        uiMode: "activity-detail",
                        selectedActivity: nextActivity,
                        session: completedSession,
                        liveRide: {
                            ...currentState.liveRide,
                            dashboardOpen: false
                        },
                        statusText: "骑行已结束，已打开骑后报告。"
                    }));
                })
                .catch((error) => {
                    console.warn("[RideService] 打开骑后报告失败:", error);
                });
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
        let dispatchedCommand = null;
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
            const requiresConfirmation = cmd.requireConfirmation === true;
            dispatchedCommand = cmd;
            console.log(buildRideLogMessage(rideSnapshot));

            const dispatchPromise = dispatchTrainerCommand({
                deviceService,
                controlMode,
                targetGradePercent,
                targetPowerWatts,
                targetResistanceLevel,
                requiresConfirmation
            });

            if (requiresConfirmation) {
                void dispatchPromise
                    .then(() => {
                        store.setState((currentState) => ({
                            ...currentState,
                            liveRide: {
                                ...currentState.liveRide,
                                commandDispatch: buildNextCommandDispatchState({
                                    dispatchState: currentState.liveRide.commandDispatch,
                                    command: cmd,
                                    now: Date.now()
                                })
                            }
                        }));
                    })
                    .catch((error) => {
                        console.error("[RideService] ERG 确认模式下发失败:", error);
                        store.setState((currentState) => ({
                            ...currentState,
                            liveRide: {
                                ...currentState.liveRide,
                                commandDispatch: clearInFlightCommandDispatchState({
                                    dispatchState: currentState.liveRide.commandDispatch
                                })
                            }
                        }));
                    });
            } else {
                void dispatchPromise.catch((error) => {
                    console.error(`[RideService] 下发 trainer ${controlMode} 命令失败:`, error);
                });
                rideSnapshot.workoutRuntime.pendingTrainerCommand = null;
                rideSnapshot.pendingTrainerCommand = null;
            }
        } else if (!rideSnapshot.pendingTrainerCommand) {
            // 每隔约 5 秒打一次常规日志，防止刷屏
            if (shouldEmitRideLog({
                previousElapsedSeconds: state.liveRide.session.summary?.metrics?.ride?.elapsedSeconds ?? 0,
                nextElapsedSeconds: rideSnapshot.session.summary.metrics.ride.elapsedSeconds
            })) {
                console.log(buildRideLogMessage(rideSnapshot));
            }
        }

        const nextCommandDispatch = shouldDispatchTrainerCommand && dispatchedCommand
            ? (dispatchedCommand.requireConfirmation === true
                ? buildInFlightCommandDispatchState({
                    dispatchState: state.liveRide.commandDispatch,
                    command: dispatchedCommand,
                    now
                })
                : buildNextCommandDispatchState({
                    dispatchState: state.liveRide.commandDispatch,
                    command: dispatchedCommand,
                    now
                }))
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
            exportMetadata: sanitizeSessionExportMetadata(state.exportMetadata)
        };

        saveLastSession(session);
        saveSessionToActivityHistory(session);

        store.setState((currentState) => ({
            ...currentState,
            session,
            hasPersistedSession: true,
            statusText: `模拟完成：${formatNumber(session.summary.metrics.ride.distanceKm, 2)} km / 平均速度 ${formatNumber(session.summary.metrics.speed.averageKph, 1)} km/h`
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

function saveSessionToActivityHistory(session) {
    return saveRiderSessionActivity(session)
        .then((activity) => {
            if (activity?.id) {
                session.activityId = activity.id;
            }
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
                window.dispatchEvent(new CustomEvent("rider-tracker:activity-saved", {
                    detail: { activity }
                }));
            }
            return activity;
        })
        .catch((error) => {
            console.warn("[RideService] 保存活动历史失败:", error);
            return null;
        });
}

function createInitialCommandDispatchState() {
    return {
        lastSentAtMs: null,
        lastAttemptedAtMs: null,
        lastSentControlMode: null,
        lastSentGradePercent: 0,
        lastSentPowerWatts: null,
        lastSentResistanceLevel: null,
        inFlightCommandKey: null
    };
}

function canDispatchTrainerCommand({ command, dispatchState, now }) {
    if (!command) {
        return false;
    }

    const commandKey = buildTrainerCommandKey(command);
    if (dispatchState?.inFlightCommandKey === commandKey) {
        return false;
    }

    const lastAttemptedAtMs = dispatchState?.lastAttemptedAtMs ?? dispatchState?.lastSentAtMs ?? null;
    if (!Number.isFinite(lastAttemptedAtMs)) {
        return true;
    }

    return now - lastAttemptedAtMs >= TRAINER_COMMAND_MIN_INTERVAL_MS;
}

function buildInFlightCommandDispatchState({ dispatchState, command, now }) {
    return {
        ...createInitialCommandDispatchState(),
        ...dispatchState,
        lastAttemptedAtMs: now,
        inFlightCommandKey: buildTrainerCommandKey(command)
    };
}

function clearInFlightCommandDispatchState({ dispatchState }) {
    return {
        ...createInitialCommandDispatchState(),
        ...dispatchState,
        inFlightCommandKey: null
    };
}

function buildNextCommandDispatchState({ dispatchState, command, now }) {
    const controlMode = command.controlMode ?? command.mode ?? null;

    return {
        ...createInitialCommandDispatchState(),
        ...dispatchState,
        lastAttemptedAtMs: now,
        lastSentAtMs: now,
        lastSentControlMode: controlMode,
        lastSentGradePercent: command.targetGradePercent ?? command.payload?.gradePercent ?? 0,
        lastSentPowerWatts: command.targetPowerWatts ?? command.payload?.targetPowerWatts ?? null,
        lastSentResistanceLevel: command.targetResistanceLevel ?? command.payload?.resistanceLevel ?? null,
        inFlightCommandKey: null
    };
}

function buildTrainerCommandKey(command) {
    const controlMode = command.controlMode ?? command.mode ?? "unknown";
    const targetGradePercent = command.targetGradePercent ?? command.payload?.gradePercent ?? "";
    const targetPowerWatts = command.targetPowerWatts ?? command.payload?.targetPowerWatts ?? "";
    const targetResistanceLevel = command.targetResistanceLevel ?? command.payload?.resistanceLevel ?? "";
    const requireConfirmation = command.requireConfirmation === true ? "confirm" : "best-effort";
    return `${controlMode}:${targetGradePercent}:${targetPowerWatts}:${targetResistanceLevel}:${requireConfirmation}`;
}

async function dispatchTrainerCommand({
    deviceService,
    controlMode,
    targetGradePercent,
    targetPowerWatts,
    targetResistanceLevel,
    requiresConfirmation
}) {
    if (controlMode === TRAINER_CONTROL_MODES.SIM && targetGradePercent !== undefined) {
        await deviceService.setTrainerGrade(targetGradePercent);
        return;
    }

    if (controlMode === TRAINER_CONTROL_MODES.ERG && targetPowerWatts !== undefined) {
        await deviceService.setTrainerPower(targetPowerWatts, {
            confirm: requiresConfirmation
        });
        return;
    }

    if (controlMode === TRAINER_CONTROL_MODES.RESISTANCE && targetResistanceLevel !== undefined) {
        await deviceService.setTrainerResistance(targetResistanceLevel);
    }
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
