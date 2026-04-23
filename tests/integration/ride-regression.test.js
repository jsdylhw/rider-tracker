import { createStore } from "../../src/app/store/app-store.js";
import { createRideService } from "../../src/app/services/ride-service.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

function createState() {
    return {
        route: {
            totalDistanceMeters: 1000,
            source: "manual",
            name: "测试路线",
            points: [
                { latitude: 31.1, longitude: 121.1, distanceMeters: 0, gradePercent: 2, elevationMeters: 10 },
                { latitude: 31.2, longitude: 121.2, distanceMeters: 1000, gradePercent: 3, elevationMeters: 20 }
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
        workout: {
            mode: WORKOUT_MODES.FREE_RIDE,
            gradeSimulation: {
                difficultyPercent: 100,
                lookaheadMeters: 120,
                maxUphillPercent: 20,
                maxDownhillPercent: 0,
                smoothingFactor: 0.7
            },
            runtime: {
                trainerControlMode: "resistance",
                targetTrainerGradePercent: 0
            }
        },
        liveRide: {
            isActive: false,
            canStart: true,
            dashboardOpen: false,
            snapshot: null,
            session: null,
            trainerControlMode: null,
            commandSequence: 0,
            commandDispatch: {
                lastSentAtMs: null,
                lastSentControlMode: null,
                lastSentGradePercent: 0,
                lastSentPowerWatts: null,
                lastSentResistanceLevel: null
            },
            startedAt: null,
            lastCompletedAt: null,
            statusMeta: "准备开始"
        },
        ble: {
            sampling: {
                heartRate: { value: 130, timestamp: Date.now() },
                power: {
                    value: 260,
                    timestamp: Date.now(),
                    sourceType: "trainer",
                    sampleCount: 1,
                    total: 260,
                    average: 260
                },
                cadence: { value: 88, timestamp: Date.now(), sourceType: "trainer" },
                lastUpdated: Date.now()
            },
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
    name: "ride-regression",
    tests: [
        {
            name: "startRide 会打开骑行面板并启动实时会话",
            run() {
                const store = createStore(createState());
                const timerCallbacks = [];
                const timerIntervals = [];
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback, intervalMs) {
                        timerCallbacks.push(callback);
                        timerIntervals.push(intervalMs);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {} },
                        exportService: { downloadFit() {} }
                    });
                    service.startRide();

                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, true);
                    assertEqual(state.liveRide.dashboardOpen, true);
                    assertGreaterThan(timerCallbacks.length, 0);
                    assertEqual(timerIntervals[0], 250);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "startRide 会根据稳定采样频率选择更接近的物理推进档位",
            run() {
                const timestamp = Date.now();
                const store = createStore({
                    ...createState(),
                    ble: {
                        ...createState().ble,
                        sampling: {
                            heartRate: { value: 130, timestamp },
                            power: {
                                value: 260,
                                timestamp,
                                sourceType: "trainer",
                                sampleCount: 8,
                                total: 2080,
                                average: 260,
                                lastIntervalMs: 520,
                                intervalSampleCount: 6,
                                estimatedIntervalMs: 520,
                                estimatedHz: 1000 / 520,
                                jitterMs: 18,
                                isSignalStable: true
                            },
                            cadence: { value: 88, timestamp, sourceType: "trainer" },
                            lastUpdated: timestamp
                        }
                    }
                });
                const timerIntervals = [];
                const originalWindow = globalThis.window;

                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(_callback, intervalMs) {
                        timerIntervals.push(intervalMs);
                        return timerIntervals.length;
                    },
                    clearInterval() {}
                };

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {} },
                        exportService: { downloadFit() {} }
                    });

                    service.startRide();
                    assertEqual(timerIntervals[0], 500);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "stopRide 会关闭骑行并触发 FIT 自动导出",
            async run() {
                const store = createStore(createState());
                const timerCallbacks = [];
                const timeouts = [];
                const originalWindow = globalThis.window;
                const originalSetTimeout = globalThis.setTimeout;
                const originalLocalStorage = globalThis.localStorage;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                globalThis.localStorage = {
                    setItem() {},
                    getItem() { return null; },
                    removeItem() {}
                };
                globalThis.setTimeout = (cb) => {
                    timeouts.push(cb);
                    return timeouts.length;
                };
                let downloadCount = 0;
                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {} },
                        exportService: { downloadFit() { downloadCount += 1; } }
                    });
                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();

                    timeouts.forEach((fn) => fn());
                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, false);
                    assertEqual(state.liveRide.dashboardOpen, false);
                    assertEqual(downloadCount, 1);
                } finally {
                    globalThis.setTimeout = originalSetTimeout;
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "未开始骑行时 stopRide 不应触发导出",
            run() {
                const store = createStore(createState());
                let downloadCount = 0;
                const service = createRideService({
                    store,
                    deviceService: { async setTrainerGrade() {}, async setTrainerPower() {} },
                    exportService: { downloadFit() { downloadCount += 1; } }
                });

                service.stopRide();
                assertEqual(downloadCount, 0);
                assertEqual(store.getState().liveRide.isActive, false);
            }
        },
        {
            name: "SIM 模式下 trainer 命令按 500ms 节流下发",
            run() {
                const store = createStore({
                    ...createState(),
                    workout: {
                        ...createState().workout,
                        mode: WORKOUT_MODES.GRADE_SIM,
                        runtime: {
                            trainerControlMode: "sim",
                            targetTrainerGradePercent: 0
                        }
                    }
                });
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                const originalDateNow = Date.now;
                let sentGrades = [];
                let now = 1000;

                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                Date.now = () => now;

                try {
                    const service = createRideService({
                        store,
                        deviceService: {
                            async setTrainerGrade(grade) {
                                sentGrades.push(grade);
                            },
                            async setTrainerPower() {},
                            async setTrainerResistance() {}
                        },
                        exportService: { downloadFit() {} }
                    });

                    service.startRide();
                    assertEqual(timerCallbacks.length, 1);

                    timerCallbacks[0]();
                    assertEqual(sentGrades.length, 1);

                    now += 250;
                    timerCallbacks[0]();
                    assertEqual(sentGrades.length, 1);

                    now += 250;
                    timerCallbacks[0]();
                    assertEqual(sentGrades.length, 2);
                } finally {
                    Date.now = originalDateNow;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        }
    ]
};
