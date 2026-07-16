import { formatDuration, formatNumber } from "../../shared/format.js";
import { resolveSessionRenderData } from "./session-render-data.js";

export function createSessionHistoryRenderer({ elements }) {
    function render(state) {
        if (!elements.recordsTableBody) return;

        const { records, metrics } = resolveSessionRenderData(state);
        if (records.length === 0) {
            elements.recordsTableBody.innerHTML = `<tr><td class="empty-state" colspan="6">开始骑行后将在这里显示记录。</td></tr>`;
            return;
        }

        elements.recordsTableBody.innerHTML = `
            <tr>
                <td>当前路线总计</td>
                <td>${formatDuration(metrics.ride.elapsedSeconds)}</td>
                <td>${formatNumber(metrics.ride.distanceKm, 2)} km</td>
                <td>${formatNumber(metrics.speed.averageKph, 1)} km/h</td>
                <td>${Math.round(metrics.power.averageWatts)} W</td>
                <td>${Math.round(metrics.heartRate.averageBpm)} bpm</td>
            </tr>
        `;
    }

    return { render };
}
