import { collectElements } from "./view-elements.js";

export function createRideReadinessView() {
    return {
        elements: collectElements([
            "openRideDashboardBtn", "rideStatusLabel", "rideStatusMeta", "rideSegmentLabel",
            "rideSegmentMeta", "trainerPushGradeValue", "trainerPushGradeMeta"
        ])
    };
}
