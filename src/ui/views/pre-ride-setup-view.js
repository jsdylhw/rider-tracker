import { collectElements } from "./view-elements.js";

const PRE_RIDE_ELEMENT_IDS = [
    "rideInputCard", "ridePowerSourceSelect", "virtualPowerInput",
    "virtualCadenceInput", "workoutModeForm", "workoutModeSelect", "gradeDifficultyInput",
    "gradeLookaheadInput", "maxUphillInput", "maxDownhillInput", "gradeSmoothingInput",
    "ergTargetPowerInput", "ergConfirmationRequiredInput", "resistanceLevelInput",
    "workoutModeLabel", "trainerTargetLabel", "targetTrainerGradeValue", "workoutControlStatus",
    "customWorkoutTargetEnabled", "customWorkoutTargetToggle", "customWorkoutTargetPanel",
    "customWorkoutTargetEditor", "customWorkoutTargetPresetSelect",
    "applyCustomWorkoutTargetPresetBtn", "editCustomWorkoutTargetBtn",
    "addCustomWorkoutTargetStepBtn", "customWorkoutTargetChart", "customWorkoutTargetTableShell",
    "customWorkoutTargetTableBody", "customWorkoutTargetStatus"
];

export function createPreRideSetupView({ onUpdateRideInput } = {}) {
    const elements = {
        viewLive: document.getElementById("view-live"),
        ...collectElements(PRE_RIDE_ELEMENT_IDS)
    };

    bind(elements.ridePowerSourceSelect, "change", () => onUpdateRideInput?.({
        powerSource: elements.ridePowerSourceSelect.value,
        virtualPowerWatts: Number(elements.virtualPowerInput?.value),
        virtualCadenceRpm: Number(elements.virtualCadenceInput?.value)
    }));
    [elements.virtualPowerInput, elements.virtualCadenceInput].forEach((input) => bind(input, "input", () => {
        if (elements.ridePowerSourceSelect) elements.ridePowerSourceSelect.value = "virtual";
        onUpdateRideInput?.({
            powerSource: "virtual",
            virtualPowerWatts: Number(elements.virtualPowerInput?.value),
            virtualCadenceRpm: Number(elements.virtualCadenceInput?.value)
        });
    }));

    return { elements };
}

function bind(element, event, handler) {
    element?.addEventListener(event, handler);
}
