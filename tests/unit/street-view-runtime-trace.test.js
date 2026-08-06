import { createStreetViewRuntimeTrace } from "../../src/ui/map/street-view-runtime-trace.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "street-view-runtime-trace",
    tests: [
        {
            name: "keeps a bounded ordered trace with elapsed times",
            run() {
                let timestamp = 1000;
                const trace = createStreetViewRuntimeTrace({
                    maxEntries: 2,
                    now: () => timestamp
                });

                trace.record({ event: "first" });
                timestamp = 1250;
                trace.record({ event: "second" });
                timestamp = 1500;
                trace.record({ event: "third" });

                const snapshot = trace.snapshot();
                assertEqual(snapshot.entries.length, 2);
                assertEqual(snapshot.entries[0].event, "second");
                assertEqual(snapshot.entries[0].elapsedMs, 250);
                assertEqual(snapshot.entries[1].event, "third");
                assertEqual(snapshot.entries[1].sequence, 3);
            }
        }
    ]
};
