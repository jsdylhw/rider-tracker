import { createRouteNarrationService } from "../../src/app/services/route-narration-service.js";
import { createNarrationPlanFixture } from "../helpers/narration-fixture.js";
import { assertEqual } from "../helpers/test-harness.js";

function createRoute(name) {
    return {
        source: "test",
        name,
        totalDistanceMeters: 10000,
        points: [
            { distanceMeters: 0, latitude: 1, longitude: 1, elevationMeters: 0, gradePercent: 0 },
            { distanceMeters: 10000, latitude: 2, longitude: 2, elevationMeters: 0, gradePercent: 0 }
        ],
        segments: []
    };
}

export const suite = {
    name: "route-narration-service",
    tests: [
        {
            name: "entering Street View prompts without starting preparation",
            async run() {
                let calls = 0;
                const service = createRouteNarrationService({
                    preparePlan: async (route) => {
                        calls += 1;
                        return createNarrationPlanFixture(route);
                    }
                });
                service.enter(createRoute("consent"));
                assertEqual(service.getState().status, "prompt");
                assertEqual(calls, 0);
            }
        },
        {
            name: "reuses one in-flight request for the same route fingerprint",
            async run() {
                let calls = 0;
                let resolvePlan;
                const route = createRoute("in-flight");
                const service = createRouteNarrationService({
                    preparePlan: () => {
                        calls += 1;
                        return new Promise((resolve) => { resolvePlan = resolve; });
                    }
                });
                service.enter(route);
                const first = service.load(route);
                const second = service.load(route);
                await Promise.resolve();
                assertEqual(calls, 1);
                resolvePlan(createNarrationPlanFixture(route));
                await Promise.all([first, second]);
                assertEqual(service.getState().status, "ready");
            }
        },
        {
            name: "leaving and re-entering the same ride restores cached cards",
            async run() {
                let calls = 0;
                const route = createRoute("cached");
                const service = createRouteNarrationService({
                    preparePlan: async (value) => {
                        calls += 1;
                        return createNarrationPlanFixture(value);
                    }
                });
                service.enter(route);
                await service.load(route);
                service.leave();
                service.enter(route);
                assertEqual(service.getState().status, "ready");
                assertEqual(service.getState().item.item_id, "fixture_1");
                assertEqual(calls, 1);
            }
        },
        {
            name: "dismiss does not persist a rejection across Street View entries",
            run() {
                const route = createRoute("dismiss");
                const service = createRouteNarrationService({
                    preparePlan: async (value) => createNarrationPlanFixture(value)
                });
                service.enter(route);
                service.dismiss();
                assertEqual(service.getState().status, "closed");
                service.leave();
                service.enter(route);
                assertEqual(service.getState().status, "prompt");
            }
        },
        {
            name: "clear removes the narration cache at ride end",
            async run() {
                const route = createRoute("ride-end");
                const service = createRouteNarrationService({
                    preparePlan: async (value) => createNarrationPlanFixture(value)
                });
                service.enter(route);
                await service.load(route);
                service.clear();
                service.enter(route);
                assertEqual(service.getState().status, "prompt");
                assertEqual(service.getState().cached, false);
            }
        },
        {
            name: "explicit retry reruns a failed provider",
            async run() {
                let calls = 0;
                const route = createRoute("retry");
                const service = createRouteNarrationService({
                    preparePlan: async (value) => {
                        calls += 1;
                        if (calls === 1) throw new Error("temporary failure");
                        return createNarrationPlanFixture(value);
                    }
                });
                service.enter(route);
                await service.load(route);
                assertEqual(service.getState().status, "failed");
                await service.retry(route);
                assertEqual(service.getState().status, "ready");
                assertEqual(calls, 2);
            }
        }
    ]
};
