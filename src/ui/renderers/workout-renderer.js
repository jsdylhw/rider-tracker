import { getWorkoutModeLabel, WORKOUT_MODES } from "../../domain/workout/workout-mode.js";
import { formatNumber } from "../../shared/format.js";

export function createWorkoutRenderer({
    elements,
    onUpdateWorkoutMode,
    onUpdateGradeSimulationConfig
}) {
    let lastSignature = "";

    function bindEvents() {
        if (elements.workoutModeForm) {
            elements.workoutModeForm.addEventListener("input", () => {
                const mode = elements.workoutModeSelect?.value ?? WORKOUT_MODES.FREE_RIDE;
                onUpdateWorkoutMode(mode);
                onUpdateGradeSimulationConfig(readWorkoutConfig(elements.workoutModeForm));
            });
        }
    }

    function render(state) {
        const signature = JSON.stringify({
            workout: state.workout,
            uiMode: state.uiMode
        });

        if (signature === lastSignature) {
            return;
        }

        const { workout } = state;
        const { gradeSimulation, runtime } = workout;
        const isGradeSim = workout.mode === WORKOUT_MODES.GRADE_SIM;

        if (elements.workoutModeSelect && document.activeElement !== elements.workoutModeSelect) {
            elements.workoutModeSelect.value = workout.mode;
        }

        syncNumberField(elements.gradeDifficultyInput, gradeSimulation.difficultyPercent);
        syncNumberField(elements.gradeLookaheadInput, gradeSimulation.lookaheadMeters);
        syncNumberField(elements.maxUphillInput, gradeSimulation.maxUphillPercent);
        syncNumberField(elements.maxDownhillInput, gradeSimulation.maxDownhillPercent);
        syncNumberField(elements.gradeSmoothingInput, gradeSimulation.smoothingFactor);

        [
            elements.gradeDifficultyInput,
            elements.gradeLookaheadInput,
            elements.maxUphillInput,
            elements.maxDownhillInput,
            elements.gradeSmoothingInput
        ].forEach((field) => {
            if (field) {
                field.disabled = !isGradeSim;
            }
        });

        if (elements.workoutModeLabel) {
            elements.workoutModeLabel.textContent = getWorkoutModeLabel(workout.mode);
        }

        if (elements.targetTrainerGradeValue) {
            elements.targetTrainerGradeValue.textContent = `${formatNumber(runtime.targetTrainerGradePercent ?? 0, 1)}%`;
        }

        if (elements.workoutControlStatus) {
            elements.workoutControlStatus.textContent = runtime.controlStatus;
        }

        lastSignature = signature;
    }

    bindEvents();

    return {
        render
    };
}

function syncNumberField(field, value) {
    if (field && document.activeElement !== field) {
        field.value = value;
    }
}

function readWorkoutConfig(form) {
    const formData = new FormData(form);

    return {
        difficultyPercent: Number(formData.get("difficultyPercent")),
        lookaheadMeters: Number(formData.get("lookaheadMeters")),
        maxUphillPercent: Number(formData.get("maxUphillPercent")),
        maxDownhillPercent: Number(formData.get("maxDownhillPercent")),
        smoothingFactor: Number(formData.get("smoothingFactor"))
    };
}
