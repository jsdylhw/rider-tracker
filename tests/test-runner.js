import { runSuites, renderResults } from "./helpers/test-harness.js";
import { installDomParserPolyfill } from "./helpers/dom-parser-polyfill.js";
import { suite as routeSuite } from "./unit/route-builder.test.js";
import { suite as gpxSuite } from "./unit/gpx-parser.test.js";
import { suite as physicsSuite } from "./unit/cycling-model.test.js";
import { suite as heartRateModelSuite } from "./unit/heart-rate-model.test.js";
import { suite as sensorSamplingSuite } from "./unit/sensor-sampling.test.js";
import { suite as simulatorSuite } from "./unit/simulator.test.js";
import { suite as liveRideSuite } from "./unit/live-ride-session.test.js";
import { suite as gradeSimSuite } from "./unit/grade-sim-mode.test.js";
import { suite as ergSuite } from "./unit/erg-mode.test.js";
import { suite as resistanceSuite } from "./unit/resistance-mode.test.js";
import { suite as trainerCommandSuite } from "./unit/trainer-command.test.js";
import { suite as workoutServiceSuite } from "./unit/workout-service.test.js";
import { suite as customWorkoutTargetSuite } from "./unit/custom-workout-target.test.js";
import { suite as ergLiveFlowSuite } from "./integration/erg-live-flow.test.js";
import { suite as gpxFixturesSuite } from "./integration/gpx-fixtures.test.js";
import { suite as rideRegressionSuite } from "./integration/ride-regression.test.js";
import { suite as streetviewUiSuite } from "./integration/streetview-ui.test.js";
import { suite as routeRendererImportSuite } from "./unit/route-renderer-import.test.js";
import { suite as routeChartSvgSuite } from "./unit/route-chart-svg.test.js";

const app = typeof document !== 'undefined' ? document.getElementById("app") : null;
installDomParserPolyfill();
const suites = [
    routeSuite,
    gpxSuite,
    physicsSuite,
    heartRateModelSuite,
    sensorSamplingSuite,
    simulatorSuite,
    liveRideSuite,
    gradeSimSuite,
    ergSuite,
    resistanceSuite,
    trainerCommandSuite,
    workoutServiceSuite,
    customWorkoutTargetSuite,
    ergLiveFlowSuite,
    gpxFixturesSuite,
    rideRegressionSuite,
    streetviewUiSuite,
    routeRendererImportSuite,
    routeChartSvgSuite
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
