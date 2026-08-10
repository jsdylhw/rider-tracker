import {
    buildRideActivitySession,
    createLiveRideSession
} from "../../domain/ride/live-ride-session.js";
import { simulateRide } from "../../domain/ride/simulator.js";
import { buildEffectiveSensorSnapshot } from "../realtime/sensor-sampling.js";
import {
    sanitizeCustomWorkoutTarget
} from "../../domain/workout/custom-workout-target.js";
import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import {
    buildInitialRideSessionState,
    buildNextRideSessionState,
    buildRideLogMessage,
    buildRuntimeByControlMode
} from "../realtime/ride-engine.js";
import { saveLastSession } from "../../adapters/storage/session-storage.js";
import { saveRiderSessionActivity } from "../../adapters/storage/activity-history-client.js";
import { formatNumber } from "../../shared/format.js";
import { isStreetViewDebugEnabled } from "../../shared/debug-flags.js";
import { sanitizeSessionExportMetadata } from "../store/initial-state.js";
import { encodeFitSync } from "../../adapters/export/fit-exporter.js";
import { sendFitBeacon } from "../../adapters/upload/fit-beacon-client.js";
import { loadFitSdk } from "../../adapters/fit/fit-sdk-loader.js";
import { buildRoute, isRouteReadyForRide } from "../../domain/route/route-builder.js";

const DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS = 250;
const ADAPTIVE_PHYSICS_TICK_BUCKETS_MS = [200, 250, 500, 1000];
const TRAINER_COMMAND_MIN_INTERVAL_MS = 500;
const STREET_VIEW_DEBUG_POWER_WATTS = 180;
const STREET_VIEW_DEBUG_CADENCE_RPM = 85;
const STREET_VIEW_DEBUG_HEART_RATE_BPM = 130;
const DEFAULT_ACTIVITY_NAME = "Rider Tracker Virtual Ride";

