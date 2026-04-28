import { getWorkoutModeLabel } from "../../domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../domain/workout/trainer-command.js";
import { buildEffectiveSensorSnapshot } from "../realtime/sensor-sampling.js";
import { formatDuration, formatNumber } from "../../shared/format.js";
import { resolveRideMetrics } from "../../domain/metrics/ride-metrics.js";
import {
    DEFAULT_PIP_METRIC_SELECTION,
    getEnabledMetricKeys,
    normalizeMetricSelection
} from "../../shared/live-metrics.js";

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
        powerSignal: effectiveSampling.powerSignal ?? null,
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
        training,
        settings: state.settings
    });

    return {
        sensor,
        ride,
        training,
        metricsData,
        immersiveStreetViewMode,
        streetViewLoaded,
        canShowImmersiveStreetView: ride.isActive && streetViewLoaded,
        enabledMetricKeys: getEnabledMetricKeys(customMetricsState)
    };
}

export function buildPipViewModel(state) {
    const sensor = buildSensorSnapshot(state);
    const ride = buildRideSnapshot(state);
    const training = buildTrainingSnapshot(state);
    const metrics = ride.metrics;
    const metricsData = buildDashboardMetricsData({
        sensor,
        ride,
        training,
        settings: state.settings
    });
    const pipMetricSelection = normalizeMetricSelection(state.pipConfig, DEFAULT_PIP_METRIC_SELECTION);

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
        currentRecord: ride.currentRecord,
        metricsData,
        enabledMetricKeys: getEnabledMetricKeys(pipMetricSelection),
        pipLayout: state.pipLayout ?? "grid"
    };
}

