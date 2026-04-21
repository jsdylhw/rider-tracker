import {
    buildWorkoutTargetRuntime,
    resolveWorkoutTargetAtElapsed,
    sanitizeCustomWorkoutTarget,
    WORKOUT_TARGET_BLOCK_TYPES
} from "../../src/domain/workout/custom-workout-target.js";
import { assertEqual } from "../helpers/test-harness.js";

const target = sanitizeCustomWorkoutTarget({
    enabled: true,
    steps: [
        { id: "warmup", durationMinutes: 5, ftpPercent: 80 },
        { id: "interval", durationMinutes: 10, ftpPercent: 105 }
    ]
});

export const suite = {
    name: "custom-workout-target",
    tests: [
        {
            name: "resolveWorkoutTargetAtElapsed resolves active step and watts from ftp",
            run() {
                const result = resolveWorkoutTargetAtElapsed({
                    target,
                    elapsedSeconds: 360,
                    ftp: 250
                });

                assertEqual(result.stepId, "interval");
                assertEqual(result.stepIndex, 1);
                assertEqual(result.ftpPercent, 105);
                assertEqual(result.targetPowerWatts, 263);
                assertEqual(result.remainingStepSeconds, 540);
            }
        },
        {
            name: "resolveWorkoutTargetAtElapsed interpolates ramp up blocks",
            run() {
                const rampTarget = sanitizeCustomWorkoutTarget({
                    enabled: true,
                    steps: [
                        {
                            id: "ramp-up",
                            blockType: WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP,
                            durationMinutes: 10,
                            ftpPercent: 80,
                            endFtpPercent: 100
                        }
                    ]
                });
                const result = resolveWorkoutTargetAtElapsed({
                    target: rampTarget,
                    elapsedSeconds: 300,
                    ftp: 250
                });

                assertEqual(result.blockType, WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP);
                assertEqual(result.ftpPercent, 90);
                assertEqual(result.targetPowerWatts, 225);
                assertEqual(result.stepLabel, "第 1 段 · 线性增加");
            }
        },
        {
            name: "buildWorkoutTargetRuntime keeps ramp down boundaries",
            run() {
                const rampTarget = sanitizeCustomWorkoutTarget({
                    enabled: true,
                    steps: [
                        {
                            id: "ramp-down",
                            blockType: WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN,
                            durationMinutes: 4,
                            ftpPercent: 100,
                            endFtpPercent: 85
                        }
                    ]
                });
                const runtime = buildWorkoutTargetRuntime({
                    target: rampTarget,
                    elapsedSeconds: 120,
                    ftp: 260
                });

                assertEqual(runtime.customWorkoutTargetBlockType, WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN);
                assertEqual(runtime.customWorkoutTargetFtpPercent, 92.5);
                assertEqual(runtime.customWorkoutTargetStartFtpPercent, 100);
                assertEqual(runtime.customWorkoutTargetEndFtpPercent, 85);
                assertEqual(runtime.customWorkoutTargetPowerWatts, 241);
            }
        },
        {
            name: "buildWorkoutTargetRuntime marks completed when elapsed exceeds all steps",
            run() {
                const runtime = buildWorkoutTargetRuntime({
                    target,
                    elapsedSeconds: 1200,
                    ftp: 250
                });

                assertEqual(runtime.customWorkoutTargetEnabled, true);
                assertEqual(runtime.customWorkoutTargetCompleted, true);
                assertEqual(runtime.customWorkoutTargetPowerWatts, null);
                assertEqual(runtime.customWorkoutTargetStepLabel, "训练目标已完成");
            }
        }
    ]
};
