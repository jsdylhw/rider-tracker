import { getFtmsReconnectDelayMs } from "../../src/adapters/bluetooth/trainer-ftms.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "trainer-ftms",
    tests: [
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
