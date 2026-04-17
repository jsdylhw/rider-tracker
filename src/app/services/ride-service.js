import { createLiveRideSession, advanceLiveRideSession } from "../../domain/ride/live-ride-session.js";
import { simulateRide } from "../../domain/ride/simulator.js";
import { buildGradeSimulationState } from "../../domain/workout/grade-sim-mode.js";
import { buildErgControlState } from "../../domain/workout/erg-mode.js";
import { buildResistanceControlState } from "../../domain/workout/resistance-mode.js";
import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { saveLastSession } from "../../adapters/storage/session-storage.js";
import { formatDuration, formatNumber } from "../../shared/format.js";

export function createRideService({ store, deviceService, exportService }) {
    let liveRideTimerId = null;

    function startRide() {
        const state = store.getState();
        if (!state.liveRide.canStart || state.liveRide.isActive) {
            return;
        }

        const startedAt = new Date().toISOString();
        const trainerControlMode = resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const session = createLiveRideSession({
            route: state.route,
            settings: state.settings,
            startedAt,
            initialHeartRate: state.ble.heartRate.value
        });

        session.exportMetadata = state.exportMetadata;

        clearInterval(liveRideTimerId);
        liveRideTimerId = window.setInterval(tickLiveRide, 1000);

        store.setState((currentState) => ({
            ...currentState,
            liveRide: {
                ...currentState.liveRide,
                isActive: true,
                dashboardOpen: true,
                session,
                startedAt,
                trainerControlMode,
                commandSequence: 0,
                statusMeta: `正在根据实时功率和路线坡度更新速度，当前模式：${getWorkoutModeLabel(currentState.workout.mode)}。`
            },
            statusText: `已开始骑行，当前训练模式：${getWorkoutModeLabel(currentState.workout.mode)}。`
        }));
    }

    function stopRide() {
        const state = store.getState();
        if (!state.liveRide.isActive) {
            return;
        }

        clearInterval(liveRideTimerId);
        liveRideTimerId = null;

        const completedSession = state.liveRide.session;
        if (completedSession) {
            saveLastSession(completedSession);
        }

        store.setState((currentState) => ({
            ...currentState,
            session: completedSession ?? currentState.session,
            hasPersistedSession: Boolean(completedSession) || currentState.hasPersistedSession,
            workout: {
                ...currentState.workout,
                runtime: buildRuntimeByControlMode({
                    trainerControlMode: resolveTrainerControlModeForWorkoutMode(currentState.workout.mode),
                    state: currentState,
                    active: false
                })
            },
            liveRide: {
                ...currentState.liveRide,
                isActive: false,
                dashboardOpen: false,
                trainerControlMode: null,
                commandSequence: 0,
                lastCompletedAt: new Date().toISOString(),
                statusMeta: completedSession
                    ? `骑行结束：${formatNumber(completedSession.summary.distanceKm, 2)} km / 平均速度 ${formatNumber(completedSession.summary.averageSpeedKph, 1)} km/h`
                    : "骑行已停止。"
            },
            statusText: completedSession
                ? `骑行结束：${formatNumber(completedSession.summary.distanceKm, 2)} km / 平均速度 ${formatNumber(completedSession.summary.averageSpeedKph, 1)} km/h`
                : "骑行已停止。"
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
            clearInterval(liveRideTimerId);
            liveRideTimerId = null;
            return;
        }

        const currentPower = state.ble.powerMeter.power ?? 0;
        const currentHeartRate = state.ble.heartRate.value;
        const currentCadence = state.ble.powerMeter.cadence;
        const trainerControlMode = state.liveRide.trainerControlMode
            ?? resolveTrainerControlModeForWorkoutMode(state.workout.mode);
        const nextCommandSequence = (state.liveRide.commandSequence ?? 0) + 1;
        const rideId = state.liveRide.startedAt ?? state.liveRide.session.startedAt;

        const nextSession = advanceLiveRideSession({
            session: state.liveRide.session,
            power: currentPower,
            heartRate: currentHeartRate,
            cadence: currentCadence,
            dt: 1
        });

        const workoutRuntime = trainerControlMode === TRAINER_CONTROL_MODES.SIM
            ? buildGradeSimulationState({
                route: nextSession.route,
                distanceMeters: nextSession.physicsState.distanceMeters,
                previousTargetGradePercent: state.workout.runtime.targetTrainerGradePercent ?? 0,
                config: state.workout.gradeSimulation,
                active: true,
                rideId,
                commandSequence: nextCommandSequence
            })
            : buildRuntimeByControlMode({
                trainerControlMode,
                state,
                active: true,
                rideId,
                commandSequence: nextCommandSequence
            });

        // 触发蓝牙命令发送
        if (workoutRuntime.pendingTrainerCommand) {
            const cmd = workoutRuntime.pendingTrainerCommand;
            const controlMode = cmd.controlMode ?? cmd.mode;
            const targetGradePercent = cmd.targetGradePercent ?? cmd.payload?.gradePercent;
            const targetPowerWatts = cmd.targetPowerWatts ?? cmd.payload?.targetPowerWatts;

            console.log(`[Ride Log] Distance: ${nextSession.physicsState.distanceMeters.toFixed(1)}m | Current Grade: ${nextSession.summary.currentGradePercent.toFixed(1)}% | Power: ${currentPower}W | Cadence: ${currentCadence}rpm | Speed: ${nextSession.summary.currentSpeedKph.toFixed(1)}km/h | Next Target Grade: ${targetGradePercent?.toFixed(2)}%`);

            if (controlMode === TRAINER_CONTROL_MODES.SIM && targetGradePercent !== undefined) {
                void deviceService.setTrainerGrade(targetGradePercent).catch((error) => {
                    console.error("[RideService] 下发 trainer 坡度命令失败:", error);
                });
            } else if (controlMode === TRAINER_CONTROL_MODES.ERG && targetPowerWatts !== undefined) {
                void deviceService.setTrainerPower(targetPowerWatts).catch((error) => {
                    console.error("[RideService] 下发 trainer ERG 命令失败:", error);
                });
            }
            workoutRuntime.pendingTrainerCommand = null;
        } else {
            // 每隔约 5 秒打一次常规日志，防止刷屏
            if (nextSession.physicsState.elapsedSeconds % 5 === 0) {
                console.log(`[Ride Log] Distance: ${nextSession.physicsState.distanceMeters.toFixed(1)}m | Current Grade: ${nextSession.summary.currentGradePercent.toFixed(1)}% | Target Grade: ${workoutRuntime.targetTrainerGradePercent?.toFixed(2)}% | Power: ${currentPower}W | Cadence: ${currentCadence}rpm | Speed: ${nextSession.summary.currentSpeedKph.toFixed(1)}km/h`);
            }
        }

        store.setState((currentState) => ({
            ...currentState,
            workout: {
                ...currentState.workout,
                runtime: workoutRuntime
            },
            liveRide: {
                ...currentState.liveRide,
                session: nextSession,
                trainerControlMode,
                commandSequence: nextCommandSequence,
                statusMeta: trainerControlMode === TRAINER_CONTROL_MODES.SIM
                    ? `${workoutRuntime.controlStatus} 当前速度 ${formatNumber(nextSession.summary.currentSpeedKph, 1)} km/h`
                    : `已骑行 ${formatDuration(nextSession.summary.elapsedSeconds)}，当前速度 ${formatNumber(nextSession.summary.currentSpeedKph, 1)} km/h`
            }
        }));
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
}

function buildRuntimeByControlMode({
    trainerControlMode,
    state,
    active,
    rideId = null,
    commandSequence = 0
}) {
    if (trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return buildErgControlState({
            targetPowerWatts: state.settings.power,
            active,
            rideId,
            commandSequence
        });
    }

    if (trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return buildResistanceControlState({
            active,
            rideId,
            commandSequence
        });
    }

    return {
        ...state.workout.runtime,
        pendingTrainerCommand: null
    };
}
