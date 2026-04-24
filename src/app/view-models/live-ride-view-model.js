import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { buildEffectiveSensorSnapshot } from "../realtime/sensor-sampling.js";
import { formatNumber } from "../../shared/format.js";
import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";

export function buildSensorSnapshot(state) {
    const powerMeter = state.ble?.powerMeter ?? {};
    const rideSnapshot = state.liveRide?.snapshot ?? null;
    const effectiveSampling = rideSnapshot?.sampledSensors ?? buildEffectiveSensorSnapshot(state.ble?.sampling);

    return {
        power: effectiveSampling.power,
        cadence: effectiveSampling.cadence,
        heartRate: effectiveSampling.heartRate,
        powerSourceType: effectiveSampling.powerSourceType ?? powerMeter.sourceType ?? "none",
        powerLastUpdated: effectiveSampling.powerTimestamp ?? powerMeter.lastUpdated ?? null,
        heartRateLastUpdated: effectiveSampling.heartRateTimestamp ?? state.ble?.heartRate?.lastUpdated ?? null,
        freshness: effectiveSampling.freshness
    };
}

export function buildRideSnapshot(state) {
    const liveRide = state.liveRide ?? {};
    const snapshot = liveRide.snapshot ?? null;
    const session = snapshot?.session ?? liveRide.session ?? null;
    const route = session?.route ?? state.route ?? null;
    const summary = snapshot?.summary ?? session?.summary ?? null;
    const records = session?.records ?? [];
    const currentRecord = snapshot?.currentRecord ?? records.at(-1) ?? null;
    const metrics = resolveRideMetrics({
        summary,
        records,
        ftp: state.settings?.ftp ?? null
    });
    const totalDistanceKm = route ? route.totalDistanceMeters / 1000 : 0;
    const distanceKm = metrics.ride.distanceKm;
    const remainingKm = Math.max(0, totalDistanceKm - distanceKm);
    const progressPercent = Math.round((metrics.ride.routeProgress ?? 0) * 100);

    return {
        dashboardOpen: Boolean(liveRide.dashboardOpen),
        isActive: Boolean(liveRide.isActive),
        canStart: Boolean(liveRide.canStart),
        snapshot,
        session,
        route,
        summary,
        records,
        currentRecord,
        totalDistanceKm,
        distanceKm,
        remainingKm,
        progressPercent,
        metrics,
        trainerControlMode: liveRide.trainerControlMode ?? null,
        statusMeta: liveRide.statusMeta ?? ""
    };
}

export function buildTrainingSnapshot(state) {
    const workout = state.workout ?? {};
    const rideSnapshot = state.liveRide?.snapshot ?? null;
    const runtime = rideSnapshot?.workoutRuntime ?? workout.runtime ?? {};
    const customWorkoutTarget = rideSnapshot?.customWorkoutTargetPlan ?? state.liveRide?.customWorkoutTargetPlan ?? workout.customWorkoutTarget ?? null;

    return {
        mode: workout.mode,
        modeLabel: getWorkoutModeLabel(workout.mode),
        runtime,
        customWorkoutTarget,
        ftp: state.settings?.ftp ?? 0,
        trainerTarget: resolveTrainerTarget(runtime),
        rideSnapshot
    };
}

export function buildDashboardViewModel({
    state,
    customMetricsState,
    immersiveStreetViewMode = false,
    streetViewLoaded = false
}) {
    const sensor = buildSensorSnapshot(state);
    const ride = buildRideSnapshot(state);
    const training = buildTrainingSnapshot(state);
    const metricsData = buildDashboardMetricsData({
        sensor,
        ride,
        training
    });

    return {
        sensor,
        ride,
        training,
        metricsData,
        immersiveStreetViewMode,
        streetViewLoaded,
        canShowImmersiveStreetView: ride.isActive && streetViewLoaded,
        enabledMetricKeys: Object.entries(customMetricsState)
            .filter(([, isEnabled]) => isEnabled)
            .map(([key]) => key)
    };
}

export function buildPipViewModel(state) {
    const sensor = buildSensorSnapshot(state);
    const ride = buildRideSnapshot(state);
    const training = buildTrainingSnapshot(state);
    const metrics = ride.metrics;

    return {
        distance: formatNumber(ride.distanceKm, 2),
        remaining: formatNumber(ride.remainingKm, 2),
        speed: formatNumber(metrics.speed.currentKph ?? 0, 1),
        power: sensor.power !== null ? String(sensor.power) : "--",
        hr: sensor.heartRate !== null ? String(sensor.heartRate) : "--",
        cadence: sensor.cadence !== null ? String(sensor.cadence) : "--",
        modeLabel: training.modeLabel,
        currentGrade: formatNumber(training.runtime.currentGradePercent ?? metrics.grade.currentPercent ?? 0, 1),
        lookaheadGrade: formatNumber(training.runtime.lookaheadGradePercent ?? 0, 1),
        targetTrainerGrade: formatNumber(training.runtime.targetTrainerGradePercent ?? 0, 1),
        targetControlLabel: training.trainerTarget.label,
        targetControlValue: training.trainerTarget.value,
        targetControlUnit: training.trainerTarget.unit,
        controlStatus: training.runtime.controlStatus,
        route: ride.route,
        currentRecord: ride.currentRecord
    };
}

function buildDashboardMetricsData({ sensor, ride, training }) {
    const metrics = ride.metrics;

    return {
        currentPower: { label: "实时功率", value: sensor.power ?? 0, unit: "W", color: "power-color" },
        avg3sPower: { label: "3秒均功率", value: metrics.power.rolling3sWatts, unit: "W", color: "power-color" },
        currentHr: { label: "当前心率", value: sensor.heartRate ?? 0, unit: "bpm", color: "" },
        currentSpeed: { label: "当前速度", value: formatNumber(metrics.speed.currentKph, 1), unit: "km/h", color: "accent-color" },
        currentCadence: { label: "实时踏频", value: sensor.cadence ?? 0, unit: "rpm", color: "accent-color" },
        pushedGrade: { label: "推送坡度", value: formatNumber(training.runtime.targetTrainerGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        avgPower: { label: "平均功率", value: Math.round(metrics.power.averageWatts ?? 0), unit: "W", color: "power-color" },
        maxPower: { label: "最大功率", value: Math.round(metrics.power.maxWatts ?? 0), unit: "W", color: "power-color" },
        avgHr: { label: "平均心率", value: Math.round(metrics.heartRate.averageBpm ?? 0), unit: "bpm", color: "" },
        currentGrade: { label: "当前坡度", value: formatNumber(metrics.ride.currentGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        tss: { label: "预估 TSS", value: formatNumber(metrics.load.estimatedTss ?? 0, 1), unit: "", color: "accent-color" }
    };
}

function resolveTrainerTarget(runtime) {
    if (runtime.trainerControlMode === TRAINER_CONTROL_MODES.RESISTANCE) {
        return {
            label: "目标阻力",
            value: formatNumber(runtime.targetResistanceLevel ?? 0, 0),
            unit: "%"
        };
    }

    if (runtime.trainerControlMode === TRAINER_CONTROL_MODES.ERG) {
        return {
            label: "目标功率",
            value: formatNumber(runtime.targetErgPowerWatts ?? 0, 0),
            unit: "W"
        };
    }

    return {
        label: "目标坡度",
        value: formatNumber(runtime.targetTrainerGradePercent ?? 0, 1),
        unit: "%"
    };
}
