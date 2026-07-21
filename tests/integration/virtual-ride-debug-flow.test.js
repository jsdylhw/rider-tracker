import { createStore } from "../../src/app/store/app-store.js";
import { createRideService } from "../../src/app/services/ride-service.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

function createState(overrides = {}) {
    const state = {
        uiMode: "live",
        route: {
            totalDistanceMeters: 1000,
            source: "manual",
            name: "虚拟骑行测试路线",
            points: [
                { latitude: 31.1, longitude: 121.1, distanceMeters: 0, gradePercent: 3, elevationMeters: 10 },
                { latitude: 31.2, longitude: 121.2, distanceMeters: 1000, gradePercent: 4, elevationMeters: 50 }
            ],
            segments: []
        },
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
        rideInput: {
            powerSource: "device",
            virtualPowerWatts: 220,
            virtualCadenceRpm: 85
        },
        workout: {
            mode: WORKOUT_MODES.GRADE_SIM,
            gradeSimulation: {
                difficultyPercent: 100,
                lookaheadMeters: 120,
                maxUphillPercent: 20,
                maxDownhillPercent: 0,
                smoothingFactor: 0.7
            },
            runtime: {
                trainerControlMode: "sim",
                targetTrainerGradePercent: 0
            }
        },
        liveRide: {
            isActive: false,
            canStart: false,
            dashboardOpen: false,
            session: null,
            records: [],
            summary: null,
            commandDispatch: {
                lastSentAtMs: null,
                lastAttemptedAtMs: null,
                lastSentControlMode: null,
                lastSentGradePercent: 0,
                lastSentPowerWatts: null,
                lastSentResistanceLevel: null,
                inFlightCommandKey: null
            },
            lastCompletedAt: null,
            statusMeta: "准备开始"
        },
        ble: {
            sampling: {
                heartRate: { value: null, timestamp: null },
                power: { value: null, timestamp: null, sourceType: "none" },
                cadence: { value: null, timestamp: null, sourceType: "none" },
                lastUpdated: null
            },
            heartRate: { value: null },
            powerMeter: { power: null, cadence: null, sourceType: "none" },
            trainer: { isConnected: false }
        },
        exportMetadata: {},
        session: null,
        hasPersistedSession: false,
        statusText: ""
    };

    return {
        ...state,
        ...overrides,
        rideInput: { ...state.rideInput, ...(overrides.rideInput ?? {}) },
        workout: { ...state.workout, ...(overrides.workout ?? {}) },
        liveRide: { ...state.liveRide, ...(overrides.liveRide ?? {}) },
        ble: { ...state.ble, ...(overrides.ble ?? {}) }
    };
}

function installWindow({ debugEnabled }) {
    const originalWindow = globalThis.window;
    const timerCallbacks = [];
    globalThis.window = {
        ...(originalWindow ?? {}),
        location: { search: debugEnabled ? "?debugStreetView=1" : "" },
        localStorage: { getItem() { return null; } },
        setInterval(callback) {
            timerCallbacks.push(callback);
            return timerCallbacks.length;
        },
        clearInterval() {}
    };

    return {
        timerCallbacks,
        restore() {
            if (originalWindow === undefined) delete globalThis.window;
            else globalThis.window = originalWindow;
        }
    };
}

function createDeviceService(commandCalls) {
    return {
        async setTrainerGrade(value) { commandCalls.grade.push(value); },
        async setTrainerPower(value) { commandCalls.power.push(value); },
        async setTrainerResistance(value) { commandCalls.resistance.push(value); }
    };
}

export const suite = {
    name: "virtual-ride-debug-flow",
    tests: [
        {
            name: "debug 模式的虚拟功率输入可直接启动实时骑行",
            run() {
                const windowHarness = installWindow({ debugEnabled: true });
                try {
                    const store = createStore(createState());
                    const service = createRideService({
                        store,
                        deviceService: createDeviceService({ grade: [], power: [], resistance: [] }),
                        exportService: {}
                    });

                    service.updateRideInput({
                        powerSource: "virtual",
                        virtualPowerWatts: 287,
                        virtualCadenceRpm: 93
                    });
                    service.startRide();

                    const state = store.getState();
                    assertEqual(state.liveRide.canStart, true);
                    assertEqual(state.liveRide.isActive, true);
                    assertEqual(state.liveRide.session.sampledSensors.powerSourceType, "virtual");
                    assertEqual(state.liveRide.session.sampledSensors.power, 287);
                    assertEqual(state.liveRide.session.sampledSensors.cadence, 93);
                    assertGreaterThan(windowHarness.timerCallbacks.length, 0);
                } finally {
                    windowHarness.restore();
                }
            }
        },
        {
            name: "非 debug 模式会拒绝虚拟功率输入并保持设备启动门槛",
            run() {
                const windowHarness = installWindow({ debugEnabled: false });
                try {
                    const store = createStore(createState());
                    const service = createRideService({
                        store,
                        deviceService: createDeviceService({ grade: [], power: [], resistance: [] }),
                        exportService: {}
                    });

                    service.updateRideInput({
                        powerSource: "virtual",
                        virtualPowerWatts: 287,
                        virtualCadenceRpm: 93
                    });
                    service.startRide();

                    const state = store.getState();
                    assertEqual(state.rideInput.powerSource, "device");
                    assertEqual(state.liveRide.canStart, false);
                    assertEqual(state.liveRide.isActive, false);
                    assertEqual(windowHarness.timerCallbacks.length, 0);
                } finally {
                    windowHarness.restore();
                }
            }
        },
        {
            name: "虚拟功率骑行不会向未连接骑行台下发控制命令",
            run() {
                const windowHarness = installWindow({ debugEnabled: true });
                const commandCalls = { grade: [], power: [], resistance: [] };
                try {
                    const store = createStore(createState({
                        rideInput: {
                            powerSource: "virtual",
                            virtualPowerWatts: 260,
                            virtualCadenceRpm: 90
                        }
                    }));
                    const service = createRideService({
                        store,
                        deviceService: createDeviceService(commandCalls),
                        exportService: {}
                    });

                    service.startRide();
                    windowHarness.timerCallbacks[0]();

                    const state = store.getState();
                    assertGreaterThan(state.liveRide.records.length, 0);
                    assertEqual(commandCalls.grade.length, 0);
                    assertEqual(commandCalls.power.length, 0);
                    assertEqual(commandCalls.resistance.length, 0);
                } finally {
                    windowHarness.restore();
                }
            }
        },
        {
            name: "探索路线在开始和骑行过程中持续请求前方缓冲",
            run() {
                const windowHarness = installWindow({ debugEnabled: true });
                const requestedDistances = [];
                try {
                    const store = createStore(createState({
                        route: {
                            ...createState().route,
                            source: "osm-exploration"
                        }
                    }));
                    const service = createRideService({
                        store,
                        deviceService: createDeviceService({ grade: [], power: [], resistance: [] }),
                        exportService: {},
                        routeService: {
                            ensureExplorationRouteAhead({ distanceMeters }) {
                                requestedDistances.push(distanceMeters);
                            }
                        }
                    });

                    service.updateRideInput({
                        powerSource: "virtual",
                        virtualPowerWatts: 260,
                        virtualCadenceRpm: 90
                    });
                    service.startRide();
                    windowHarness.timerCallbacks[0]();

                    assertEqual(requestedDistances[0], 0);
                    assertGreaterThan(requestedDistances.length, 1);
                } finally {
                    windowHarness.restore();
                }
            }
        }
    ]
};
