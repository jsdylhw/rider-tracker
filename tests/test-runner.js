import { runSuites, renderResults } from "./helpers/test-harness.js";
import { installDomParserPolyfill } from "./helpers/dom-parser-polyfill.js";
import { suite as routeSuite } from "./unit/route-builder.test.js";
import { suite as mapDrawRouteSuite } from "./unit/map-draw-route.test.js";
import { suite as osmRoadNetworkSuite } from "./unit/osm-road-network.test.js";
import { suite as mapControllerSuite } from "./unit/map-controller.test.js";
import { suite as overpassClientSuite } from "./unit/overpass-client.test.js";
import { suite as streetViewTargetSuite } from "./unit/street-view-target.test.js";
import { suite as googleElevationClientSuite } from "./unit/google-elevation-client.test.js";
import { suite as googleRoutesClientSuite } from "./unit/google-routes-client.test.js";
import { suite as googleMapsConfigServiceSuite } from "./unit/google-maps-config-service.test.js";
import { suite as googleMapsServiceModalSuite } from "./unit/google-maps-service-modal.test.js";
import { suite as homeViewModalSuite } from "./unit/home-view-modal.test.js";
import { suite as routeServiceElevationSuite } from "./unit/route-service-elevation.test.js";
import { suite as gpxSuite } from "./unit/gpx-parser.test.js";
import { suite as physicsSuite } from "./unit/cycling-model.test.js";
import { suite as heartRateModelSuite } from "./unit/heart-rate-model.test.js";
import { suite as initialStateSuite } from "./unit/initial-state.test.js";
import { suite as appStoreSuite } from "./unit/app-store.test.js";
import { suite as mainViewRenderingSuite } from "./unit/main-view-rendering.test.js";
import { suite as sensorSamplingSuite } from "./unit/sensor-sampling.test.js";
import { suite as simulatorSuite } from "./unit/simulator.test.js";
import { suite as liveRideSuite } from "./unit/live-ride-session.test.js";
import { suite as rideMetricsSuite } from "./unit/ride-metrics.test.js";
import { suite as fitExporterSuite } from "./unit/fit-exporter.test.js";
import { suite as gradeSimSuite } from "./unit/grade-sim-mode.test.js";
import { suite as ergSuite } from "./unit/erg-mode.test.js";
import { suite as resistanceSuite } from "./unit/resistance-mode.test.js";
import { suite as trainerCommandSuite } from "./unit/trainer-command.test.js";
import { suite as rideReadinessSuite } from "./unit/ride-readiness.test.js";
import { suite as workoutServiceSuite } from "./unit/workout-service.test.js";
import { suite as customWorkoutTargetSuite } from "./unit/custom-workout-target.test.js";
import { suite as customWorkoutTargetRendererSuite } from "./unit/custom-workout-target-renderer.test.js";
import { suite as deviceRendererSuite } from "./unit/device-renderer.test.js";
import { suite as ergLiveFlowSuite } from "./integration/erg-live-flow.test.js";
import { suite as gpxFixturesSuite } from "./integration/gpx-fixtures.test.js";
import { suite as rideRegressionSuite } from "./integration/ride-regression.test.js";
import { suite as virtualRideDebugFlowSuite } from "./integration/virtual-ride-debug-flow.test.js";
import { suite as streetviewUiSuite } from "./integration/streetview-ui.test.js";
import { suite as routeRendererImportSuite } from "./unit/route-renderer-import.test.js";
import { suite as routeRendererMapPlannerSuite } from "./unit/route-renderer-map-planner.test.js";
import { suite as routeRendererImmersiveSuite } from "./unit/route-renderer-immersive.test.js";
import { suite as routeChartSvgSuite } from "./unit/route-chart-svg.test.js";
import { suite as exportViewSuite } from "./unit/export-view.test.js";
import { suite as liveRideViewModelSuite } from "./unit/live-ride-view-model.test.js";
import { suite as liveViewSuite } from "./unit/live-view.test.js";
import { suite as liveMetricsSuite } from "./unit/live-metrics.test.js";
import { suite as pipChartsSuite } from "./unit/pip-charts.test.js";
import { suite as pipElevationChartSuite } from "./unit/pip-elevation-chart.test.js";
import { suite as pipPreferencesSuite } from "./unit/pip-preferences.test.js";
import { suite as rideSeriesChartSuite } from "./unit/ride-series-chart.test.js";
import { suite as activityStoreSuite } from "./unit/activity-store.test.js";
import { suite as routeLibraryStoreSuite } from "./unit/route-library-store.test.js";
import { suite as routeLibraryRendererSuite } from "./unit/route-library-renderer.test.js";
import { suite as routeContinuationSuite } from "./unit/route-continuation.test.js";
import { suite as activityHistoryRendererSuite } from "./unit/activity-history-renderer.test.js";
import { suite as activityDetailRendererSuite } from "./unit/activity-detail-renderer.test.js";
import { suite as activityDetailViewSuite } from "./unit/activity-detail-view.test.js";
import { suite as activityRouteMapControllerSuite } from "./unit/activity-route-map-controller.test.js";
import { suite as fitBeaconClientSuite } from "./unit/fit-beacon-client.test.js";
import { suite as incrementalPowerMetricsSuite } from "./unit/incremental-power-metrics.test.js";
import { suite as oauthStateStoreSuite } from "./unit/oauth-state-store.test.js";
import { suite as localApiSecuritySuite } from "./unit/local-api-security.test.js";
import { suite as agentFloatingWindowSuite } from "./unit/agent-floating-window.test.js";
import { suite as safeMarkdownRendererSuite } from "./unit/safe-markdown-renderer.test.js";
import { suite as agentRouteContractSuite } from "./unit/agent-route-contract.test.js";
import { suite as personalFitAgentClientSuite } from "./unit/personal-fit-agent-client.test.js";
import { suite as agentRouteServiceSuite } from "./unit/agent-route-service.test.js";
import { suite as agentRoutePlannerSuite } from "./unit/agent-route-planner.test.js";
import { suite as localConfigSuite } from "./unit/local-config.test.js";

