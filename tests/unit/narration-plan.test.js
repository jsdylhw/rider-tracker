import {
    buildRouteNarrationFingerprint,
    normalizeRouteNarrationPlan,
    ROUTE_NARRATION_SCHEMA_VERSION
} from "../../src/domain/narration/narration-plan.js";
import { createNarrationPlanFixture } from "../helpers/narration-fixture.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

function createRoute(name = "京都测试路线") {
    return {
        source: "gpx",
        name,
        totalDistanceMeters: 30000,
        points: [
            { distanceMeters: 0, latitude: 35, longitude: 135, elevationMeters: 20, gradePercent: 0 },
            { distanceMeters: 15000, latitude: 35.1, longitude: 135.1, elevationMeters: 80, gradePercent: 1 },
            { distanceMeters: 30000, latitude: 35.2, longitude: 135.2, elevationMeters: 30, gradePercent: -1 }
        ],
        segments: []
    };
}

export const suite = {
    name: "narration-plan",
    tests: [
        {
            name: "fingerprint changes with route geometry",
            run() {
                const first = createRoute();
                const second = createRoute();
                second.points[1] = { ...second.points[1], longitude: 135.4 };
                assert(buildRouteNarrationFingerprint(first));
                assert(buildRouteNarrationFingerprint(first) !== buildRouteNarrationFingerprint(second));
            }
        },
        {
            name: "fingerprint ignores route display name",
            run() {
                assertEqual(
                    buildRouteNarrationFingerprint(createRoute("first name")),
                    buildRouteNarrationFingerprint(createRoute("renamed"))
                );
            }
        },
        {
            name: "test fixture uses the versioned contract and ordered route distances",
            run() {
                const plan = createNarrationPlanFixture(createRoute(), { itemCount: 12 });
                assertEqual(plan.schema_version, ROUTE_NARRATION_SCHEMA_VERSION);
                assertEqual(plan.items.length, 12);
                assertEqual(plan.items[0].route_distance_m, 0);
                assert(plan.items.every((item, index) => index === 0 || item.route_distance_m >= plan.items[index - 1].route_distance_m));
            }
        },
        {
            name: "normalizer preserves route-wide content scope and defaults legacy items to place",
            run() {
                const route = createRoute();
                const plan = createNarrationPlanFixture(route, { itemCount: 2 });
                const normalized = normalizeRouteNarrationPlan({
                    ...plan,
                    items: [
                        { ...plan.items[0], content_scope: "route" },
                        { ...plan.items[1], content_scope: undefined }
                    ]
                }, {
                    routeFingerprint: plan.route_fingerprint,
                    routeTotalDistanceMeters: route.totalDistanceMeters
                });

                assertEqual(normalized.items[0].content_scope, "route");
                assertEqual(normalized.items[1].content_scope, "place");
            }
        },
        {
            name: "normalizer accepts safe Google Place photo metadata and rejects unsafe URLs",
            run() {
                const route = createRoute();
                const plan = createNarrationPlanFixture(route, { itemCount: 1 });
                const normalized = normalizeRouteNarrationPlan({
                    ...plan,
                    items: [{
                        ...plan.items[0],
                        media: {
                            type: "google_place_photo",
                            photo_name: "places/place_1/photos/photo_1",
                            width: 1200,
                            height: 800,
                            source_url: "javascript:alert(1)",
                            author_attributions: [{
                                display_name: "摄影者",
                                uri: "https://maps.google.test/author"
                            }]
                        }
                    }]
                }, {
                    routeFingerprint: plan.route_fingerprint,
                    routeTotalDistanceMeters: route.totalDistanceMeters
                });

                assertEqual(normalized.items[0].media.photo_name, "places/place_1/photos/photo_1");
                assertEqual(normalized.items[0].media.source_url, "");
                assertEqual(normalized.items[0].media.author_attributions[0].display_name, "摄影者");
            }
        },
        {
            name: "normalizer rejects a plan for another route",
            run() {
                let error = null;
                try {
                    normalizeRouteNarrationPlan({
                        schema_version: ROUTE_NARRATION_SCHEMA_VERSION,
                        route_fingerprint: "route_a",
                        items: []
                    }, { routeFingerprint: "route_b" });
                } catch (cause) {
                    error = cause;
                }
                assert(error instanceof TypeError);
            }
        },
        {
            name: "normalizer rejects coordinates and distances outside the active route",
            run() {
                const route = createRoute();
                const plan = createNarrationPlanFixture(route);
                let error = null;
                try {
                    normalizeRouteNarrationPlan({
                        ...plan,
                        items: [{
                            ...plan.items[0],
                            latitude: 120,
                            route_distance_m: route.totalDistanceMeters + 1
                        }]
                    }, {
                        routeFingerprint: plan.route_fingerprint,
                        routeTotalDistanceMeters: route.totalDistanceMeters
                    });
                } catch (cause) {
                    error = cause;
                }
                assert(error instanceof TypeError);
            }
        }
    ]
};
