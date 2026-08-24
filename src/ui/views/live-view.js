import { createDeviceSetupView } from "./device-setup-view.js";
import { createLiveRideDashboard } from "./live-ride-dashboard-view.js";
import { createPreRideSetupView } from "./pre-ride-setup-view.js";
import { createRideReadinessView } from "./ride-readiness-view.js";
import { createRouteWorkspaceView } from "./route-workspace-view.js";

/**
 * Stable facade used by MainView. Feature views own their DOM and event bindings;
 * renderers still receive one flat element map while they are migrated independently.
 */
export function createLiveView({ onCloseRideDashboard, onStartRide, onStopRide, onUpdateRideInput }) {
    const routeWorkspace = createRouteWorkspaceView();
    const preRideSetup = createPreRideSetupView({ onUpdateRideInput });
    const deviceSetup = createDeviceSetupView();
    const rideReadiness = createRideReadinessView();
    const liveRideDashboard = createLiveRideDashboard({
        onClose: onCloseRideDashboard,
        onStart: onStartRide,
        onStop: onStopRide
    });

    return {
        elements: {
            ...routeWorkspace.elements,
            ...preRideSetup.elements,
            ...deviceSetup.elements,
            ...rideReadiness.elements,
            ...liveRideDashboard.elements
        }
    };
}