const app = typeof document !== 'undefined' ? document.getElementById("app") : null;
installDomParserPolyfill();
const suites = [
    routeSuite,
    mapDrawRouteSuite,
    osmRoadNetworkSuite,
    mapControllerSuite,
    overpassClientSuite,
    streetViewTargetSuite,
    googleElevationClientSuite,
    googleRoutesClientSuite,
    googleMapsConfigServiceSuite,
    googleMapsServiceModalSuite,
    homeViewModalSuite,
    routeServiceElevationSuite,
    gpxSuite,
    physicsSuite,
    heartRateModelSuite,
    initialStateSuite,
    appStoreSuite,
    mainViewRenderingSuite,
    sensorSamplingSuite,
    simulatorSuite,
    liveRideSuite,
    rideMetricsSuite,
    fitExporterSuite,
    gradeSimSuite,
    ergSuite,
    resistanceSuite,
    trainerCommandSuite,
    rideReadinessSuite,
    workoutServiceSuite,
    customWorkoutTargetSuite,
    customWorkoutTargetRendererSuite,
    deviceRendererSuite,
    ergLiveFlowSuite,
    gpxFixturesSuite,
    rideRegressionSuite,
    virtualRideDebugFlowSuite,
    streetviewUiSuite,
    routeRendererImportSuite,
    routeRendererMapPlannerSuite,
    routeRendererImmersiveSuite,
    routeChartSvgSuite,
    exportViewSuite,
    liveRideViewModelSuite,
    liveViewSuite,
    liveMetricsSuite,
    pipChartsSuite,
    pipElevationChartSuite,
    pipPreferencesSuite,
    rideSeriesChartSuite,
    activityStoreSuite,
    routeLibraryStoreSuite,
    routeLibraryRendererSuite,
    routeContinuationSuite,
    activityHistoryRendererSuite,
    activityDetailRendererSuite,
    activityDetailViewSuite,
    activityRouteMapControllerSuite,
    fitBeaconClientSuite,
    incrementalPowerMetricsSuite,
    oauthStateStoreSuite,
    localApiSecuritySuite,
    agentFloatingWindowSuite,
    safeMarkdownRendererSuite,
    agentRouteContractSuite,
    personalFitAgentClientSuite,
    agentRouteServiceSuite,
    agentRoutePlannerSuite,
    localConfigSuite
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
