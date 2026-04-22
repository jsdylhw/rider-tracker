import { buildWorkoutTargetChartSvg } from "./svg/dashboard-charts.js";

export function createWorkoutRuntimeRenderer({ elements }) {
    function render({ training, records }) {
        renderWorkoutTargetHud(training?.runtime ?? {});
        renderWorkoutTargetChart(records ?? [], training ?? {});
    }

    function renderWorkoutTargetHud(runtime) {
        if (elements.workoutTargetHudCard) {
            elements.workoutTargetHudCard.hidden = !runtime.customWorkoutTargetEnabled;
        }
        if (!elements.workoutTargetHudGrid || !runtime.customWorkoutTargetEnabled) return;

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
