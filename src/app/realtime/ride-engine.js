import { advanceLiveRideSession } from "../../domain/ride/live-ride-session.js";
import { buildGradeSimulationState } from "../../domain/workout/grade-sim-mode.js";
import { buildErgControlState } from "../../domain/workout/erg-mode.js";
import { buildResistanceControlState } from "../../domain/workout/resistance-mode.js";
import {
    buildWorkoutTargetRuntime,
    enrichRuntimeWithWorkoutTarget,
    resolveWorkoutTargetAtElapsed
} from "../../domain/workout/custom-workout-target.js";
import { resolveTrainerControlModeForWorkoutMode, TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { formatDuration, formatNumber } from "../../shared/format.js";

export function buildNextRideSnapshot({
    state,
    sampledSensors,
    dt = 1
}) {
    const trainerControlMode = state.liveRide.trainerControlMode
        ?? resolveTrainerControlModeForWorkoutMode(state.workout.mode);
    const customWorkoutTargetPlan = state.liveRide.customWorkoutTargetPlan ?? state.workout.customWorkoutTarget;
    const nextCommandSequence = (state.liveRide.commandSequence ?? 0) + 1;
    const rideId = state.liveRide.startedAt ?? state.liveRide.session.startedAt;
    const nextElapsedSeconds = (state.liveRide.session.summary?.elapsedSeconds ?? 0) + dt;
    const resolvedWorkoutTarget = resolveWorkoutTargetAtElapsed({
        target: customWorkoutTargetPlan,
        elapsedSeconds: nextElapsedSeconds,
        ftp: state.settings.ftp
    });

    const nextSession = advanceLiveRideSession({
        session: state.liveRide.session,
        power: sampledSensors.power ?? 0,
        heartRate: sampledSensors.heartRate,
        cadence: sampledSensors.cadence,
        workoutTarget: resolvedWorkoutTarget,
        dt
    });

    const workoutTargetRuntime = buildWorkoutTargetRuntime({
        target: customWorkoutTargetPlan,
        elapsedSeconds: nextSession.summary.elapsedSeconds,
        ftp: state.settings.ftp
    });

    const workoutRuntime = trainerControlMode === TRAINER_CONTROL_MODES.SIM
        ? enrichRuntimeWithWorkoutTarget(buildGradeSimulationState({
            route: nextSession.route,
            distanceMeters: nextSession.physicsState.distanceMeters,
            previousTargetGradePercent: state.workout.runtime.targetTrainerGradePercent ?? 0,
            config: state.workout.gradeSimulation,
            active: true,
            rideId,
            commandSequence: nextCommandSequence
        }), workoutTargetRuntime)
        : buildRuntimeByControlMode({
            trainerControlMode,
            state,
            active: true,
            rideId,
            commandSequence: nextCommandSequence,
            customWorkoutTargetPlan,
            elapsedSeconds: nextSession.summary.elapsedSeconds
        });

    return buildRideSnapshot({
        sampledSensors,
        trainerControlMode,
        customWorkoutTargetPlan,
        nextCommandSequence,
        nextSession,
        workoutRuntime
    });
}

export function buildInitialRideSnapshot({
    session,
    sampledSensors,
    trainerControlMode,
    customWorkoutTargetPlan,
    workoutRuntime,
    statusMeta = ""
}) {
    return buildRideSnapshot({
        sampledSensors,
        trainerControlMode,
        customWorkoutTargetPlan,
        nextCommandSequence: 0,
        nextSession: session,
        workoutRuntime,
        statusMetaOverride: statusMeta
    });
}

export function buildRuntimeByControlMode({
    trainerControlMode,
    state,
    active,
    rideId = null,
    commandSequence = 0,
    customWorkoutTargetPlan = null,
    elapsedSeconds = 0
}) {
    const workoutTargetRuntime = buildWorkoutTargetRuntime({
        target: customWorkoutTargetPlan ?? state.workout.customWorkoutTarget,
        elapsedSeconds,
        ftp: state.settings.ftp
    });

    if (trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return enrichRuntimeWithWorkoutTarget(buildErgControlState({
            targetPowerWatts: workoutTargetRuntime.customWorkoutTargetPowerWatts ?? state.settings.power,
            active,
            rideId,
            commandSequence
        }), workoutTargetRuntime);
    }

    if (trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return enrichRuntimeWithWorkoutTarget(buildResistanceControlState({
            active,
            rideId,
            commandSequence
        }), workoutTargetRuntime);
    }

    return enrichRuntimeWithWorkoutTarget({
        ...state.workout.runtime,
        pendingTrainerCommand: null
    }, workoutTargetRuntime);
}

export function buildRideLogMessage(rideSnapshot) {
    const power = rideSnapshot.sampledSensors.power ?? 0;
    const cadence = rideSnapshot.sampledSensors.cadence ?? 0;

    if (rideSnapshot.pendingTrainerCommand) {
        const cmd = rideSnapshot.pendingTrainerCommand;
        const targetGradePercent = cmd.targetGradePercent ?? cmd.payload?.gradePercent;
        return `[Ride Log] Distance: ${rideSnapshot.session.physicsState.distanceMeters.toFixed(1)}m | Current Grade: ${rideSnapshot.summary.currentGradePercent.toFixed(1)}% | Power: ${power}W | Cadence: ${cadence}rpm | Speed: ${rideSnapshot.summary.currentSpeedKph.toFixed(1)}km/h | Next Target Grade: ${targetGradePercent?.toFixed(2)}%`;
    }

    return `[Ride Log] Distance: ${rideSnapshot.session.physicsState.distanceMeters.toFixed(1)}m | Current Grade: ${rideSnapshot.summary.currentGradePercent.toFixed(1)}% | Target Grade: ${rideSnapshot.workoutRuntime.targetTrainerGradePercent?.toFixed(2)}% | Power: ${power}W | Cadence: ${cadence}rpm | Speed: ${rideSnapshot.summary.currentSpeedKph.toFixed(1)}km/h`;
}

function buildRideSnapshot({
    sampledSensors,
    trainerControlMode,
    customWorkoutTargetPlan,
    nextCommandSequence,
    nextSession,
    workoutRuntime,
    statusMetaOverride = null
}) {
    const currentRecord = nextSession.records.at(-1) ?? null;

    return {
        sampledSensors,
        trainerControlMode,
        customWorkoutTargetPlan,
        commandSequence: nextCommandSequence,
        session: nextSession,
        summary: nextSession.summary,
        currentRecord,
        workoutRuntime,
        pendingTrainerCommand: workoutRuntime.pendingTrainerCommand ?? null,
        statusMeta: statusMetaOverride ?? buildRideStatusMeta({
            trainerControlMode,
            workoutRuntime,
            nextSession
        })
    };
}

function buildRideStatusMeta({ trainerControlMode, workoutRuntime, nextSession }) {
    return trainerControlMode === TRAINER_CONTROL_MODES.SIM
        ? `${workoutRuntime.controlStatus} 当前速度 ${formatNumber(nextSession.summary.currentSpeedKph, 1)} km/h`
        : `已骑行 ${formatDuration(nextSession.summary.elapsedSeconds)}，当前速度 ${formatNumber(nextSession.summary.currentSpeedKph, 1)} km/h`;
}
