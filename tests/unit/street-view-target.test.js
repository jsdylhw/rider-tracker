import {
    buildStreetViewTargetFromRoute,
    chooseRouteAlignedLink,
    getNativeLookaheadHopCount,
    getRouteDistanceAtPosition,
    interpolateHeading,
    shouldThrottleNativePanoSwitch
} from "../../src/ui/map/street-view-controller.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

export const suite = {
    name: "street-view-target",
    tests: [
        {
            name: "adapts a fixed route into a street view navigation target",
            run() {
                const target = buildStreetViewTargetFromRoute({
                    totalDistanceMeters: 200,
                    points: [
                        { latitude: 31.2, longitude: 121.4, distanceMeters: 0, gradePercent: 2 },
                        { latitude: 31.2, longitude: 121.402, distanceMeters: 200, gradePercent: 6 }
                    ]
                }, {
                    distanceKm: 0.1,
                    speedKph: 18
                });

                assertEqual(target.latitude, 31.2);
                assertGreaterThan(target.longitude, 121.4);
                assertGreaterThan(target.gradePercent, 2);
                assertGreaterThan(target.heading, 80);
                assertEqual(target.speedKph, 18);
                assertEqual(target.route.points.length, 2);
                assertEqual(target.distanceMeters, 100);
            }
        },
        {
            name: "prefers the native link aligned with the route and avoids the pano just left",
            run() {
                const link = chooseRouteAlignedLink([
                    { pano: "back", heading: 185 },
                    { pano: "forward", heading: 4 },
                    { pano: "side", heading: 82 }
                ], 0, "current", ["back"]);

                assertEqual(link.pano, "forward");
            }
        },
        {
            name: "projects a panorama position onto route distance before native navigation",
            run() {
                const distanceMeters = getRouteDistanceAtPosition({
                    points: [
                        { latitude: 31.2, longitude: 121.4, distanceMeters: 0 },
                        { latitude: 31.2, longitude: 121.402, distanceMeters: 200 }
                    ]
                }, { lat: 31.2, lng: 121.401 });

                assertGreaterThan(distanceMeters, 90);
                assertGreaterThan(110, distanceMeters);
            }
        },
        {
            name: "uses rider speed to increase metadata lookahead without skipping rendered panos",
            run() {
                assertEqual(getNativeLookaheadHopCount(12), 1);
                assertEqual(getNativeLookaheadHopCount(22), 2);
                assertEqual(getNativeLookaheadHopCount(36), 3);
            }
        },
        {
            name: "holds a native pano when a new handoff would be too soon or too close",
            run() {
                assertEqual(shouldThrottleNativePanoSwitch({
                    currentDistanceMeters: 105,
                    lastSwitchDistanceMeters: 100,
                    elapsedSinceLastSwitchMs: 1200
                }), true);
                assertEqual(shouldThrottleNativePanoSwitch({
                    currentDistanceMeters: 112,
                    lastSwitchDistanceMeters: 100,
                    elapsedSinceLastSwitchMs: 600
                }), true);
                assertEqual(shouldThrottleNativePanoSwitch({
                    currentDistanceMeters: 112,
                    lastSwitchDistanceMeters: 100,
                    elapsedSinceLastSwitchMs: 1300
                }), false);
            }
        },
        {
            name: "eases heading along the shortest direction across north",
            run() {
                assertEqual(interpolateHeading(350, 10, 0.5), 0);
                assertEqual(interpolateHeading(10, 350, 0.5), 0);
            }
        }
    ]
};
