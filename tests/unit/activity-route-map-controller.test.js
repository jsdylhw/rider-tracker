import {
    collectActivityRouteMapLatLngs,
    hasActivityRouteMap
} from "../../src/ui/map/activity-route-map-controller.js";
import { assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "activity-route-map-controller",
    tests: [
        {
            name: "uses persisted route geometry before sampled records",
            run() {
                const activity = createActivity();
                const points = collectActivityRouteMapLatLngs(activity);

                assertEqual(points.length, 2);
                assertEqual(points[0][0], 31.1);
                assertEqual(points[1][1], 121.12);
                assertEqual(hasActivityRouteMap(activity), true);
            }
        },
        {
            name: "uses recorded GPS positions when the route geometry is absent",
            run() {
                const activity = createActivity();
                activity.rawSession.route.points = [];
                const points = collectActivityRouteMapLatLngs(activity);

                assertEqual(points.length, 2);
                assertEqual(points[0][1], 121.1);
            }
        },
        {
            name: "prefers compact map geometry when an archived route has no full points",
            run() {
                const activity = createActivity();
                activity.rawSession.route.points = [];
                activity.rawSession.route.mapGeometry = [
                    { latitude: 35.01, longitude: 135.76 },
                    { latitude: 35.02, longitude: 135.77 }
                ];
                const points = collectActivityRouteMapLatLngs(activity);

                assertEqual(points[0][0], 35.01);
                assertEqual(points[1][1], 135.77);
            }
        },
        {
            name: "does not show a map for manual routes",
            run() {
                const activity = createActivity();
                activity.rawSession.route.source = "manual";

                assertEqual(hasActivityRouteMap(activity), false);
            }
        }
    ]
};

function createActivity() {
    return {
        rawSession: {
            route: {
                source: "gpx",
                points: [
                    { latitude: 31.1, longitude: 121.1 },
                    { latitude: 31.11, longitude: 121.12 }
                ]
            },
            records: [
                { positionLat: 31.1, positionLong: 121.1 },
                { positionLat: 31.11, positionLong: 121.12 }
            ]
        }
    };
}
