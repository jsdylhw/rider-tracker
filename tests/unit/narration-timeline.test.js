import { createNarrationTimeline } from "../../src/domain/narration/narration-timeline.js";
import { assertEqual } from "../helpers/test-harness.js";

function createPlan() {
    return {
        plan_id: "plan_1",
        route_fingerprint: "route_1",
        items: [
            createItem("start", 0, 0),
            createItem("middle", 1000, 75),
            createItem("finish", 2000, 75)
        ]
    };
}

function createItem(itemId, routeDistance, minimumGapSeconds) {
    return {
        item_id: itemId,
        route_distance_m: routeDistance,
        trigger: {
            lead_distance_m: 100,
            expire_distance_m: 200,
            minimum_gap_seconds: minimumGapSeconds
        }
    };
}

export const suite = {
    name: "narration-timeline",
    tests: [
        {
            name: "automatically selects an item once inside its distance window",
            run() {
                const timeline = createNarrationTimeline();
                timeline.setPlan(createPlan());
                assertEqual(timeline.update({ distanceMeters: 0, elapsedSeconds: 0 }).item.item_id, "start");
                assertEqual(timeline.update({ distanceMeters: 920, elapsedSeconds: 80 }).item.item_id, "middle");
                assertEqual(timeline.update({ distanceMeters: 950, elapsedSeconds: 90 }).item.item_id, "middle");
            }
        },
        {
            name: "manual navigation does not consume future automatic items",
            run() {
                const timeline = createNarrationTimeline();
                timeline.setPlan(createPlan());
                timeline.update({ distanceMeters: 0, elapsedSeconds: 0 });
                assertEqual(timeline.next(0).item.item_id, "middle");
                assertEqual(timeline.update({ distanceMeters: 1900, elapsedSeconds: 100 }).item.item_id, "finish");
            }
        },
        {
            name: "manual selection remains visible on the next nearby tick",
            run() {
                const timeline = createNarrationTimeline();
                timeline.setPlan(createPlan());
                timeline.update({ distanceMeters: 0, elapsedSeconds: 0 });
                timeline.next(0);
                assertEqual(timeline.update({ distanceMeters: 10, elapsedSeconds: 1 }).item.item_id, "middle");
                const resumed = timeline.update({ distanceMeters: 920, elapsedSeconds: 80 });
                assertEqual(resumed.item.item_id, "middle");
                assertEqual(resumed.isAnnounced, true);
            }
        },
        {
            name: "overlapping trigger windows prefer higher priority",
            run() {
                const plan = createPlan();
                plan.items[0] = { ...plan.items[0], route_distance_m: 1000, trigger: { ...plan.items[0].trigger, priority: 1 } };
                plan.items[1] = { ...plan.items[1], trigger: { ...plan.items[1].trigger, priority: 10 } };
                const timeline = createNarrationTimeline();
                timeline.setPlan(plan);
                assertEqual(timeline.update({ distanceMeters: 950, elapsedSeconds: 0 }).item.item_id, "middle");
            }
        },
        {
            name: "a new route plan resets announcement progress",
            run() {
                const timeline = createNarrationTimeline();
                timeline.setPlan(createPlan());
                timeline.update({ distanceMeters: 0, elapsedSeconds: 0 });
                timeline.setPlan({ ...createPlan(), plan_id: "plan_2", route_fingerprint: "route_2" });
                assertEqual(timeline.update({ distanceMeters: 0, elapsedSeconds: 0 }).item.item_id, "start");
            }
        }
    ]
};
