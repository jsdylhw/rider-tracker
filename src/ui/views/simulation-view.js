import { readSettingsFromForm, renderSettingsForm } from "./home-view.js";

export function createSimulationView({ onRunSimulation, onUpdateSettings, onUpdatePipConfig }) {
    const elements = {
        viewSimulation: document.getElementById("view-simulation"),
        simCol1: document.getElementById("sim-col-1"),
        routeCardContainer: document.getElementById("routeCardContainer"),
        routeCard: document.getElementById("routeCard"),
        routeMapShell: document.getElementById("routeMapShell"),
        setupElevationChartShell: document.getElementById("setupElevationChartShell"),
        simulationForm: document.getElementById("simulationForm"),
        routeTableBody: document.getElementById("routeTableBody"),
        routeTableShell: document.getElementById("routeTableShell"),
        addSegmentBtn: document.getElementById("addSegmentBtn"),
        resetRouteBtn: document.getElementById("resetRouteBtn"),
        gpxFileInput: document.getElementById("gpxFileInput"),
        routeSourceLabel: document.getElementById("routeSourceLabel"),
        routeMapPreview: document.getElementById("routeMapPreview"),
        routeSummary: document.getElementById("routeSummary"),
        routeDistanceChip: document.getElementById("routeDistanceChip"),
        routeElevationChip: document.getElementById("routeElevationChip"),
        runSimulationBtn: document.getElementById("runSimulationBtn"),
        statusText: document.getElementById("statusText"),
        avgSpeedDisplay: document.getElementById("avgSpeedDisplay"),
        distanceDisplay: document.getElementById("distanceDisplay"),
        heartRateDisplay: document.getElementById("heartRateDisplay"),
        elevationDisplay: document.getElementById("elevationDisplay"),
        elapsedTimeValue: document.getElementById("elapsedTimeValue"),
        routeProgressValue: document.getElementById("routeProgressValue"),
        currentGradeValue: document.getElementById("currentGradeValue"),
        recordCountValue: document.getElementById("recordCountValue"),
        distanceChart: document.getElementById("distanceChart"),
        recordsTableBody: document.getElementById("recordsTableBody"),
        checkboxInputs: [...document.querySelectorAll(".checkbox-group input")],
        elevationChart: document.getElementById("elevationChart"),
        setupElevationChart: document.getElementById("setupElevationChart"),
        mapProviderSelect: document.getElementById("mapProviderSelect")
    };

    bind(elements.runSimulationBtn, "click", onRunSimulation);

    if (elements.simulationForm) {
        elements.simulationForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.simulationForm));
        });
    }

    elements.checkboxInputs.forEach((input) => {
        input.addEventListener("change", (event) => {
            onUpdatePipConfig(event.target.value, event.target.checked);
        });
    });

    return {
        elements,
        renderSettings(state) {
            renderSettingsForm(elements.simulationForm, state.settings);
        }
    };
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}