function buildDashboardMetricsData({ sensor, ride, training, settings = {} }) {
    const metrics = ride.metrics;
    const massKg = Number.isFinite(settings?.mass) && settings.mass > 0 ? settings.mass : null;
    const ftp = Number.isFinite(training.ftp) && training.ftp > 0 ? training.ftp : null;
    const maxHr = Number.isFinite(settings?.maxHr) && settings.maxHr > 0 ? settings.maxHr : null;

    return {
        currentPower: { label: "实时功率", value: sensor.power ?? 0, unit: "W", color: "power-color" },
        avg3sPower: { label: "3秒均功率", value: metrics.power.rolling3sWatts, unit: "W", color: "power-color" },
        avg10sPower: { label: "10秒均功率", value: metrics.power.rolling10sWatts, unit: "W", color: "power-color" },
        currentHr: { label: "当前心率", value: sensor.heartRate ?? 0, unit: "bpm", color: "" },
        currentSpeed: { label: "当前速度", value: formatNumber(metrics.speed.currentKph, 1), unit: "km/h", color: "accent-color" },
        avgSpeed: { label: "平均速度", value: formatNumber(metrics.speed.averageKph, 1), unit: "km/h", color: "accent-color" },
        maxSpeed: { label: "最高速度", value: formatNumber(metrics.speed.maxKph, 1), unit: "km/h", color: "accent-color" },
        distanceKm: { label: "骑行距离", value: formatNumber(ride.distanceKm, 2), unit: "km", color: "" },
        remainingKm: { label: "剩余距离", value: formatNumber(ride.remainingKm, 2), unit: "km", color: "" },
        elapsedTime: { label: "骑行时间", value: formatDuration(metrics.ride.elapsedSeconds), unit: "", color: "accent-color" },
        routeProgress: { label: "路线进度", value: Math.round((metrics.ride.routeProgress ?? 0) * 100), unit: "%", color: "accent-color" },
        ascentMeters: { label: "累计爬升", value: Math.round(metrics.ride.ascentMeters ?? 0), unit: "m", color: "climb-color" },
        currentCadence: { label: "实时踏频", value: sensor.cadence ?? 0, unit: "rpm", color: "accent-color" },
        pushedGrade: { label: "推送坡度", value: formatNumber(training.runtime.targetTrainerGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        avgPower: { label: "平均功率", value: Math.round(metrics.power.averageWatts ?? 0), unit: "W", color: "power-color" },
        maxPower: { label: "最大功率", value: Math.round(metrics.power.maxWatts ?? 0), unit: "W", color: "power-color" },
        normalizedPower: { label: "标准化功率", value: Math.round(metrics.power.normalizedPowerWatts ?? 0), unit: "W", color: "power-color" },
        powerPerKg: { label: "实时 W/kg", value: formatWattsPerKg(sensor.power, massKg), unit: "W/kg", color: "power-color" },
        avgPowerPerKg: { label: "平均 W/kg", value: formatWattsPerKg(metrics.power.averageWatts, massKg), unit: "W/kg", color: "power-color" },
        powerZone: { label: "功率区间", value: formatPowerZone(sensor.power, ftp), unit: "", color: "power-color" },
        avgHr: { label: "平均心率", value: Math.round(metrics.heartRate.averageBpm ?? 0), unit: "bpm", color: "" },
        maxHr: { label: "最大心率", value: Math.round(metrics.heartRate.maxBpm ?? 0), unit: "bpm", color: "" },
        hrZone: { label: "心率区间", value: formatHeartRateZone(sensor.heartRate, maxHr), unit: "", color: "" },
        avgCadence: { label: "平均踏频", value: metrics.cadence.averageRpm !== null ? Math.round(metrics.cadence.averageRpm) : 0, unit: "rpm", color: "accent-color" },
        maxCadence: { label: "最大踏频", value: metrics.cadence.maxRpm !== null ? Math.round(metrics.cadence.maxRpm) : 0, unit: "rpm", color: "accent-color" },
        currentGrade: { label: "当前坡度", value: formatNumber(metrics.ride.currentGradePercent ?? 0, 1), unit: "%", color: "climb-color" },
        lookaheadGrade: { label: "前方坡度", value: formatNumber(training.runtime.lookaheadGradePercent ?? 0, 1), unit: "%", color: "accent-color" },
        avgGrade: { label: "平均坡度", value: formatNumber(metrics.grade.averagePercent ?? 0, 1), unit: "%", color: "climb-color" },
        maxClimbGrade: { label: "最大爬坡", value: formatNumber(metrics.grade.maxPositivePercent ?? 0, 1), unit: "%", color: "climb-color" },
        maxDescentGrade: { label: "最大下坡", value: formatNumber(metrics.grade.maxNegativePercent ?? 0, 1), unit: "%", color: "accent-color" },
        targetControl: { label: training.trainerTarget.label, value: training.trainerTarget.value, unit: training.trainerTarget.unit, color: "power-color" },
        intensityFactor: { label: "强度系数 IF", value: formatNullableNumber(metrics.power.intensityFactor, 2), unit: "", color: "power-color" },
        variabilityIndex: { label: "变异指数 VI", value: formatNullableNumber(metrics.power.variabilityIndex, 2), unit: "", color: "power-color" },
        tss: { label: "预估 TSS", value: formatNumber(metrics.load.estimatedTss ?? 0, 1), unit: "", color: "accent-color" },
        powerSource: { label: "功率来源", value: formatPowerSource(sensor.powerSourceType), unit: "", color: "" },
        powerSignalHz: { label: "功率频率", value: formatNullableNumber(sensor.powerSignal?.estimatedHz, 1), unit: "Hz", color: "" },
        powerSignalJitter: { label: "功率抖动", value: formatNullableNumber(sensor.powerSignal?.jitterMs, 0), unit: "ms", color: "" },
        powerSignalStatus: { label: "功率信号", value: formatPowerSignalStatus(sensor), unit: "", color: sensor.powerSignal?.isStable ? "accent-color" : "" }
    };
}

function formatNullableNumber(value, digits) {
    return Number.isFinite(value) ? formatNumber(value, digits) : "--";
}

function formatWattsPerKg(powerWatts, massKg) {
    if (!Number.isFinite(powerWatts) || !Number.isFinite(massKg) || massKg <= 0) {
        return "--";
    }

    return formatNumber(powerWatts / massKg, 2);
}

function formatPowerZone(powerWatts, ftp) {
    if (!Number.isFinite(powerWatts) || !Number.isFinite(ftp) || ftp <= 0) {
        return "--";
    }

    const ratio = powerWatts / ftp;
    if (ratio < 0.55) return "Z1";
    if (ratio < 0.75) return "Z2";
    if (ratio < 0.9) return "Z3";
    if (ratio < 1.05) return "Z4";
    if (ratio < 1.2) return "Z5";
    return "Z6";
}

function formatHeartRateZone(heartRate, maxHr) {
    if (!Number.isFinite(heartRate) || !Number.isFinite(maxHr) || maxHr <= 0) {
        return "--";
    }

    const ratio = heartRate / maxHr;
    if (ratio < 0.6) return "Z1";
    if (ratio < 0.7) return "Z2";
    if (ratio < 0.8) return "Z3";
    if (ratio < 0.9) return "Z4";
    return "Z5";
}

function formatPowerSource(sourceType) {
    if (sourceType === "external-power-meter") return "外置功率计";
    if (sourceType === "trainer") return "骑行台";
    return "无";
}

function formatPowerSignalStatus(sensor) {
    if (sensor.freshness?.power !== true) {
        return "无信号";
    }

    return sensor.powerSignal?.isStable ? "稳定" : "波动";
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
