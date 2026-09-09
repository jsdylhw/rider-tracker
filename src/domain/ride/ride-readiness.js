import { isRouteReadyForRide } from "../route/route-builder.js";
import { WORKOUT_MODES } from "../workout/workout-mode.js";

export function deriveRideReadiness({
    route,
    workout,
    rideInput,
    ble,
    debugEnabled = false
} = {}) {
    const blockers = [];
    const warnings = [];
    const requirements = {
        route: "ready",
        powerSource: "ready",
        trainerControl: "ready"
    };

    const virtualPower = debugEnabled && rideInput?.powerSource === "virtual";
    validateRoute(route, workout?.mode, blockers, requirements, { allowMissingElevation: virtualPower });
    if (virtualPower) {
        requirements.powerSource = "debug-virtual";
        requirements.trainerControl = "not-required";
        warnings.push(issue(
            "debug_virtual_power",
            "当前使用 debug 模拟功率，不会验证或控制真实骑行台。"
        ));
    } else {
        validatePowerSource(ble?.powerMeter, blockers, warnings, requirements);
        validateTrainer(ble?.trainer, workout?.mode, blockers, warnings, requirements);
    }

    return {
        canStart: blockers.length === 0,
        blockers,
        warnings,
        requirements,
        debugVirtualPower: virtualPower
    };
}

export function formatReadinessMessages(issues) {
    const messages = (issues ?? [])
        .map((item) => String(item?.message ?? "").trim().replace(/[。；;]+$/u, ""))
        .filter(Boolean);
    return messages.length > 0 ? `${messages.join("；")}。` : "";
}

function validateRoute(route, workoutMode, blockers, requirements, { allowMissingElevation = false } = {}) {
    if (route?.isLoading === true) {
        requirements.route = "loading";
        blockers.push(issue("route_loading", "路线仍在处理中，请等待完成。"));
        return;
    }
    if (route?.isDraft === true) {
        requirements.route = "draft";
        blockers.push(issue("route_not_confirmed", "路线仍是草稿，请先最终确认。"));
        return;
    }
    if (!isRouteReadyForRide(route)) {
        requirements.route = "missing";
        blockers.push(issue("route_not_ready", "请先设置一条有效路线。"));
        return;
    }
    if (!allowMissingElevation && workoutMode === WORKOUT_MODES.GRADE_SIM && route?.hasElevationData === false) {
        requirements.route = "missing-elevation";
        blockers.push(issue(
            "route_elevation_required",
            "当前路线没有海拔数据，不能使用坡度模拟；请切换 ERG/固定阻力或加载带海拔路线。"
        ));
    }
}

function validatePowerSource(powerMeter, blockers, warnings, requirements) {
    const sourceType = String(powerMeter?.sourceType || "none");
    if (sourceType === "none" || powerMeter?.isConnected !== true) {
        requirements.powerSource = "missing";
        blockers.push(issue("power_source_missing", "请连接骑行台功率或外置功率计。"));
        return;
    }
    if (!Number.isFinite(Number(powerMeter?.lastUpdated))) {
        requirements.powerSource = "connected-no-data";
        warnings.push(issue("power_data_pending", "功率源已连接，正在等待首个功率数据。"));
    }
}

function validateTrainer(trainer, workoutMode, blockers, warnings, requirements) {
    if (trainer?.connectionState === "error" || trainer?.lastError) {
        requirements.trainerControl = "error";
        blockers.push(issue(
            "trainer_error",
            trainer?.lastError?.message || "骑行台连接或控制发生错误。"
        ));
        return;
    }
    if (trainer?.isConnected !== true) {
        requirements.trainerControl = "missing";
        blockers.push(issue("trainer_missing", "当前控制模式需要连接智能骑行台。"));
        return;
    }

    const capability = requiredCapability(workoutMode);
    const supported = trainer?.capabilities?.[capability];
    if (supported === false) {
        requirements.trainerControl = "unsupported";
        blockers.push(issue(
            `trainer_${capability}_unsupported`,
            unsupportedModeMessage(workoutMode)
        ));
        return;
    }
    if (supported !== true) {
        requirements.trainerControl = "capability-unknown";
        warnings.push(issue(
            `trainer_${capability}_unknown`,
            "骑行台没有可靠返回当前模式能力，开始时将尝试最佳努力激活。"
        ));
    }
    if (trainer?.controlState === "error") {
        requirements.trainerControl = "error";
        blockers.push(issue("trainer_control_error", "骑行台控制激活失败，请重试连接或切换模式。"));
    }
}

function requiredCapability(workoutMode) {
    if (workoutMode === WORKOUT_MODES.FIXED_POWER) return "powerSupported";
    if (workoutMode === WORKOUT_MODES.GRADE_SIM) return "gradeControlSupported";
    return "resistanceSupported";
}

function unsupportedModeMessage(workoutMode) {
    if (workoutMode === WORKOUT_MODES.FIXED_POWER) return "当前骑行台不支持 ERG 目标功率控制。";
    if (workoutMode === WORKOUT_MODES.GRADE_SIM) return "当前骑行台不支持坡度模拟控制。";
    return "当前骑行台不支持固定阻力控制。";
}

function issue(code, message) {
    return { code, message };
}
