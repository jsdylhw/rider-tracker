import { buildStreetViewTargetFromRoute } from "../../src/ui/map/street-view-controller.js";
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
            }
        }
    ]
};
