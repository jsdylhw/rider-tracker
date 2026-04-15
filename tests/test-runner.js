import { runSuites, renderResults } from "./helpers/test-harness.js";
import { suite as routeSuite } from "./unit/route-builder.test.js";
import { suite as gpxSuite } from "./unit/gpx-parser.test.js";
import { suite as physicsSuite } from "./unit/cycling-model.test.js";
import { suite as simulatorSuite } from "./unit/simulator.test.js";
import { suite as liveRideSuite } from "./unit/live-ride-session.test.js";
import { suite as gradeSimSuite } from "./unit/grade-sim-mode.test.js";
import { suite as ergSuite } from "./unit/erg-mode.test.js";
import { suite as resistanceSuite } from "./unit/resistance-mode.test.js";
import { suite as trainerCommandSuite } from "./unit/trainer-command.test.js";
import { suite as workoutServiceSuite } from "./unit/workout-service.test.js";
import { suite as ergLiveFlowSuite } from "./integration/erg-live-flow.test.js";

const app = typeof document !== 'undefined' ? document.getElementById("app") : null;
const suites = [
    routeSuite,
    gpxSuite,
    physicsSuite,
    simulatorSuite,
    liveRideSuite,
    gradeSimSuite,
    ergSuite,
    resistanceSuite,
    trainerCommandSuite,
    workoutServiceSuite,
    ergLiveFlowSuite
];

runSuites(suites).then((results) => {
    renderResults(results, app);
    const failed = results.filter((result) => result.status === "failed");
    if (app) {
        document.title = failed.length === 0
            ? `Tests Passed (${results.length})`
            : `Tests Failed (${failed.length}/${results.length})`;
    }
}).catch((error) => {
    if (app) {
        app.innerHTML = `<pre>${error.stack || error.message}</pre>`;
        document.title = "Tests Crashed";
    } else {
        console.error(error);
        process.exit(1);
    }
});
