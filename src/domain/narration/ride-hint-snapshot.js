import { getRouteSampleAtDistance } from "../route/route-builder.js";
import { resolveWorkoutTargetAtElapsed } from "../workout/custom-workout-target.js";

// Called only on an automatic narration trigger, never on every render.
export function buildRideHintSnapshot(state, { item, now = Date.now() } = {}) {
    const ride = state.liveRide ?? {};
    const session = ride.session;
    if (!ride.isActive || !session) return null;
    const records = ride.records ?? session.records ?? [];
    const current = session.currentRecord ?? records.at(-1) ?? {};
    const elapsed = current.elapsedSeconds ?? 0;
    const sensors = session.sampledSensors ?? {};
    const runtime = session.workoutRuntime ?? state.workout?.runtime ?? {};
    const mode = session.trainerControlMode;
    const settings = state.settings ?? {};
    const valid = (key, timestamp) => sensors.freshness?.[key] === true
        && Number.isFinite(timestamp) && now >= timestamp && now - timestamp <= 5000;
    const measured = !["none", "virtual", "virtual-power", "street-view-debug"].includes(sensors.powerSourceType)
        && Boolean(sensors.powerSourceType);
    const distance = (current.distanceKm ?? 0) * 1000;
    const targetPlan = session.customWorkoutTargetPlan;
    const ergElapsed = session.ergElapsedSeconds ?? elapsed;
    const target = resolveWorkoutTargetAtElapsed({ target: targetPlan, elapsedSeconds: ergElapsed, ftp: settings.ftp });
    const next = target?.remainingStepSeconds != null ? resolveWorkoutTargetAtElapsed({
        target: targetPlan, elapsedSeconds: ergElapsed + target.remainingStepSeconds + 0.01, ftp: settings.ftp
    }) : null;
    return {
        captured_at_ms: now, elapsed_s: elapsed, distance_m: distance,
        mode, trainer: { connected: state.ble?.trainer?.isConnected === true,
            control_ready: state.ble?.trainer?.controlReady === true }, target: {
            erg_power_w: mode === "erg" ? finite(runtime.targetErgPowerWatts) : null,
            sim_grade_percent: mode === "sim" && runtime.available !== false ? finite(runtime.targetTrainerGradePercent) : null,
            resistance_percent: mode === "resistance" ? finite(runtime.targetResistanceLevel) : null
        },
        route: { name: session.route?.name ?? "", total_distance_m: session.route?.totalDistanceMeters ?? 0,
            nearby: [distance, distance + 300, distance + 1000].map((at) => {
                const sample = getRouteSampleAtDistance(session.route, Math.min(at, session.route.totalDistanceMeters));
                return { distance_m: Math.min(at, session.route.totalDistanceMeters), grade_percent: session.route.hasElevationData === false ? null : finite(sample.gradePercent) };
            }) },
        card: { title: item.title, summary: item.summary, category: item.category, distance_m: item.route_distance_m },
        athlete: { ftp_w: positive(settings.ftp), max_hr: positive(settings.maxHr), resting_hr: positive(settings.restingHr) },
        sensors: { power_source: sensors.powerSourceType ?? "none", measured_power: measured,
            power: { valid: valid("power", sensors.powerTimestamp), value: finite(sensors.power) },
            heart_rate: { valid: valid("heartRate", sensors.heartRateTimestamp), value: finite(sensors.heartRate) },
            cadence: { valid: valid("cadence", sensors.cadenceTimestamp), value: finite(sensors.cadence) },
            historical_provenance: "unknown: windows may mix measured, virtual or stale samples; no physiological conclusions" },
        windows: [30, 300, 600].map((seconds) => aggregateRideWindow(records, elapsed, seconds)),
        whole_ride: aggregateRideWindow(records, elapsed, elapsed),
        workout: mode === "erg" ? { current: target, next } : { current: null, next: null }
    };
}

export function aggregateRideWindow(records, elapsed, requestedSeconds) {
    const start = Math.max(0, elapsed - requestedSeconds);
    const totals = { power: 0, heartRate: 0, cadence: 0 };
    const coverage = { power: 0, heartRate: 0, cadence: 0 };
    let previous = 0;
    for (const record of records) {
        const end = Number(record.elapsedSeconds);
        if (!Number.isFinite(end) || end <= previous) continue;
        const duration = Math.max(0, Math.min(elapsed, end) - Math.max(start, previous));
        const interval = end - previous;
        previous = end;
        // Normal physics samples are <=1s; gaps must not masquerade as sensor coverage.
        if (interval > 5) continue;
        if (!duration) continue;
        for (const key of Object.keys(totals)) {
            if (Number.isFinite(record[key]) && record[key] >= 0) {
                totals[key] += record[key] * duration;
                coverage[key] += duration;
            }
        }
    }
    return { requested_s: requestedSeconds, actual_s: Math.max(0, elapsed - start),
        means: Object.fromEntries(Object.keys(totals).map((key) => [key, coverage[key] ? totals[key] / coverage[key] : null])),
        coverage_s: coverage };
}
function finite(value) { return Number.isFinite(value) ? value : null; }

function positive(value) { return Number.isFinite(value) && value > 0 ? value : null; }

// Stable across natural ramp progression; changes when the user changes inputs.
export function buildRideHintRevision(state, { active = false, now = Date.now() } = {}) {
    const session = state.liveRide?.session ?? {};
    const sensors = session.sampledSensors ?? {};
    const runtime = session.workoutRuntime ?? state.workout?.runtime ?? {};
    const plan = session.customWorkoutTargetPlan;
    const hasWorkout = plan?.enabled === true && plan?.steps?.length > 0;
    const fresh = (key, timestamp) => sensors.freshness?.[key] === true
        && Number.isFinite(timestamp) && now >= timestamp && now - timestamp <= 5000;
    const identity = [session.startedAt, active, session.trainerControlMode, state.workout?.mode,
        state.settings?.ftp, hasWorkout ? plan : null, runtime.customWorkoutTargetStepIndex,
        hasWorkout ? null : runtime.targetErgPowerWatts, runtime.targetResistanceLevel,
        state.workout?.gradeSimulation, state.ble?.trainer?.isConnected, state.ble?.trainer?.controlReady,
        state.ble?.powerMeter?.isConnected, state.ble?.heartRate?.isConnected,
        sensors.powerSourceType, fresh("power", sensors.powerTimestamp),
        fresh("heartRate", sensors.heartRateTimestamp), fresh("cadence", sensors.cadenceTimestamp)];
    let hash = 2166136261;
    for (const char of JSON.stringify(identity)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return `hint_${hash.toString(16)}`;
}
