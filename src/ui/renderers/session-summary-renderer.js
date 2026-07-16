import { formatDuration, formatNumber } from "../../shared/format.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { resolveSessionRenderData } from "./session-render-data.js";

export function createSessionSummaryRenderer({ elements }) {
    function render(state) {
        const { session, records, metrics } = resolveSessionRenderData(state);

        if (elements.avgSpeedDisplay) elements.avgSpeedDisplay.innerHTML = `${formatNumber(metrics.speed.averageKph, 1)} <span class="unit">km/h</span>`;
        if (elements.distanceDisplay) elements.distanceDisplay.innerHTML = `${formatNumber(metrics.ride.distanceKm, 2)} <span class="unit">km</span>`;
        if (elements.heartRateDisplay) elements.heartRateDisplay.innerHTML = `${Math.round(metrics.heartRate.averageBpm)} <span class="unit">bpm</span>`;
        if (elements.elevationDisplay) elements.elevationDisplay.innerHTML = `${Math.round(metrics.ride.ascentMeters)} <span class="unit">m</span>`;
        if (elements.elapsedTimeValue) elements.elapsedTimeValue.textContent = formatDuration(metrics.ride.elapsedSeconds);
        if (elements.routeProgressValue) elements.routeProgressValue.textContent = `${Math.round((metrics.ride.routeProgress ?? 0) * 100)}%`;
        if (elements.currentGradeValue) elements.currentGradeValue.textContent = `${formatNumber(metrics.grade.currentPercent ?? 0, 1)}%`;
        if (elements.recordCountValue) elements.recordCountValue.textContent = String(records.length);
        if (elements.statusText) elements.statusText.textContent = state.statusText;

        if (elements.liveElevationCard) {
            const isGradeSimulation = state.workout?.mode === WORKOUT_MODES.GRADE_SIM;
            elements.liveElevationCard.hidden = !isGradeSimulation || (!session?.route && !state.route);
        }
    }

    return { render };
}
