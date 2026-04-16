import { buildRouteFromTrackPoints } from "../../src/domain/route/route-builder.js";
import { buildGradeSimulationState } from "../../src/domain/workout/grade-sim-mode.js";
import { TRAINER_CONTROL_MODES, TRAINER_COMMAND_TYPES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual, assertGreaterThan, assertLessThan } from "../helpers/test-harness.js";

const config = {
    difficultyPercent: 75,
    lookaheadMeters: 120,
    maxUphillPercent: 10,
    maxDownhillPercent: -3,
    smoothingFactor: 0.35
};

function createGradeRoute() {
    return buildRouteFromTrackPoints({
        name: "Grade Route",
        hasElevationData: true,
        points: [
            { latitude: 31, longitude: 121, elevationMeters: 10, distanceMeters: 0, gradePercent: 0 },
            { latitude: 31.0003, longitude: 121.0003, elevationMeters: 14, distanceMeters: 60, gradePercent: 6.7 },
            { latitude: 31.0006, longitude: 121.0006, elevationMeters: 20, distanceMeters: 120, gradePercent: 10 },
            { latitude: 31.001, longitude: 121.001, elevationMeters: 26, distanceMeters: 200, gradePercent: 7.5 }
        ],
        segments: [
            { name: "Climb 1", distanceMeters: 100, gradePercent: 6, elevationDelta: 6, startDistanceMeters: 0, endDistanceMeters: 100 },
            { name: "Climb 2", distanceMeters: 100, gradePercent: 8, elevationDelta: 8, startDistanceMeters: 100, endDistanceMeters: 200 }
        ]
    });
}

export const suite = {
    name: "grade-sim-mode",
    tests: [
        {
            name: "buildGradeSimulationState returns unavailable when route has no elevation",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Flat",
                    hasElevationData: false,
                    points: [
                        { latitude: 31, longitude: 121, elevationMeters: 0, distanceMeters: 0, gradePercent: 0 },
                        { latitude: 31.001, longitude: 121.001, elevationMeters: 0, distanceMeters: 100, gradePercent: 0 }
                    ],
                    segments: [
                        { name: "Flat", distanceMeters: 100, gradePercent: 0, elevationDelta: 0, startDistanceMeters: 0, endDistanceMeters: 100 }
                    ]
                });
                const result = buildGradeSimulationState({
                    route,
                    distanceMeters: 0,
                    previousTargetGradePercent: 0,
                    config
                });

                assertEqual(result.available, false);
                assertEqual(result.targetTrainerGradePercent, 0);
            }
        },
        {
            name: "buildGradeSimulationState sets target grade equal to current grade (with clamp)",
            run() {
                const result = buildGradeSimulationState({
                    route: createGradeRoute(),
                    distanceMeters: 80,
                    previousTargetGradePercent: 0,
                    config,
                    active: true,
                    rideId: "ride-test",
                    commandSequence: 7
                });

                assertEqual(result.available, true);
                assertGreaterThan(result.currentGradePercent, 0);
                assertGreaterThan(result.lookaheadGradePercent, 0);
                assertEqual(result.targetTrainerGradePercent, result.currentGradePercent);
                assertEqual(result.pendingTrainerCommand.protocolVersion, 1);
                assertEqual(result.pendingTrainerCommand.decisionPolicy, "pre-ride-locked");
                assertEqual(result.pendingTrainerCommand.controlMode, TRAINER_CONTROL_MODES.SIM);
                assertEqual(result.pendingTrainerCommand.type, TRAINER_COMMAND_TYPES.SET_SIM_GRADE);
                assertEqual(result.pendingTrainerCommand.rideId, "ride-test");
                assertEqual(result.pendingTrainerCommand.sequence, 7);
            }
        },
        {
            name: "buildGradeSimulationState respects downhill clamp",
            run() {
                const route = buildRouteFromTrackPoints({
                    name: "Downhill",
                    hasElevationData: true,
                    points: [
                        { latitude: 31, longitude: 121, elevationMeters: 30, distanceMeters: 0, gradePercent: -10 },
                        { latitude: 31.001, longitude: 121.001, elevationMeters: 18, distanceMeters: 120, gradePercent: -10 }
                    ],
                    segments: [
                        { name: "Drop", distanceMeters: 120, gradePercent: -10, elevationDelta: -12, startDistanceMeters: 0, endDistanceMeters: 120 }
                    ]
                });

                const result = buildGradeSimulationState({
                    route,
                    distanceMeters: 20,
                    previousTargetGradePercent: 0,
                    config
                });

                assertEqual(result.targetTrainerGradePercent, config.maxDownhillPercent);
            }
        }
    ]
};
