import { createOAuthStateStore, missingStravaRouteScopes } from "../../src/server/routes/strava-routes.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "oauth-state-store",
    tests: [
        {
            name: "consumes valid states once and clears their timer",
            run() {
                const clearedTimers = [];
                const store = createOAuthStateStore({
                    ttlMs: 1000,
                    now: () => 100,
                    setTimeoutFn: () => ({ id: "timer-1" }),
                    clearTimeoutFn: (timer) => clearedTimers.push(timer.id)
                });

                store.set("state-1", "athlete");

                const first = store.consume("state-1");
                const second = store.consume("state-1");

                assertEqual(first.userId, "athlete");
                assertEqual(second, null);
                assertEqual(clearedTimers.length, 1);
                assertEqual(clearedTimers[0], "timer-1");
                assertEqual(store.size(), 0);
            }
        },
        {
            name: "sweeps expired abandoned states",
            run() {
                let currentTime = 0;
                const store = createOAuthStateStore({
                    ttlMs: 1000,
                    now: () => currentTime,
                    setTimeoutFn: () => ({ id: "timer" }),
                    clearTimeoutFn: () => {}
                });

                store.set("state-1", "athlete");
                currentTime = 1001;

                store.sweepExpired();

                assertEqual(store.consume("state-1"), null);
                assertEqual(store.size(), 0);
            }
        },
        {
            name: "timer callback removes abandoned states",
            run() {
                let timeoutCallback = null;
                const store = createOAuthStateStore({
                    ttlMs: 1000,
                    now: () => 0,
                    setTimeoutFn: (callback) => {
                        timeoutCallback = callback;
                        return { id: "timer" };
                    },
                    clearTimeoutFn: () => {}
                });

                store.set("state-1", "athlete");
                assertEqual(store.size(), 1);

                timeoutCallback();

                assertEqual(store.size(), 0);
                assert(!store.has("state-1"), "expired state should be gone");
            }
        },
        {
            name: "requires both public and private Strava route read scopes",
            run() {
                assertEqual(
                    missingStravaRouteScopes("read,read_all,activity:read_all,activity:write").length,
                    0
                );
                assertEqual(
                    missingStravaRouteScopes("activity:read_all,activity:write").join(","),
                    "read,read_all"
                );
                assertEqual(missingStravaRouteScopes("read,activity:write").join(","), "read_all");
            }
        }
    ]
};
