import { clamp } from "../../shared/utils/common.js";

export const WORKOUT_TARGET_BLOCK_TYPES = {
    STEADY: "steady",
    RAMP_UP: "ramp-up",
    RAMP_DOWN: "ramp-down"
};

export function createDefaultCustomWorkoutTarget() {
    return {
        enabled: false,
        steps: [
            createWorkoutTargetStep({
                id: "step-1",
                blockType: WORKOUT_TARGET_BLOCK_TYPES.STEADY,
                durationMinutes: 8,
                ftpPercent: 88
            }),
            createWorkoutTargetStep({
                id: "step-2",
                blockType: WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP,
                durationMinutes: 6,
                ftpPercent: 92,
                endFtpPercent: 105
            }),
            createWorkoutTargetStep({
                id: "step-3",
                blockType: WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN,
                durationMinutes: 4,
                ftpPercent: 100,
                endFtpPercent: 88
            })
        ]
    };
}

export function createWorkoutTargetStep(step = {}) {
    const blockType = normalizeBlockType(step.blockType);
    const ftpPercent = clamp(Number(step.ftpPercent), 40, 200, 90);
    const fallbackEnd = blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP
        ? Math.min(200, ftpPercent + 10)
        : blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN
            ? Math.max(40, ftpPercent - 10)
            : ftpPercent;

    return {
        id: step.id ?? `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blockType,
        durationMinutes: clamp(Number(step.durationMinutes), 1, 180, 10),
        ftpPercent,
        endFtpPercent: normalizeEndFtpPercent({
            blockType,
            ftpPercent,
            endFtpPercent: step.endFtpPercent,
            fallbackEnd
        })
    };
}

export function sanitizeCustomWorkoutTarget(target = createDefaultCustomWorkoutTarget()) {
    const normalized = target ?? {};
    const steps = Array.isArray(normalized.steps) && normalized.steps.length > 0
        ? normalized.steps.map((step) => createWorkoutTargetStep(step))
        : createDefaultCustomWorkoutTarget().steps;

    return {
        enabled: Boolean(normalized.enabled),
        steps
    };
}

export function getWorkoutTargetTotalSeconds(target) {
    const normalized = sanitizeCustomWorkoutTarget(target);
    return normalized.steps.reduce((sum, step) => sum + Math.round(step.durationMinutes * 60), 0);
}

export function resolveWorkoutTargetAtElapsed({ target, elapsedSeconds = 0, ftp = 0 }) {
    const normalized = sanitizeCustomWorkoutTarget(target);
    if (!normalized.enabled || normalized.steps.length === 0) {
        return null;
    }

    const safeElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));
    const totalDurationSeconds = getWorkoutTargetTotalSeconds(normalized);
    const safeFtp = clamp(Number(ftp), 1, 5000, 250);
    let cumulativeSeconds = 0;

    for (let index = 0; index < normalized.steps.length; index += 1) {
        const step = normalized.steps[index];
        const stepDurationSeconds = Math.round(step.durationMinutes * 60);
        const nextBoundary = cumulativeSeconds + stepDurationSeconds;

        if (safeElapsedSeconds < nextBoundary) {
            const elapsedInStepSeconds = safeElapsedSeconds - cumulativeSeconds;
            const progressInStep = stepDurationSeconds > 0
                ? Math.min(1, elapsedInStepSeconds / stepDurationSeconds)
                : 0;
            const currentFtpPercent = resolveStepFtpPercent(step, progressInStep);
            const targetPowerWatts = Math.round(safeFtp * (currentFtpPercent / 100));

            return {
                isActive: true,
                planCompleted: false,
                stepId: step.id,
                stepIndex: index,
                stepLabel: `第 ${index + 1} 段 · ${getBlockTypeLabel(step.blockType)}`,
                totalSteps: normalized.steps.length,
                blockType: step.blockType,
                durationMinutes: step.durationMinutes,
                durationSeconds: stepDurationSeconds,
                ftpPercent: currentFtpPercent,
                startFtpPercent: step.ftpPercent,
                endFtpPercent: step.endFtpPercent,
                targetPowerWatts,
                elapsedInStepSeconds,
                remainingStepSeconds: Math.max(0, stepDurationSeconds - elapsedInStepSeconds),
                totalDurationSeconds,
                planProgress: totalDurationSeconds > 0 ? safeElapsedSeconds / totalDurationSeconds : 0
            };
        }

        cumulativeSeconds = nextBoundary;
    }

    return {
        isActive: false,
        planCompleted: true,
        stepId: null,
        stepIndex: null,
        stepLabel: "训练目标已完成",
        totalSteps: normalized.steps.length,
        blockType: null,
        durationMinutes: 0,
        durationSeconds: 0,
        ftpPercent: null,
        startFtpPercent: null,
        endFtpPercent: null,
        targetPowerWatts: null,
        elapsedInStepSeconds: 0,
        remainingStepSeconds: 0,
        totalDurationSeconds,
        planProgress: 1
    };
}

export function buildWorkoutTargetRuntime({ target, elapsedSeconds = 0, ftp = 0 }) {
    const normalized = sanitizeCustomWorkoutTarget(target);
    const resolved = resolveWorkoutTargetAtElapsed({
        target: normalized,
        elapsedSeconds,
        ftp
    });

    return {
        customWorkoutTargetEnabled: normalized.enabled,
        customWorkoutTargetSteps: normalized.steps,
        customWorkoutTargetTotalSeconds: getWorkoutTargetTotalSeconds(normalized),
        customWorkoutTargetActive: Boolean(resolved?.isActive),
        customWorkoutTargetCompleted: Boolean(resolved?.planCompleted),
        customWorkoutTargetStepIndex: resolved?.stepIndex ?? null,
        customWorkoutTargetStepLabel: resolved?.stepLabel ?? "未启用自定义训练目标",
        customWorkoutTargetBlockType: resolved?.blockType ?? null,
        customWorkoutTargetPowerWatts: resolved?.targetPowerWatts ?? null,
        customWorkoutTargetFtpPercent: resolved?.ftpPercent ?? null,
        customWorkoutTargetStartFtpPercent: resolved?.startFtpPercent ?? null,
        customWorkoutTargetEndFtpPercent: resolved?.endFtpPercent ?? null,
        customWorkoutTargetRemainingSeconds: resolved?.remainingStepSeconds ?? null,
        customWorkoutTargetProgress: resolved?.planProgress ?? 0
    };
}

export function enrichRuntimeWithWorkoutTarget(runtime, workoutTargetRuntime) {
    const enrichedRuntime = {
        ...runtime,
        ...workoutTargetRuntime
    };

    if (!workoutTargetRuntime.customWorkoutTargetEnabled) {
        return enrichedRuntime;
    }

    if (workoutTargetRuntime.customWorkoutTargetActive) {
        enrichedRuntime.controlStatus = `${runtime.controlStatus} 当前训练目标：${workoutTargetRuntime.customWorkoutTargetStepLabel} / ${formatFtpRange(workoutTargetRuntime)} / ${workoutTargetRuntime.customWorkoutTargetPowerWatts}W。`;
        return enrichedRuntime;
    }

    if (workoutTargetRuntime.customWorkoutTargetCompleted) {
        enrichedRuntime.controlStatus = `${runtime.controlStatus} 自定义训练目标已完成。`;
        return enrichedRuntime;
    }

    enrichedRuntime.controlStatus = `${runtime.controlStatus} 已启用自定义训练目标，总时长 ${Math.round((workoutTargetRuntime.customWorkoutTargetTotalSeconds ?? 0) / 60)} 分钟。`;
    return enrichedRuntime;
}

export function getBlockTypeLabel(blockType) {
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP) {
        return "线性增加";
    }
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN) {
        return "线性减少";
    }
    return "恒定";
}

function normalizeBlockType(blockType) {
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP) {
        return WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP;
    }
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN) {
        return WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN;
    }
    return WORKOUT_TARGET_BLOCK_TYPES.STEADY;
}

function normalizeEndFtpPercent({ blockType, ftpPercent, endFtpPercent, fallbackEnd }) {
    const normalizedEnd = clamp(Number(endFtpPercent), 40, 200, fallbackEnd);
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP) {
        return Math.max(ftpPercent, normalizedEnd);
    }
    if (blockType === WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN) {
        return Math.min(ftpPercent, normalizedEnd);
    }
    return ftpPercent;
}

function resolveStepFtpPercent(step, progressInStep) {
    if (step.blockType === WORKOUT_TARGET_BLOCK_TYPES.STEADY) {
        return step.ftpPercent;
    }

    const delta = step.endFtpPercent - step.ftpPercent;
    return Math.round((step.ftpPercent + delta * progressInStep) * 10) / 10;
}

function formatFtpRange(runtime) {
    const start = runtime.customWorkoutTargetStartFtpPercent;
    const end = runtime.customWorkoutTargetEndFtpPercent;
    if (start === null || start === undefined) {
        return `${runtime.customWorkoutTargetFtpPercent}% FTP`;
    }
    if (start === end) {
        return `${start}% FTP`;
    }
    return `${start}% -> ${end}% FTP`;
}
