import { createStore } from "../../src/app/store/app-store.js";
import { createWorkoutService } from "../../src/app/services/workout-service.js";
import { createRideService } from "../../src/app/services/ride-service.js";
import { buildRoute } from "../../src/domain/route/route-builder.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { TRAINER_CONTROL_MODES } from "../../src/domain/workout/trainer-command.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

function createIntegrationState() {
    const route = buildRoute([
        { name: "ERG 测试段", distanceKm: 1.2, gradePercent: 3.5 }
    ]);

    return {
        route,
        settings: {
            power: 220,
            mass: 75,
            ftp: 250,
            restingHr: 58,
            maxHr: 182,
            cda: 0.32,
            crr: 0.004,
            windSpeed: 0
        },
        workout: {
            mode: WORKOUT_MODES.FIXED_POWER,
            gradeSimulation: {
                difficultyPercent: 75,
                lookaheadMeters: 120,
                maxUphillPercent: 10,
                maxDownhillPercent: -3,
                smoothingFactor: 0.35
            },
            runtime: {
                trainerControlMode: TRAINER_CONTROL_MODES.ERG,
                targetTrainerGradePercent: 0,
                targetErgPowerWatts: 220
            }
        },
        liveRide: {
            isActive: false,
            canStart: true,
            dashboardOpen: false,
            session: null,
            trainerControlMode: null,
            commandSequence: 0,
            startedAt: null,
            lastCompletedAt: null,
            statusMeta: "准备开始"
        },
        ble: {
            heartRate: { value: 130 },
            powerMeter: { power: 260, cadence: 88 }
        },
        exportMetadata: {},
        session: null,
        hasPersistedSession: false,
        statusText: ""
    };
}

export const suite = {
    name: "integration-erg-live-flow",
    tests: [
        {
            name: "更新 ERG 目标功率后，实时骑行循环按新目标下发 trainer 命令",
            async run() {
                const store = createStore(createIntegrationState());
                const workoutService = createWorkoutService({ store });

                const sentPowerTargets = [];
                const deviceService = {
                    async setTrainerPower(powerWatts) {
                        sentPowerTargets.push(powerWatts);
                    },
                    async setTrainerGrade() {}
                };
                const exportService = {
                    downloadFit() {}
                };

                const originalWindow = globalThis.window;
                const timerCallbacks = [];

                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };

                try {
                    const rideService = createRideService({ store, deviceService, exportService });
                    rideService.startRide();

                    assertEqual(timerCallbacks.length, 1);
                    assertEqual(store.getState().liveRide.isActive, true);

                    timerCallbacks[0]();
                    await Promise.resolve();

                    assertEqual(sentPowerTargets[0], 220);

                    workoutService.updateErgTargetPower(285);
                    timerCallbacks[0]();
                    await Promise.resolve();

                    assertGreaterThan(sentPowerTargets.length, 1);
                    assertEqual(sentPowerTargets.at(-1), 285);
                } finally {
                    if (originalWindow === undefined) {
                        delete globalThis.window;
                    } else {
                        globalThis.window = originalWindow;
                    }
                }
            }
        }
    ]
};
