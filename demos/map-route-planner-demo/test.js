import assert from "node:assert/strict";
import {
    isCurrentRouteRequest,
    scaleRoutePointDistances
} from "./route-planner-core.js";

const originalPoints = [
    { latitude: 0, longitude: 0, distanceMeters: 0 },
    { latitude: 0, longitude: 1, distanceMeters: 120 },
    { latitude: 0, longitude: 2, distanceMeters: 300 }
];
const scaledPoints = scaleRoutePointDistances(originalPoints, 450);

assert.deepEqual(
    scaledPoints.map((point) => point.distanceMeters),
    [0, 180, 450],
    "sampled route distances should be scaled to the selected total distance"
);
assert.deepEqual(
    originalPoints.map((point) => point.distanceMeters),
    [0, 120, 300],
    "scaling should not mutate the sampled points"
);
assert.equal(isCurrentRouteRequest(4, 4), true, "current requests may commit their result");
assert.equal(isCurrentRouteRequest(4, 5), false, "stale requests must not commit their result");

console.log("Passed 4 / 4 map-route-planner-demo tests");
