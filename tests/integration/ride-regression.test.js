import { createStore } from "../../src/app/store/app-store.js";
import { createRideService } from "../../src/app/services/ride-service.js";
import { WORKOUT_MODES } from "../../src/domain/workout/workout-mode.js";
import { assert, assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

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
            session: null,
            records: [],
            summary: null,
            commandDispatch: {
                lastSentAtMs: null,
                lastSentControlMode: null,
                lastSentGradePercent: 0,
                lastSentPowerWatts: null,
                lastSentResistanceLevel: null
            },
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
            name: "startRide 会拒绝空路线，即使街景调试已开启",
            run() {
                const state = createState();
                state.route = {
                    source: "manual",
                    totalDistanceMeters: 0,
                    points: [],
                    segments: []
                };
                state.liveRide.canStart = false;
                const store = createStore(state);
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } },
                    setInterval() { throw new Error("空路线不应启动定时器"); },
                    clearInterval() {}
                };

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: { downloadFit() {} }
                    });
                    service.startRide();

                    assertEqual(store.getState().liveRide.isActive, false);
                    assert(store.getState().statusText.includes("请先设置一条有效路线"));
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
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
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: { downloadFit() {} }
                    });
                    service.startRide();

                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, true);
                    assertEqual(state.liveRide.dashboardOpen, true);
                    assertEqual(state.liveRide.session.exportMetadata.activityName, "自定义线路骑行");
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
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
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
            name: "街景调试模式允许无功率源启动骑行预览",
            run() {
                const state = createState();
                state.liveRide.canStart = false;
                state.ble.sampling = {
                    heartRate: { value: null, timestamp: null },
                    power: { value: null, timestamp: null, sourceType: "none" },
                    cadence: { value: null, timestamp: null, sourceType: "none" },
                    lastUpdated: null
                };
                state.ble.powerMeter = { power: null, cadence: null, sourceType: "none" };
                const store = createStore(state);
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    location: { search: "?debugStreetView=1" },
                    localStorage: { getItem() { return null; } },
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: { downloadFit() {} }
                    });

                    service.startRide();
                    const startedState = store.getState();
                    assertEqual(startedState.liveRide.isActive, true);
                    assertEqual(startedState.liveRide.session.sampledSensors.powerSourceType, "street-view-debug");
                    assertEqual(startedState.liveRide.session.sampledSensors.power, 220);
                    assertGreaterThan(timerCallbacks.length, 0);
                } finally {
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "stopRide 会关闭骑行并打开骑后详情",
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
                let archiveCount = 0;
                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity(session) {
                                archiveCount += 1;
                                return {
                                    id: "live-activity",
                                    name: "Live Activity",
                                    fitFilePath: "data/files/fit/live.fit",
                                    rawSession: session
                                };
                            }
                        }
                    });
                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();

                    timeouts.forEach((fn) => fn());
                    await Promise.resolve();
                    await Promise.resolve();
                    await Promise.resolve();
                    await Promise.resolve();
                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, false);
                    assertEqual(state.liveRide.dashboardOpen, false);
                    assertEqual(archiveCount, 1);
                    assertEqual(state.uiMode, "activity-detail");
                    assertEqual(Boolean(state.selectedActivity?.rawSession), true);
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
            name: "结束骑行会释放活动路线，但保留设备连接状态",
            async run() {
                const initialState = createState();
                const store = createStore(initialState);
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                const originalLocalStorage = globalThis.localStorage;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                globalThis.localStorage = { setItem() {}, getItem() { return null; }, removeItem() {} };
                const connectedBle = store.getState().ble;
                let releasedControl = 0;
                let releasedRoute = 0;

                try {
                    const service = createRideService({
                        store,
                        routeService: { releaseRouteAfterRide() { releasedRoute += 1; } },
                        deviceService: {
                            async releaseTrainerControl() { releasedControl += 1; },
                            async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {}
                        },
                        exportService: { archiveSessionAsFitActivity() { return Promise.resolve({ id: "saved-activity" }); } }
                    });
                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();
                    await flushPromises(3);

                    const state = store.getState();
                    assertEqual(state.route.totalDistanceMeters, 0);
                    assertEqual(state.liveRide.session, null);
                    assertEqual(state.liveRide.records.length, 0);
                    assertEqual(state.ble, connectedBle);
                    assertEqual(releasedRoute, 1);
                    assertEqual(releasedControl, 1);
                } finally {
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "旧骑行归档完成后不会覆盖已经开始的新骑行",
            async run() {
                const store = createStore(createState());
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                const originalLocalStorage = globalThis.localStorage;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                globalThis.localStorage = { setItem() {}, getItem() { return null; }, removeItem() {} };
                let resolveArchive;
                const archivePromise = new Promise((resolve) => { resolveArchive = resolve; });

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: { archiveSessionAsFitActivity() { return archivePromise; } }
                    });
                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();

                    store.setState((state) => ({ ...state, route: createState().route }));
                    service.startRide();
                    resolveArchive({ id: "old-activity", name: "Old ride" });
                    await flushPromises(5);

                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, true);
                    assertEqual(state.liveRide.dashboardOpen, true);
                    assertEqual(state.uiMode, "live");
                    assertEqual(state.selectedActivity, null);
                    assertEqual(state.session, null);
                } finally {
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "结束后返回的旧 ERG 确认不会写回已清空的骑行状态",
            async run() {
                const initialState = createState();
                initialState.workout = {
                    ...initialState.workout,
                    mode: WORKOUT_MODES.FIXED_POWER,
                    erg: { confirmationRequired: true }
                };
                const store = createStore(initialState);
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                const originalLocalStorage = globalThis.localStorage;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                globalThis.localStorage = { setItem() {}, getItem() { return null; }, removeItem() {} };
                let resolveTrainerPower;
                const trainerPowerPromise = new Promise((resolve) => { resolveTrainerPower = resolve; });

                try {
                    const service = createRideService({
                        store,
                        deviceService: {
                            async setTrainerGrade() {},
                            setTrainerPower() { return trainerPowerPromise; },
                            async setTrainerResistance() {}
                        },
                        exportService: { archiveSessionAsFitActivity() { return Promise.resolve({ id: "saved-activity" }); } }
                    });
                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();
                    resolveTrainerPower();
                    await flushPromises(5);

                    const state = store.getState();
                    assertEqual(state.liveRide.isActive, false);
                    assertEqual(state.liveRide.commandDispatch.lastSentPowerWatts, null);
                } finally {
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "手工路线 ERG 结束骑行会保存到数据库",
            async run() {
                const state = {
                    ...createState(),
                    workout: {
                        ...createState().workout,
                        mode: WORKOUT_MODES.FIXED_POWER,
                        erg: { confirmationRequired: false }
                    }
                };
                const store = createStore(state);
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
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
                let savedSession = null;

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity(session) {
                                savedSession = session;
                                return {
                                    id: "manual-erg-activity",
                                    name: "Manual ERG",
                                    distanceKm: session.summary.metrics.ride.distanceKm,
                                    fitFilePath: "data/files/fit/manual-erg.fit"
                                };
                            }
                        }
                    });

                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();
                    await flushPromises(6);

                    const nextState = store.getState();
                    assertGreaterThan(savedSession?.summary?.metrics?.ride?.distanceKm ?? 0, 0);
                    assertEqual(nextState.selectedActivity?.id, "manual-erg-activity");
                    assertEqual(nextState.selectedActivity?.fitFilePath, "data/files/fit/manual-erg.fit");
                } finally {
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
                    deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                    exportService: { downloadFit() { downloadCount += 1; } }
                });

                service.stopRide();
                assertEqual(downloadCount, 0);
                assertEqual(store.getState().liveRide.isActive, false);
            }
        },
        {
            name: "finalizeRideSync 只做同步收尾，不触发异步 FIT 归档",
            run() {
                const store = createStore({
                    ...createState(),
                    liveRide: {
                        ...createState().liveRide,
                        canStart: true
                    }
                });
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                let localStorageSaved = null;
                const originalLocalStorage = globalThis.localStorage;
                globalThis.localStorage = {
                    setItem(key, value) { localStorageSaved = { key, value }; },
                    getItem() { return null; },
                    removeItem() {}
                };
                let archiveCalled = false;

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity() {
                                archiveCalled = true;
                                return Promise.resolve({ id: "should-not-appear" });
                            }
                        }
                    });

                    service.startRide();
                    timerCallbacks[0]();
                    const result = service.finalizeRideSync();
                    const nextState = store.getState();

                    assertEqual(nextState.liveRide.isActive, false);
                    assertEqual(Boolean(result), true);
                    assertEqual(Boolean(result.summary), true);
                    assertEqual(localStorageSaved?.key, "rider-tracker:last-session");
                    assertEqual(archiveCalled, false);
                } finally {
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "finalizeRideSync sendBeacon 模式也不触发异步归档路径",
            run() {
                const store = createStore({
                    ...createState(),
                    liveRide: {
                        ...createState().liveRide,
                        canStart: true
                    }
                });
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                const originalLocalStorage = globalThis.localStorage;
                globalThis.localStorage = {
                    setItem() {},
                    getItem() { return null; },
                    removeItem() {}
                };
                const originalNavigator = globalThis.navigator;
                Object.defineProperty(globalThis, "navigator", {
                    value: { sendBeacon() { return true; } },
                    configurable: true,
                    writable: true
                });
                let archiveCalled = false;

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity() {
                                archiveCalled = true;
                                return Promise.resolve({ id: "should-not-appear" });
                            }
                        }
                    });

                    service.startRide();
                    timerCallbacks[0]();
                    service.finalizeRideSync({ sendBeacon: true });

                    // 异步归档始终不被触发（beacon 是独立路径）
                    assertEqual(archiveCalled, false);
                } finally {
                    if (originalNavigator === undefined) delete globalThis.navigator;
                    else Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "stopRide 不触发 sendBeacon，只走正常异步归档",
            async run() {
                const store = createStore({
                    ...createState(),
                    liveRide: {
                        ...createState().liveRide,
                        canStart: true
                    }
                });
                const timerCallbacks = [];
                const originalWindow = globalThis.window;
                globalThis.window = {
                    ...(originalWindow ?? {}),
                    setInterval(callback) {
                        timerCallbacks.push(callback);
                        return timerCallbacks.length;
                    },
                    clearInterval() {}
                };
                const originalLocalStorage = globalThis.localStorage;
                globalThis.localStorage = {
                    setItem() {},
                    getItem() { return null; },
                    removeItem() {}
                };
                const originalNavigator = globalThis.navigator;
                let sendBeaconCalled = false;
                Object.defineProperty(globalThis, "navigator", {
                    value: { sendBeacon() { sendBeaconCalled = true; return true; } },
                    configurable: true,
                    writable: true
                });
                let archiveCalled = false;

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity() {
                                archiveCalled = true;
                                return Promise.resolve({ id: "normal-archive" });
                            }
                        }
                    });

                    service.startRide();
                    timerCallbacks[0]();
                    service.stopRide();
                    await flushPromises(3);

                    // 正常结束骑行：走异步 FIT 归档，但不触发 sendBeacon
                    assertEqual(archiveCalled, true);
                    assertEqual(sendBeaconCalled, false);
                } finally {
                    if (originalNavigator === undefined) delete globalThis.navigator;
                    else globalThis.navigator = originalNavigator;
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        },
        {
            name: "runSimulation 会通过 FIT 活动归档保存历史",
            async run() {
                const store = createStore(createState());
                const originalLocalStorage = globalThis.localStorage;
                globalThis.localStorage = {
                    setItem() {},
                    getItem() { return null; },
                    removeItem() {}
                };
                let archivedSession = null;
                let archivedOptions = null;

                try {
                    const service = createRideService({
                        store,
                        deviceService: { async setTrainerGrade() {}, async setTrainerPower() {}, async setTrainerResistance() {} },
                        exportService: {
                            archiveSessionAsFitActivity(session, options) {
                                archivedSession = session;
                                archivedOptions = options;
                                return Promise.resolve({
                                    id: "sim-fit-activity",
                                    fitFilePath: "data/files/fit/sim-fit-activity.fit"
                                });
                            }
                        }
                    });

                    service.runSimulation();
                    await Promise.resolve();
                    await Promise.resolve();

                    assertEqual(Boolean(archivedSession?.records?.length), true);
                    assertEqual(Boolean(archivedSession?.summary?.metrics), true);
                    assertEqual(archivedOptions.sportType, "VirtualRide");
                    assertEqual(Boolean(store.getState().session), true);
                    assertEqual(Boolean(store.getState().session.summary), true);
                } finally {
                    if (originalLocalStorage === undefined) delete globalThis.localStorage;
                    else globalThis.localStorage = originalLocalStorage;
                }
            }
        },
        {
            name: "SIM 模式下 trainer 命令按 500ms 节流且不重复下发相同坡度",
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
                    assertEqual(sentGrades.length, 1);
                } finally {
                    Date.now = originalDateNow;
                    if (originalWindow === undefined) delete globalThis.window;
                    else globalThis.window = originalWindow;
                }
            }
        }
    ]
};

async function flushPromises(count = 1) {
    for (let index = 0; index < count; index += 1) {
        await Promise.resolve();
    }
}
