import { createTrainerFtms, getFtmsReconnectDelayMs } from "../../src/adapters/bluetooth/trainer-ftms.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "trainer-ftms",
    tests: [
        {
            name: "disconnect cancels a pending GATT connection without publishing connected",
            async run() {
                const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
                let resolveConnect;
                let serviceRequests = 0;
                const statuses = [];
                const device = {
                    addEventListener() {}, removeEventListener() {},
                    gatt: {
                        connected: false,
                        connect: () => new Promise(resolve => { resolveConnect = resolve; }),
                        disconnect() { this.connected = false; }
                    }
                };
                Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
                    bluetooth: { requestDevice: async () => device }
                } });
                try {
                    const trainer = createTrainerFtms({ onStatus: status => statuses.push(status) });
                    const pending = trainer.connect();
                    await Promise.resolve();
                    await trainer.disconnect();
                    device.gatt.connected = true;
                    resolveConnect({ getPrimaryService() { serviceRequests++; } });
                    await pending;
                    assertEqual(device.gatt.connected, false);
                    assertEqual(serviceRequests, 0);
                    assertEqual(statuses.some(status => status.type === "connected"), false);
                    assertEqual(statuses.at(-1).type, "disconnected");
                } finally {
                    if (original) Object.defineProperty(globalThis, "navigator", original);
                    else delete globalThis.navigator;
                }
            }
        },
        {
            name: "ending a ride cancels the scheduled retry and clears reconnecting status",
            async run() {
                const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
                const oldSetTimeout = globalThis.setTimeout;
                const oldClearTimeout = globalThis.clearTimeout;
                let scheduled = null;
                let disconnected;
                const statuses = [];
                const device = {
                    addEventListener(name, listener) { disconnected = listener; },
                    removeEventListener() {},
                    gatt: { connected: false, async connect() {
                        this.connected = true;
                        return { async getPrimaryService() { return { async getCharacteristic(id) {
                            if (id.includes("2ad2")) throw new Error("No data stream");
                            return {};
                        } }; } };
                    }, disconnect() { this.connected = false; } }
                };
                Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
                    bluetooth: { requestDevice: async () => device }
                } });
                globalThis.setTimeout = callback => { scheduled = callback; return 123; };
                globalThis.clearTimeout = () => { scheduled = null; };
                try {
                    const trainer = createTrainerFtms({ onStatus: status => statuses.push(status) });
                    await trainer.connect();
                    trainer.setAutoReconnectEnabled(true);
                    device.gatt.connected = false;
                    disconnected();
                    assertEqual(typeof scheduled, "function");
                    assertEqual(statuses.at(-1).type, "reconnecting");
                    trainer.setAutoReconnectEnabled(false);
                    assertEqual(scheduled, null);
                    assertEqual(statuses.at(-1).type, "disconnected");
                    await trainer.disconnect();
                } finally {
                    globalThis.setTimeout = oldSetTimeout;
                    globalThis.clearTimeout = oldClearTimeout;
                    if (original) Object.defineProperty(globalThis, "navigator", original);
                    else delete globalThis.navigator;
                }
            }
        },
        {
            name: "FTMS reconnect uses dense attempts during the first ten seconds then backs off",
            run() {
                assertEqual(getFtmsReconnectDelayMs(0), 1000);
                assertEqual(getFtmsReconnectDelayMs(1), 2000);
                assertEqual(getFtmsReconnectDelayMs(2), 3000);
                assertEqual(getFtmsReconnectDelayMs(3), 4000);
                assertEqual(getFtmsReconnectDelayMs(4), 10000);
                assertEqual(getFtmsReconnectDelayMs(6), 40000);
                assertEqual(getFtmsReconnectDelayMs(99), 60000);
            }
        }
    ]
};
