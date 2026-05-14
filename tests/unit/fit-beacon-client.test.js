import { sendFitBeacon } from "../../src/adapters/upload/fit-beacon-client.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "fit-beacon-client",
    tests: [
        {
            name: "无 fitBytes 时返回 false",
            run() {
                const sent = sendFitBeacon({
                    fitBytes: null,
                    session: { id: "test" },
                    serverUrl: "http://localhost:8787"
                });
                assertEqual(sent, false);
            }
        },
        {
            name: "无 session 时返回 false",
            run() {
                const sent = sendFitBeacon({
                    fitBytes: new Uint8Array([1, 2, 3]),
                    session: null,
                    serverUrl: "http://localhost:8787"
                });
                assertEqual(sent, false);
            }
        },
        {
            name: "无 serverUrl 时返回 false",
            run() {
                const sent = sendFitBeacon({
                    fitBytes: new Uint8Array([1, 2, 3]),
                    session: { id: "test" },
                    serverUrl: ""
                });
                assertEqual(sent, false);
            }
        },
        {
            name: "navigator 不可用时返回 false",
            run() {
                const originalNavigator = globalThis.navigator;
                delete globalThis.navigator;

                try {
                    const sent = sendFitBeacon({
                        fitBytes: new Uint8Array([1, 2, 3]),
                        session: { id: "test" },
                        serverUrl: "http://localhost:8787"
                    });
                    assertEqual(sent, false);
                } finally {
                    if (originalNavigator !== undefined) {
                        Object.defineProperty(globalThis, "navigator", {
                            value: originalNavigator,
                            configurable: true,
                            writable: true
                        });
                    }
                }
            }
        },
        {
            name: "正常参数 + 显式 serverUrl 走 sendBeacon happy path",
            run() {
                const sentCalls = [];
                const originalNavigator = globalThis.navigator;
                Object.defineProperty(globalThis, "navigator", {
                    value: {
                        sendBeacon(url, body) {
                            sentCalls.push({ url, body });
                            return true;
                        }
                    },
                    configurable: true,
                    writable: true
                });

                try {
                    const fitBytes = new Uint8Array([1, 2, 3]);
                    const session = { id: "test-activity", summary: { metrics: {} } };
                    const sent = sendFitBeacon({
                        fitBytes,
                        session,
                        name: "Test Ride",
                        sportType: "VirtualRide",
                        serverUrl: "http://localhost:8787"
                    });

                    assertEqual(sent, true);
                    assertEqual(sentCalls.length, 1);
                    assertEqual(sentCalls[0].url, "http://localhost:8787/api/activities/fit-beacon");

                    const formData = sentCalls[0].body;
                    assertEqual(formData instanceof FormData, true);
                } finally {
                    if (originalNavigator === undefined) delete globalThis.navigator;
                    else Object.defineProperty(globalThis, "navigator", {
                        value: originalNavigator,
                        configurable: true,
                        writable: true
                    });
                }
            }
        }
    ]
};
