import { buildRideHintSnapshot, aggregateRideWindow, buildRideHintRevision } from "../../src/domain/narration/ride-hint-snapshot.js";
import { createRouteNarrationService } from "../../src/app/services/route-narration-service.js";
import { createNarrationPlanFixture } from "../helpers/narration-fixture.js";
import { assertEqual } from "../helpers/test-harness.js";

const route = { name: "hint", totalDistanceMeters: 10000, points: [
    { distanceMeters: 0, latitude: 1, longitude: 1, gradePercent: 2 },
    { distanceMeters: 10000, latitude: 2, longitude: 2, gradePercent: 4 }
], segments: [] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup({ timeout = 10000 } = {}) {
    let clockNow = 100000;
    let signal;
    let resolve;
    const requests = [];
    const service = createRouteNarrationService({
        preparePlan: async () => createNarrationPlanFixture(route),
        buildHintSnapshot: () => ({ elapsed_s: 100, captured_at_ms: 100000 }), now: () => clockNow, hintTimeoutMs: timeout,
        refreshHint: (request, options) => { signal = options.signal; requests.push(request); return new Promise((done) => { resolve = done; }); }
    });
    service.enter(route);
    await service.load(route);
    const update = (extra = {}) => service.update({ distanceMeters: 0, elapsedSeconds: 100,
        rideContext: { active: true, sessionId: "ride1", revision: "erg1" }, ...extra });
    const finish = async () => { resolve({ ...requests[0], status: "ready", text: "保持平顺", valid_for_s: 90 }); await tick(); };
    return { service, requests, update, finish, getSignal: () => signal, setNow: (value) => { clockNow = value; } };
}
export const suite = { name: "ride-hint", tests: [
    { name: "revision preserves natural ramps but invalidates user targets and disabled plans", run() {
        const state = { settings: { ftp: 250 }, liveRide: { session: { startedAt: 1, trainerControlMode: "erg",
            customWorkoutTargetPlan: { enabled: true, steps: [{ durationMinutes: 5, ftpPercent: 80 }] },
            workoutRuntime: { targetErgPowerWatts: 200, customWorkoutTargetStepIndex: 0 }
        } } };
        const before = buildRideHintRevision(state);
        state.liveRide.session.workoutRuntime.targetErgPowerWatts = 201;
        assertEqual(buildRideHintRevision(state), before);
        state.liveRide.session.customWorkoutTargetPlan.enabled = false;
        const disabled = buildRideHintRevision(state);
        state.liveRide.session.workoutRuntime.targetErgPowerWatts = 220;
        assertEqual(buildRideHintRevision(state) === disabled, false);
        state.settings.ftp = 260;
        assertEqual(buildRideHintRevision(state) === before, false);
    } },
    { name: "weighted windows use actual dt, preserve missing values and exclude gaps/NaN", run() {
        const result = aggregateRideWindow([
            { elapsedSeconds: 0.5, power: 100 }, { elapsedSeconds: 2, power: 200, heartRate: 120 },
            { elapsedSeconds: NaN, power: 900 }, { elapsedSeconds: 20, power: 900 }
        ], 20, 30);
        assertEqual(result.actual_s, 20);
        assertEqual(result.means.power, 175);
        assertEqual(result.coverage_s.power, 2);
        assertEqual(result.means.cadence, null);
    } },
    { name: "snapshot distinguishes ERG target, current output, stale sensors and next step", run() {
        const snapshot = buildRideHintSnapshot({ settings: { ftp: 250, maxHr: 190 }, ble: { trainer: { isConnected: true, controlReady: false } },
            liveRide: { isActive: true, records: [{ elapsedSeconds: 299, power: 130 }], session: {
                route, startedAt: 1, trainerControlMode: "erg", ergElapsedSeconds: 299,
                workoutRuntime: { targetErgPowerWatts: 200 },
                sampledSensors: { power: 130, powerTimestamp: 100, powerSourceType: "virtual", freshness: { power: true } },
                customWorkoutTargetPlan: { enabled: true, steps: [
                    { id: "a", durationMinutes: 5, ftpPercent: 80 }, { id: "b", durationMinutes: 5, ftpPercent: 100 }
                ] }
            } } }, { item: { title: "山坡", summary: "地理", category: "geography", route_distance_m: 0 }, now: 10000 });
        assertEqual(snapshot.target.erg_power_w, 200);
        assertEqual(snapshot.target.sim_grade_percent, null);
        assertEqual(snapshot.sensors.power.valid, false);
        assertEqual(snapshot.sensors.measured_power, false);
        assertEqual(snapshot.workout.next.stepId, "b");
        assertEqual(snapshot.trainer.control_ready, false);
    } },
    { name: "automatic trigger starts once and displays separate hint without altering plan", async run() {
        const { service, update, requests, finish } = await setup();
        update(); await tick(); update();
        assertEqual(requests.length, 1);
        await finish();
        assertEqual(service.getState().rideHint.text, "保持平顺");
        assertEqual(service.getState().item.summary, "第 1 条测试内容。");
        assertEqual(service.getState().plan.items[0].rideHint, undefined);
        assertEqual(update({ distanceMeters: 600 }).rideHint, null);
        service.clear();
    } },
    { name: "a new automatic card cancels the preceding pending hint", async run() {
        const calls = [];
        const plan = createNarrationPlanFixture(route);
        plan.items = plan.items.slice(0, 2).map((item, index) => ({ ...item, route_distance_m: index * 1000,
            trigger: { lead_distance_m: 0, expire_distance_m: 100, minimum_gap_seconds: 0, priority: 0 } }));
        const service = createRouteNarrationService({ preparePlan: async () => plan,
            buildHintSnapshot: () => ({ elapsed_s: 101, captured_at_ms: 100000 }), now: () => 100000,
            refreshHint: (request, { signal }) => new Promise((resolve) => calls.push({ request, signal, resolve })) });
        service.enter(route); await service.load(route);
        const rideContext = { active: true, sessionId: "ride", revision: "erg" };
        service.update({ distanceMeters: 0, elapsedSeconds: 100, rideContext }); await tick();
        service.update({ distanceMeters: 1000, elapsedSeconds: 101, rideContext }); await tick();
        assertEqual(calls.length, 2);
        assertEqual(calls[0].signal.aborted, true);
        calls[1].resolve({ ...calls[1].request, status: "ready", text: "新卡片提示", valid_for_s: 90 });
        calls[0].resolve({ ...calls[0].request, status: "ready", text: "旧卡片提示", valid_for_s: 90 });
        await tick();
        assertEqual(service.getState().rideHint.text, "新卡片提示");
        service.clear();
    } },
    { name: "returning to a prior mode cannot resurrect the previous hint", async run() {
        const { service, update, finish } = await setup();
        update(); await tick(); await finish();
        update({ rideContext: { active: true, sessionId: "ride1", revision: "sim" } });
        assertEqual(update().rideHint, null);
        service.clear();
    } },
    { name: "optional snapshot failure never breaks base card rendering", async run() {
        const service = createRouteNarrationService({ preparePlan: async () => createNarrationPlanFixture(route),
            refreshHint: () => { throw new Error("must not call"); },
            buildHintSnapshot: () => { throw new Error("missing sensor context"); } });
        service.enter(route); await service.load(route);
        const state = service.update({ distanceMeters: 0, elapsedSeconds: 100,
            rideContext: { active: true, sessionId: "ride", revision: "erg" } });
        assertEqual(state.status, "ready");
        assertEqual(state.item.summary, "第 1 条测试内容。");
        service.clear();
    } },
    { name: "manual browsing never refreshes a remote card and ignores late response", async run() {
        const { service, update, requests, finish } = await setup();
        update(); await tick(); service.next(); await finish();
        assertEqual(service.getState().rideHint, null);
        assertEqual(requests.length, 1);
        service.clear();
    } },
    { name: "actual timeout aborts request while leaving base card ready and rejects late result", async run() {
        const { service, update, finish, getSignal } = await setup({ timeout: 5 });
        update(); await new Promise((resolve) => setTimeout(resolve, 15));
        assertEqual(getSignal().aborted, true);
        assertEqual(service.getState().status, "ready");
        assertEqual(service.getState().hintLoading, false);
        await finish(); assertEqual(service.getState().rideHint, null); service.clear();
    } },
    ...["wall", "elapsed"].map((kind) => ({ name: `hint expires by ${kind} time`, async run() {
        const { service, update, finish, setNow } = await setup();
        update(); await tick(); await finish();
        assertEqual(service.getState().rideHint.text, "保持平顺");
        if (kind === "wall") setNow(191000);
        else update({ elapsedSeconds: 191 });
        assertEqual(service.getState().rideHint, null); service.clear();
    } })),
    ...["mode", "ended", "closed", "route", "session"].map((kind) => ({ name: `late hint ignored after ${kind}`, async run() {
        const { service, update, finish } = await setup();
        update(); await tick();
        if (kind === "mode") update({ rideContext: { active: true, sessionId: "ride1", revision: "sim" } });
        if (kind === "ended") update({ rideContext: { active: false, sessionId: "ride1", revision: "erg1" } });
        if (kind === "closed") service.dismiss();
        if (kind === "route") service.enter({ ...route, points: route.points.map((p) => ({ ...p, latitude: p.latitude + 1 })) });
        if (kind === "session") update({ rideContext: { active: true, sessionId: "ride2", revision: "new" } });
        await finish();
        assertEqual(service.getState().rideHint, null);
        service.clear();
    } }))
] };
