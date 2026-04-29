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
            if (elements.deviceControlsPanel) {
                elements.liveCol1.parentElement?.insertBefore(
                    elements.deviceControlsPanel,
                    elements.liveCol1
                );
            }

            elements.liveCol1.insertBefore(
                elements.routeCardContainer,
                elements.liveCol1.firstChild
            );
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
