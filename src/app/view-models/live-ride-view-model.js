import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { formatNumber } from "../../shared/format.js";

export function buildSensorSnapshot(state) {
    const powerMeter = state.ble?.powerMeter ?? {};
    const heartRate = state.ble?.heartRate ?? {};

    return {
        power: powerMeter.power ?? null,
        cadence: powerMeter.cadence ?? null,
        heartRate: heartRate.value ?? null,
        powerSourceType: powerMeter.sourceType ?? "none",
        powerLastUpdated: powerMeter.lastUpdated ?? null,
        heartRateLastUpdated: heartRate.lastUpdated ?? null
    };
}

export function buildRideSnapshot(state) {
    const liveRide = state.liveRide ?? {};
    const session = liveRide.session ?? null;
    const route = session?.route ?? state.route ?? null;
    const summary = session?.summary ?? null;
    const records = session?.records ?? [];
    const currentRecord = records.at(-1) ?? null;
    const totalDistanceKm = route ? route.totalDistanceMeters / 1000 : 0;
    const distanceKm = summary?.distanceKm ?? 0;
    const remainingKm = Math.max(0, totalDistanceKm - distanceKm);
    const progressPercent = Math.round((summary?.routeProgress ?? 0) * 100);

    return {
        dashboardOpen: Boolean(liveRide.dashboardOpen),
        isActive: Boolean(liveRide.isActive),
        canStart: Boolean(liveRide.canStart),
        session,
        route,
        summary,
        records,
        currentRecord,
        totalDistanceKm,
        distanceKm,
        remainingKm,
        progressPercent,
        trainerControlMode: liveRide.trainerControlMode ?? null,
        statusMeta: liveRide.statusMeta ?? ""
    };
}

export function buildTrainingSnapshot(state) {
    const workout = state.workout ?? {};
    const runtime = workout.runtime ?? {};
    const customWorkoutTarget = state.liveRide?.customWorkoutTargetPlan ?? workout.customWorkoutTarget ?? null;

    return {
        mode: workout.mode,
        modeLabel: getWorkoutModeLabel(workout.mode),
        runtime,
        customWorkoutTarget,
        ftp: state.settings?.ftp ?? 0,
        trainerTarget: resolveTrainerTarget(runtime)
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

    return {
        distance: formatNumber(ride.distanceKm, 2),
        remaining: formatNumber(ride.remainingKm, 2),
        speed: ride.summary ? formatNumber(ride.summary.currentSpeedKph ?? 0, 1) : "--",
        power: sensor.power !== null ? String(sensor.power) : "--",
        hr: sensor.heartRate !== null ? String(sensor.heartRate) : "--",
        cadence: sensor.cadence !== null ? String(sensor.cadence) : "--",
        modeLabel: training.modeLabel,
        currentGrade: formatNumber(training.runtime.currentGradePercent ?? ride.summary?.currentGradePercent ?? 0, 1),
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
    const avg3sPower = computeAvg3sPower(ride.records);
    const summary = ride.summary;

    return {
        currentPower: { label: "实时功率", value: sensor.power ?? 0, unit: "W", color: "power-color" },
        avg3sPower: { label: "3秒均功率", value: avg3sPower, unit: "W", color: "power-color" },
        currentHr: { label: "当前心率", value: sensor.heartRate ?? 0, unit: "bpm", color: "" },
        currentSpeed: { label: "当前速度", value: formatNumber(summary?.currentSpeedKph ?? 0, 1), unit: "km/h", color: "accent-color" },
        currentCadence: { label: "实时踏频", value: sensor.cadence ?? 0, unit: "rpm", color: "accent-color" },
        pushedGrade: { label: "推送坡度", value: formatNumber(training.runtime.targetTrainerGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        avgPower: { label: "平均功率", value: Math.round(summary?.averagePower ?? 0), unit: "W", color: "power-color" },
        maxPower: { label: "最大功率", value: Math.round(summary?.maxPower ?? 0), unit: "W", color: "power-color" },
        avgHr: { label: "平均心率", value: Math.round(summary?.averageHeartRate ?? 0), unit: "bpm", color: "" },
        currentGrade: { label: "当前坡度", value: formatNumber(summary?.currentGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        tss: { label: "预估 TSS", value: formatNumber(summary?.estimatedTss ?? 0, 1), unit: "", color: "accent-color" }
    };
}

function computeAvg3sPower(records) {
    if (!records.length) {
        return 0;
    }

    const last3 = records.slice(-3);
    return Math.round(last3.reduce((sum, record) => sum + (record.power || 0), 0) / last3.length);
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