export function createRideService({ store, deviceService, exportService, routeService = null }) {
    let liveRideTimerId = null;
    let liveRideTickIntervalMs = DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS;

    function startRide() {
        let state = store.getState();
        if (!isRouteReadyForRide(state.route)) {
            store.setState((currentState) => ({
                ...currentState,
                statusText: currentState.route?.isLoading
                    ? "路线仍在处理中，请等待完成后再开始骑行。"
                    : "请先设置一条有效路线后再开始骑行。"
            }));
            return;
        }
        routeService?.ensureExplorationRouteAhead?.({ distanceMeters: 0 });
        state = store.getState();
        if (!isRouteReadyForRide(state.route)) {
            return;
        }
        const streetViewDebugEnabled = isStreetViewDebugEnabled();
        const virtualRideEnabled = streetViewDebugEnabled && state.rideInput?.powerSource === "virtual";
        if ((!state.liveRide.canStart && !virtualRideEnabled && !streetViewDebugEnabled) || state.liveRide.isActive) {
            return;
        }

        const startedAt = new Date().toISOString();
        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const sampledSensors = resolveStartRideSensorSnapshot({
            sampling: state.ble.sampling,
            settings: state.settings,
            rideInput: state.rideInput,
            streetViewDebugEnabled
        });
        const baseSession = createLiveRideSession({
            route: state.route,
            settings: state.settings,
            startedAt,
            initialHeartRate: sampledSensors.heartRate
        });

        baseSession.exportMetadata = buildRideExportMetadata(state.exportMetadata, state.route);

        const initialStatusMeta = streetViewDebugEnabled && sampledSensors.powerSourceType === "street-view-debug"
            ? `街景调试骑行：使用 ${sampledSensors.power} W 模拟功率预览路线与 UI，当前模式：${getWorkoutModeLabel(state.workout.mode)}。`
            : `正在根据实时功率和路线坡度更新速度，当前模式：${getWorkoutModeLabel(state.workout.mode)}。`;
        const initialRideState = buildInitialRideSessionState({
            session: baseSession,
            sampledSensors,
            trainerControlMode,
            customWorkoutTargetPlan: sanitizeCustomWorkoutTarget(state.workout.customWorkoutTarget),
            workoutRuntime: state.workout.runtime,
            statusMeta: initialStatusMeta
        });

        store.setState((currentState) => ({
            ...currentState,
            uiMode: "live",
            session: null,
            selectedActivity: null,
            liveRide: {
                ...currentState.liveRide,
                isActive: true,
                dashboardOpen: true,
                session: initialRideState.session,
                records: initialRideState.records,
                summary: initialRideState.summary,
                trainerConnectionEpoch: 0,
                appliedTrainerConnectionEpoch: 0,
                commandDispatch: createInitialCommandDispatchState(),
                statusMeta: initialStatusMeta
            },
            statusText: streetViewDebugEnabled && sampledSensors.powerSourceType === "street-view-debug"
                ? `已开始街景调试骑行，当前训练模式：${getWorkoutModeLabel(currentState.workout.mode)}。`
                : `已开始骑行，当前训练模式：${getWorkoutModeLabel(currentState.workout.mode)}。`
        }));
        deviceService?.setTrainerAutoReconnectEnabled?.(true);

        restartLiveRideLoop(resolveAdaptivePhysicsTickMs(sampledSensors));

        // 非阻塞预热 FIT SDK，提升页面关闭时 beacon 发送成功率
        loadFitSdk().catch(() => {});
    }

    function stopRide() {
        const state = store.getState();
        if (!state.liveRide.isActive) {
            return;
        }

        const completedSession = finalizeRideSync();

        if (completedSession) {
            const completedDistanceMeters = (completedSession.summary?.metrics?.ride?.distanceKm ?? 0) * 1000;
            const routeProgressUpdate = routeService?.updateSavedGpxRouteProgress?.({
                route: completedSession.route,
                sessionDistanceMeters: completedDistanceMeters
            });
            void Promise.resolve(routeProgressUpdate).catch((error) => {
                console.warn("[RideService] 保存未完成路线进度失败:", error);
            });
            const completedRideId = completedSession.startedAt;
            const pendingActivity = buildPendingActivity(completedSession);
            store.setState((currentState) => ({
                ...currentState,
                uiMode: "activity-detail",
                selectedActivity: pendingActivity,
                session: completedSession,
                statusText: "骑行已结束，正在生成 FIT 并保存本地活动。"
            }));
            const activitySavePromise = archiveCompletedRideSession(completedSession, exportService);

            void activitySavePromise
                .then((activity) => {
                    if (!activity?.id) {
                        throw new Error("未能保存本地活动");
                    }
                    const nextActivity = {
                        ...(activity ?? {}),
                        rawSession: completedSession,
                        pendingRideId: completedRideId,
                        isSaving: false
                    };
                    store.setState((currentState) => currentState.selectedActivity?.pendingRideId === completedRideId
                        ? {
                            ...currentState,
                            selectedActivity: nextActivity,
                            statusText: "骑行已结束，活动已保存。"
                        }
                        : currentState);
                })
                .catch((error) => {
                    console.warn("[RideService] 保存骑后报告失败:", error);
                    store.setState((currentState) => currentState.selectedActivity?.pendingRideId === completedRideId
                        ? {
                            ...currentState,
                            selectedActivity: {
                                ...currentState.selectedActivity,
                                isSaving: false,
                                saveError: "FIT 保存失败，骑行记录仍可导出为 JSON。"
                            },
                            statusText: "骑行已结束，但 FIT 保存失败。"
                        }
                        : currentState);
                });
        }
    }

    function finalizeRideSync(options = {}) {
        const state = store.getState();
        if (!state.liveRide.isActive) {
            return null;
        }

        stopLiveRideLoop();
        deviceService?.setTrainerAutoReconnectEnabled?.(false);

        const completedSession = state.liveRide.session
            ? {
                ...buildRideActivitySession({
                    session: state.liveRide.session,
                    records: state.liveRide.records,
                    summary: state.liveRide.summary
                }),
                finishedAt: new Date().toISOString()
            }
            : null;

        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const stoppedRuntime = buildRuntimeByControlMode({
            trainerControlMode,
            state,
            session: state.liveRide.session,
            active: false
        });
        const completedMetrics = completedSession?.summary?.metrics ?? null;
        const stoppedStatusMeta = completedSession
            ? `骑行结束：${formatNumber(completedMetrics?.ride.distanceKm ?? 0, 2)} km / 平均速度 ${formatNumber(completedMetrics?.speed.averageKph ?? 0, 1)} km/h`
            : "骑行已停止。";
        routeService?.releaseRouteAfterRide?.();
        void deviceService?.releaseTrainerControl?.().catch((error) => {
            console.warn("[RideService] 结束骑行时释放骑行台控制失败:", error);
        });

        store.setState((currentState) => ({
            ...currentState,
            session: completedSession ?? currentState.session,
            route: buildRoute([]),
            hasPersistedSession: Boolean(completedSession) || currentState.hasPersistedSession,
            workout: {
                ...currentState.workout,
                runtime: stoppedRuntime
            },
            liveRide: {
                ...currentState.liveRide,
                isActive: false,
                dashboardOpen: false,
                session: null,
                records: [],
                summary: null,
                trainerConnectionEpoch: 0,
                appliedTrainerConnectionEpoch: 0,
                commandDispatch: createInitialCommandDispatchState(),
                lastCompletedAt: new Date().toISOString(),
                statusMeta: stoppedStatusMeta
            },
            statusText: stoppedStatusMeta
        }));

        if (completedSession) {
            saveLastSession(completedSession);
            if (options.sendBeacon === true) {
                trySendFitBeacon(completedSession);
            }
        }

        return completedSession;
    }

    function trySendFitBeacon(session) {
        const state = store.getState();
        const fitBytes = encodeFitSync(session, {
            ...state.exportMetadata,
            ...(session.exportMetadata ?? {})
        }, {
            markVirtualActivity: false
        });

        if (!fitBytes) {
            return;
        }

        // sendBeacon 有 ~64 KiB 队列限制。FIT 二进制还要加上 compact session
        // JSON 和 multipart 边界开销，预留 ~16 KiB margin。
        const MAX_BEACON_FIT_BYTES = 48 * 1024;
        if (fitBytes.length > MAX_BEACON_FIT_BYTES) {
            return;
        }

        // 用紧凑 session（去掉 records，数据已在 FIT 中）减小 payload
        const compactSession = buildCompactBeaconSession(session);
        const filename = `virtual-ride-${new Date().toISOString().replace(/[:.]/g, "-")}.fit`;
        const sent = sendFitBeacon({
            fitBytes,
            filename,
            session: compactSession,
            name: state.exportMetadata?.activityName,
            sportType: "VirtualRide"
        });

        if (!sent) {
            console.warn("[RideService] sendBeacon 入队失败（payload 可能过大或浏览器不支持）");
        }
    }

    function buildCompactBeaconSession(session) {
        return {
            id: session.id,
            activityId: session.activityId,
            source: session.source ?? "rider-tracker",
            createdAt: session.createdAt,
            startedAt: session.startedAt,
            finishedAt: session.finishedAt,
            settings: session.settings,
            summary: session.summary,
            exportMetadata: session.exportMetadata,
            records: []
        };
    }

    function tickLiveRide() {
        let state = store.getState();
        if (!state.liveRide.isActive || !state.liveRide.session) {
            stopLiveRideLoop();
            return;
        }

        routeService?.ensureExplorationRouteAhead?.({
            distanceMeters: state.liveRide.session.physicsState.distanceMeters
        });
        state = store.getState();

        const currentTickIntervalMs = liveRideTickIntervalMs;
        const sampledSensors = resolveStartRideSensorSnapshot({
            sampling: state.ble.sampling,
            settings: state.settings,
            rideInput: state.rideInput,
            streetViewDebugEnabled: isStreetViewDebugEnabled()
        });
        const nextTickIntervalMs = resolveAdaptivePhysicsTickMs(sampledSensors);
        const rideState = buildNextRideSessionState({
            state,
            sampledSensors,
            dt: currentTickIntervalMs / 1000
        });

        const now = Date.now();
        const forcedTrainerConnectionEpoch = (state.liveRide.trainerConnectionEpoch ?? 0)
            > (state.liveRide.appliedTrainerConnectionEpoch ?? 0)
            ? state.liveRide.trainerConnectionEpoch
            : null;
        let dispatchedCommand = null;
        const canSendTrainerCommand = state.rideInput?.powerSource !== "virtual" || state.ble.trainer?.isConnected === true;
        const shouldDispatchTrainerCommand = canSendTrainerCommand && canDispatchTrainerCommand({
            command: rideState.session.pendingTrainerCommand,
            dispatchState: state.liveRide.commandDispatch,
            now
        });

        if (rideState.session.pendingTrainerCommand && shouldDispatchTrainerCommand) {
            const cmd = rideState.session.pendingTrainerCommand;
            const controlMode = cmd.controlMode ?? cmd.mode;
            const targetGradePercent = cmd.targetGradePercent ?? cmd.payload?.gradePercent;
            const targetPowerWatts = cmd.targetPowerWatts ?? cmd.payload?.targetPowerWatts;
            const targetResistanceLevel = cmd.targetResistanceLevel ?? cmd.payload?.resistanceLevel;
            const requiresConfirmation = cmd.requireConfirmation === true;
            dispatchedCommand = cmd;
            console.log(buildRideLogMessage(rideState));

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
                        store.setState((currentState) => isCurrentRideCommand(currentState, cmd)
                            ? {
                                ...currentState,
                                liveRide: {
                                    ...currentState.liveRide,
                                    appliedTrainerConnectionEpoch: markTrainerConnectionEpochApplied({
                                        currentState,
                                        forcedTrainerConnectionEpoch
                                    }),
                                    commandDispatch: buildNextCommandDispatchState({
                                        dispatchState: currentState.liveRide.commandDispatch,
                                        command: cmd,
                                        now: Date.now()
                                    })
                                }
                            }
                            : currentState);
                    })
                    .catch((error) => {
                        console.error("[RideService] ERG 确认模式下发失败:", error);
                        store.setState((currentState) => isCurrentRideCommand(currentState, cmd)
                            ? {
                                ...currentState,
                                liveRide: {
                                    ...currentState.liveRide,
                                    commandDispatch: clearInFlightCommandDispatchState({
                                        dispatchState: currentState.liveRide.commandDispatch
                                    })
                                }
                            }
                            : currentState);
                    });
            } else {
                void dispatchPromise
                    .then(() => {
                        if (forcedTrainerConnectionEpoch === null) return;
                        store.setState((currentState) => isCurrentRideCommand(currentState, cmd)
                            ? {
                                ...currentState,
                                liveRide: {
                                    ...currentState.liveRide,
                                    appliedTrainerConnectionEpoch: markTrainerConnectionEpochApplied({
                                        currentState,
                                        forcedTrainerConnectionEpoch
                                    })
                                }
                            }
                            : currentState);
                    })
                    .catch((error) => {
                        console.error(`[RideService] 下发 trainer ${controlMode} 命令失败:`, error);
                    });
                rideState.session.workoutRuntime.pendingTrainerCommand = null;
                rideState.session.pendingTrainerCommand = null;
            }
        } else if (!rideState.session.pendingTrainerCommand) {
            // 每隔约 5 秒打一次常规日志，防止刷屏
            if (shouldEmitRideLog({
                previousElapsedSeconds: state.liveRide.summary?.metrics?.ride?.elapsedSeconds ?? 0,
                nextElapsedSeconds: rideState.summary.metrics.ride.elapsedSeconds
            })) {
                console.log(buildRideLogMessage(rideState));
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
                runtime: rideState.session.workoutRuntime
            },
            liveRide: {
                ...currentState.liveRide,
                session: rideState.session,
                records: rideState.records,
                summary: rideState.summary,
                commandDispatch: nextCommandDispatch,
                statusMeta: rideState.session.statusMeta
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
        archiveSimulationSession(session, exportService);

        store.setState((currentState) => ({
            ...currentState,
            session,
            hasPersistedSession: true,
            statusText: `模拟完成：${formatNumber(session.summary.metrics.ride.distanceKm, 2)} km / 平均速度 ${formatNumber(session.summary.metrics.speed.averageKph, 1)} km/h`
        }));
    }

    function startVirtualRide() {
        if (!isStreetViewDebugEnabled()) {
            store.setState((state) => ({
                ...state,
                statusText: "模拟功率仅在街景调试模式可用。"
            }));
            return;
        }
        const state = store.getState();
        updateRideInput({
            powerSource: "virtual",
            virtualPowerWatts: state.rideInput?.virtualPowerWatts,
            virtualCadenceRpm: state.rideInput?.virtualCadenceRpm
        });
        store.setState((currentState) => ({
            ...currentState,
            uiMode: "live"
        }));
        startRide();
    }

    function updateRideInput(input) {
        const virtualAllowed = isStreetViewDebugEnabled();
        const powerSource = virtualAllowed && input?.powerSource !== "device" ? "virtual" : "device";
        store.setState((state) => ({
            ...state,
            rideInput: {
                powerSource,
                virtualPowerWatts: clampVirtualPower(input?.virtualPowerWatts, state.rideInput?.virtualPowerWatts),
                virtualCadenceRpm: clampVirtualCadence(input?.virtualCadenceRpm, state.rideInput?.virtualCadenceRpm)
            },
            liveRide: {
                ...state.liveRide,
                canStart: powerSource === "device"
                    ? Boolean(state.ble.trainer.isConnected || state.ble.powerMeter.sourceType !== "none")
                    : true
            },
            statusText: powerSource === "device"
                ? "已切换为已连接设备功率。"
                : "已切换为模拟功率，可直接开始实时骑行。"
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
        finalizeRideSync,
        runSimulation,
        startVirtualRide,
        updateRideInput,
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

function archiveCompletedRideSession(session, exportService) {
    const savePromise = typeof exportService?.archiveSessionAsFitActivity === "function"
        ? exportService.archiveSessionAsFitActivity(session, {
            sportType: "Ride",
            markVirtualActivity: false
        })
        : saveSessionToActivityHistory(session);

    return Promise.resolve(savePromise)
        .then((activity) => {
            if (activity?.id) {
                return activity;
            }
            return saveSessionToActivityHistory(session);
        })
        .catch((error) => {
            console.warn("[RideService] FIT 活动归档失败，降级保存活动历史:", error);
            return saveSessionToActivityHistory(session);
        });
}

function buildPendingActivity(session) {
    const metrics = session.summary?.metrics ?? {};
    const ride = metrics.ride ?? {};
    const power = metrics.power ?? {};
    const heartRate = metrics.heartRate ?? {};
    const load = metrics.load ?? {};

    return {
        id: `pending:${session.startedAt}`,
        pendingRideId: session.startedAt,
        isSaving: true,
        name: session.exportMetadata?.activityName ?? DEFAULT_ACTIVITY_NAME,
        source: session.source ?? "rider-tracker",
        sportType: "VirtualRide",
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        elapsedSeconds: ride.elapsedSeconds,
        distanceKm: ride.distanceKm,
        ascentMeters: ride.ascentMeters,
        averagePower: power.averageWatts,
        normalizedPower: power.normalizedPowerWatts,
        averageHr: heartRate.averageBpm,
        estimatedTss: load.estimatedTss,
        rawSession: session
    };
}

function buildRideExportMetadata(exportMetadata, route) {
    const metadata = sanitizeSessionExportMetadata(exportMetadata);
    if (metadata.activityName !== DEFAULT_ACTIVITY_NAME) {
        return metadata;
    }

    return {
        ...metadata,
        activityName: inferDefaultActivityName(route)
    };
}

function inferDefaultActivityName(route) {
    if (route?.source === "gpx") {
        return `GPX 骑行 · ${route.importFileName ?? route.name ?? "路线"}`.slice(0, 48);
    }
    if (route?.source === "osm-exploration") {
        return "OSM 自由探索骑行";
    }
    if (route?.source === "manual") {
        return "自定义线路骑行";
    }
    return route?.name ? `路线骑行 · ${route.name}`.slice(0, 48) : DEFAULT_ACTIVITY_NAME;
}

function resolveStartRideSensorSnapshot({ sampling, settings, rideInput, streetViewDebugEnabled }) {
    const sampledSensors = buildEffectiveSensorSnapshot(sampling);
    if (streetViewDebugEnabled && rideInput?.powerSource === "virtual") {
        return buildVirtualRideSensorSnapshot(sampledSensors, rideInput);
    }
    if (!streetViewDebugEnabled || sampledSensors.power !== null) {
        return sampledSensors;
    }

    const now = Date.now();
    const power = Math.round(Number(settings?.power) || STREET_VIEW_DEBUG_POWER_WATTS);
    return {
        ...sampledSensors,
        power,
        cadence: sampledSensors.cadence ?? STREET_VIEW_DEBUG_CADENCE_RPM,
        heartRate: sampledSensors.heartRate ?? STREET_VIEW_DEBUG_HEART_RATE_BPM,
        powerSourceType: "street-view-debug",
        powerTimestamp: now,
        heartRateTimestamp: sampledSensors.heartRateTimestamp ?? now,
        powerSignal: {
            observedIntervalMs: DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            estimatedIntervalMs: DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            estimatedHz: 1000 / DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            jitterMs: 0,
            isStable: true,
            intervalSampleCount: 1
        },
        freshness: {
            ...(sampledSensors.freshness ?? {}),
            power: true,
            cadence: true,
            heartRate: sampledSensors.heartRate !== null
        }
    };
}

function buildVirtualRideSensorSnapshot(sampledSensors, rideInput) {
    const now = Date.now();
    return {
        ...sampledSensors,
        power: clampVirtualPower(rideInput?.virtualPowerWatts, STREET_VIEW_DEBUG_POWER_WATTS),
        cadence: clampVirtualCadence(rideInput?.virtualCadenceRpm, STREET_VIEW_DEBUG_CADENCE_RPM),
        powerSourceType: "virtual",
        powerTimestamp: now,
        powerSignal: {
            observedIntervalMs: DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            estimatedIntervalMs: DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            estimatedHz: 1000 / DEFAULT_LIVE_RIDE_PHYSICS_TICK_MS,
            jitterMs: 0,
            isStable: true,
            intervalSampleCount: 1
        },
        freshness: {
            ...(sampledSensors.freshness ?? {}),
            power: true,
            cadence: true
        }
    };
}

function clampVirtualPower(value, fallback = STREET_VIEW_DEBUG_POWER_WATTS) {
    const number = Number(value);
    return Math.round(Math.min(600, Math.max(0, Number.isFinite(number) ? number : fallback)));
}

function clampVirtualCadence(value, fallback = STREET_VIEW_DEBUG_CADENCE_RPM) {
    const number = Number(value);
    return Math.round(Math.min(160, Math.max(0, Number.isFinite(number) ? number : fallback)));
}

function archiveSimulationSession(session, exportService) {
    const savePromise = typeof exportService?.archiveSessionAsFitActivity === "function"
        ? exportService.archiveSessionAsFitActivity(session, {
            sportType: "Ride",
            markVirtualActivity: false
        })
        : saveSessionToActivityHistory(session);

    return Promise.resolve(savePromise)
        .then((activity) => activity)
        .catch((error) => {
            console.warn("[RideService] 保存模拟活动 FIT 失败:", error);
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

function isCurrentRideCommand(state, command) {
    return state.liveRide?.isActive === true
        && state.liveRide.session?.startedAt === command.rideId;
}

function markTrainerConnectionEpochApplied({ currentState, forcedTrainerConnectionEpoch }) {
    if (forcedTrainerConnectionEpoch === null) {
        return currentState.liveRide.appliedTrainerConnectionEpoch ?? 0;
    }
    return Math.max(
        currentState.liveRide.appliedTrainerConnectionEpoch ?? 0,
        forcedTrainerConnectionEpoch
    );
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
