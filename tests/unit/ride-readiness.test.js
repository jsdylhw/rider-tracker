import { deriveRideReadiness, formatReadinessMessages } from "../../src/domain/ride/ride-readiness.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "ride-readiness",
    tests: [
        {
            name: "formats multiple readiness reasons with one punctuation boundary",
            run() {
                assertEqual(formatReadinessMessages([
                    { message: "请先设置一条有效路线。" },
                    { message: "请连接骑行台功率或外置功率计。" },
                    { message: "当前控制模式需要连接智能骑行台。" }
                ]), "请先设置一条有效路线；请连接骑行台功率或外置功率计；当前控制模式需要连接智能骑行台。");
            }
        },
        {
            name: "debug virtual power only bypasses physical devices, not the route",
            run() {
                const ready = deriveRideReadiness({
                    route: route({ hasElevationData: false }),
                    workout: { mode: "fixed-power" },
                    rideInput: { powerSource: "virtual" },
                    ble: disconnectedBle(),
                    debugEnabled: true
                });
                assertEqual(ready.canStart, true);
                assertEqual(ready.requirements.powerSource, "debug-virtual");

                const missingRoute = deriveRideReadiness({
                    route: { totalDistanceMeters: 0 },
                    workout: { mode: "fixed-power" },
                    rideInput: { powerSource: "virtual" },
                    ble: disconnectedBle(),
                    debugEnabled: true
                });
                assertEqual(missingRoute.canStart, false);
                assert(missingRoute.blockers.some((item) => item.code === "route_not_ready"));
            }
        },
        {
            name: "grade simulation requires elevation and grade capability",
            run() {
                const noElevation = deriveRideReadiness({
                    route: route({ hasElevationData: false }),
                    workout: { mode: "grade-sim" },
                    rideInput: { powerSource: "device" },
                    ble: connectedBle({ gradeControlSupported: true })
                });
                assert(noElevation.blockers.some((item) => item.code === "route_elevation_required"));

                const unsupported = deriveRideReadiness({
                    route: route(),
                    workout: { mode: "grade-sim" },
                    rideInput: { powerSource: "device" },
                    ble: connectedBle({ gradeControlSupported: false })
                });
                assert(unsupported.blockers.some((item) => item.code === "trainer_gradeControlSupported_unsupported"));
            }
        },
        {
            name: "ERG accepts external power but still requires trainer target power control",
            run() {
                const ready = deriveRideReadiness({
                    route: route({ hasElevationData: false }),
                    workout: { mode: "fixed-power" },
                    rideInput: { powerSource: "device" },
                    ble: connectedBle({ powerSupported: true }, "external-power-meter")
                });
                assertEqual(ready.canStart, true);

                const unsupported = deriveRideReadiness({
                    route: route({ hasElevationData: false }),
                    workout: { mode: "fixed-power" },
                    rideInput: { powerSource: "device" },
                    ble: connectedBle({ powerSupported: false })
                });
                assertEqual(unsupported.canStart, false);
            }
        },
        {
            name: "draft route blocks every mode",
            run() {
                const readiness = deriveRideReadiness({
                    route: route({ isDraft: true }),
                    workout: { mode: "free-ride" },
                    rideInput: { powerSource: "device" },
                    ble: connectedBle({ resistanceSupported: true })
                });
                assert(readiness.blockers.some((item) => item.code === "route_not_confirmed"));
            }
        }
    ]
};

function route(overrides = {}) {
    return { totalDistanceMeters: 20_000, hasElevationData: true, ...overrides };
}

function disconnectedBle() {
    return {
        powerMeter: { isConnected: false, sourceType: "none" },
        trainer: { isConnected: false, connectionState: "disconnected", capabilities: {} }
    };
}

function connectedBle(capabilities, sourceType = "trainer") {
    return {
        powerMeter: { isConnected: true, sourceType, lastUpdated: Date.now() },
        trainer: {
            isConnected: true,
            connectionState: "connected",
            controlState: "ready",
            capabilities
        }
    };
}
