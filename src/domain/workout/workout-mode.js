export const WORKOUT_MODES = {
    FREE_RIDE: "free-ride",
    GRADE_SIM: "grade-sim"
};

export function getWorkoutModeLabel(mode) {
    switch (mode) {
        case WORKOUT_MODES.GRADE_SIM:
            return "坡度模拟";
        case WORKOUT_MODES.FREE_RIDE:
        default:
            return "自由骑行";
    }
}
