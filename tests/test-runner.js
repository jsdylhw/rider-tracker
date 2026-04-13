import { runSuites, renderResults } from "./helpers/test-harness.js";
import { suite as routeSuite } from "./unit/route-builder.test.js";
import { suite as gpxSuite } from "./unit/gpx-parser.test.js";
import { suite as physicsSuite } from "./unit/cycling-model.test.js";
import { suite as simulatorSuite } from "./unit/simulator.test.js";
import { suite as liveRideSuite } from "./unit/live-ride-session.test.js";

const app = document.getElementById("app");
const suites = [routeSuite, gpxSuite, physicsSuite, simulatorSuite, liveRideSuite];

runSuites(suites).then((results) => {
    renderResults(results, app);
    const failed = results.filter((result) => result.status === "failed");
    document.title = failed.length === 0
        ? `Tests Passed (${results.length})`
        : `Tests Failed (${failed.length}/${results.length})`;
}).catch((error) => {
    app.innerHTML = `<pre>${error.stack || error.message}</pre>`;
    document.title = "Tests Crashed";
});
