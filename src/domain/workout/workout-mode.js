export const WORKOUT_MODES = {
    FREE_RIDE: "free-ride",
    FIXED_POWER: "fixed-power",
    GRADE_SIM: "grade-sim"
};

export function getWorkoutModeLabel(mode) {
    switch (mode) {
        case WORKOUT_MODES.FIXED_POWER:
            return "固定功率";
        case WORKOUT_MODES.GRADE_SIM:
            return "坡度模拟";
        case WORKOUT_MODES.FREE_RIDE:
        default:
            return "自由骑行（固定阻力）";
    }
}
