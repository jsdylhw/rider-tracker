import { formatDuration, formatNumber } from "../../shared/format.js";

export function createLayoutCoordinator({ elements }) {
    mountSharedExportCard(elements);

    function render(state) {
        const mode = state.uiMode;

        if (elements.viewHome) elements.viewHome.hidden = mode !== "home";
        if (elements.viewSimulation) elements.viewSimulation.hidden = mode !== "simulation";
        if (elements.viewLive) elements.viewLive.hidden = mode !== "live";

        if (mode === "home") {
            if (elements.routeCardContainer) {
                elements.routeCardContainer.hidden = true;
            }
            if (elements.exportCardContainer) {
                elements.exportCardContainer.hidden = true;
            }
            if (elements.routeMapShell) {
                elements.routeMapShell.hidden = true;
            }
            if (elements.setupElevationChartShell) {
                elements.setupElevationChartShell.hidden = true;
            }
        } else if (mode === "simulation" && elements.simCol1 && elements.routeCardContainer) {
            elements.simCol1.insertBefore(elements.routeCardContainer, elements.simCol1.firstChild);
            elements.routeCardContainer.hidden = false;

            if (elements.routeMapShell) {
                elements.routeMapShell.hidden = false;
            }
            if (elements.setupElevationChartShell) {
                elements.setupElevationChartShell.hidden = false;
            }

            if (elements.exportCardContainer) {
                elements.simCol1.appendChild(elements.exportCardContainer);
                elements.exportCardContainer.hidden = false;
            }
        } else if (mode === "live" && elements.liveCol1 && elements.routeCardContainer) {
            elements.liveCol1.insertBefore(elements.routeCardContainer, elements.liveCol1.firstChild);
            elements.routeCardContainer.hidden = false;

            if (elements.routeMapShell) {
                elements.routeMapShell.hidden = true;
            }
            if (elements.setupElevationChartShell) {
                elements.setupElevationChartShell.hidden = false;
            }

            if (elements.liveExportSlot && elements.exportCardContainer) {
                elements.liveExportSlot.appendChild(elements.exportCardContainer);
                elements.exportCardContainer.hidden = !state.session && !state.liveRide.session;
            }
        } else if (elements.routeCardContainer) {
            elements.routeCardContainer.hidden = true;

            if (elements.exportCardContainer) {
                elements.exportCardContainer.hidden = true;
            }

            if (elements.routeMapShell) {
                elements.routeMapShell.hidden = false;
            }
            if (elements.setupElevationChartShell) {
                elements.setupElevationChartShell.hidden = false;
            }
        }

        renderHomeSummary(state);
    }

    function renderHomeSummary(state) {
        if (state.uiMode !== "home" || !elements.historyContainer) {
            return;
        }

        const summary = state.session?.summary;

        if (!summary) {
            elements.historyContainer.innerHTML = "暂无历史记录。";
            return;
        }

        elements.historyContainer.innerHTML = `
            <div style="display: grid; gap: 12px; margin-top: 8px;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--muted);">总距离</span>
                    <strong>${formatNumber(summary.distanceKm, 2)} km</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--muted);">总用时</span>
                    <strong>${formatDuration(summary.elapsedSeconds)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--muted);">平均速度</span>
                    <strong>${formatNumber(summary.averageSpeedKph, 1)} km/h</strong>
                </div>
            </div>
        `;
    }

    return {
        render
    };
}

function mountSharedExportCard(elements) {
    const { exportCardContainer, exportCardTemplate } = elements;

    if (exportCardContainer && exportCardTemplate && exportCardContainer.childElementCount === 0) {
        exportCardContainer.appendChild(exportCardTemplate.content.cloneNode(true));
    }
}
