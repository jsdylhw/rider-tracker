import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { buildErgPowerChartSvg, buildWorkoutTargetChartSvg } from "./svg/dashboard-charts.js";

export function createWorkoutRuntimeRenderer({ elements }) {
    function render({ liveSession, training, records }) {
        const runtime = liveSession?.workoutRuntime ?? training?.runtime ?? {};
        const effectiveRecords = records ?? [];
        const effectiveTraining = liveSession
            ? {
                ...training,
                runtime,
                customWorkoutTarget: liveSession.customWorkoutTargetPlan ?? training?.customWorkoutTarget,
                liveSession
            }
            : (training ?? {});

        renderWorkoutTargetHud(runtime, effectiveRecords, effectiveTraining);
        renderWorkoutTargetChart(effectiveRecords, effectiveTraining);
    }

    function renderWorkoutTargetHud(runtime, records, training) {
        const isFixedPower = training?.mode === WORKOUT_MODES.FIXED_POWER;
        const shouldShowErgHud = isFixedPower && !runtime.customWorkoutTargetEnabled;

        if (elements.workoutTargetHudCard) {
            elements.workoutTargetHudCard.hidden = !runtime.customWorkoutTargetEnabled && !shouldShowErgHud;
            elements.workoutTargetHudCard.classList.toggle("erg-power-hud", shouldShowErgHud);
        }
        if (!elements.workoutTargetHudGrid) return;

        if (shouldShowErgHud) {
            const progressPercent = training?.liveSession?.currentRecord?.routeProgress != null
                ? training.liveSession.currentRecord.routeProgress * 100
                : ((records.at(-1)?.routeProgress ?? 0) * 100);
            const targetPowerWatts = runtime.targetErgPowerWatts ?? records.at(-1)?.power ?? 0;
            elements.workoutTargetHudGrid.innerHTML = `
                <div class="erg-power-hud-header">
                    <span>骑行进度</span>
                    <strong>${Math.round(progressPercent)}%</strong>
                    <span>目标 ${Math.round(targetPowerWatts)} W</span>
                </div>
                <svg class="erg-power-chart" viewBox="0 0 640 160" preserveAspectRatio="none">
                    ${buildErgPowerChartSvg({
                        records,
                        targetPowerWatts,
                        ftp: training?.ftp ?? 0,
                        progressPercent
                    })}
                </svg>
            `;
            return;
        }

        if (!runtime.customWorkoutTargetEnabled) {
            elements.workoutTargetHudGrid.innerHTML = "";
            return;
        }

        elements.workoutTargetHudGrid.innerHTML = `
            <div class="data-item">
                <div class="data-label">当前阶段</div>
                <div class="data-display">${runtime.customWorkoutTargetStepLabel ?? "--"} <span class="unit"></span></div>
            </div>
            <div class="data-item">
                <div class="data-label">目标功率</div>
                <div class="data-display power-color">${runtime.customWorkoutTargetPowerWatts ?? "--"} <span class="unit">W</span></div>
            </div>
            <div class="data-item">
                <div class="data-label">目标 FTP</div>
                <div class="data-display accent-color">${runtime.customWorkoutTargetFtpPercent ?? "--"} <span class="unit">%</span></div>
            </div>
            <div class="data-item">
                <div class="data-label">阶段剩余</div>
                <div class="data-display">${formatRemaining(runtime.customWorkoutTargetRemainingSeconds)} <span class="unit"></span></div>
            </div>
        `;
    }

    function renderWorkoutTargetChart(records, training) {
        const runtime = training.runtime ?? {};
        if (elements.liveWorkoutTargetCard) {
            elements.liveWorkoutTargetCard.hidden = !runtime.customWorkoutTargetEnabled;
        }
        if (!elements.workoutTargetChart || !runtime.customWorkoutTargetEnabled) return;

        elements.workoutTargetChart.innerHTML = buildWorkoutTargetChartSvg({
            records,
            runtime,
            customWorkoutTarget: training.customWorkoutTarget,
            ftp: training.ftp
        });
    }

    return {
        render
    };
}

function formatRemaining(seconds) {
    if (seconds === null || seconds === undefined) {
        return "--";
    }

    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
}
