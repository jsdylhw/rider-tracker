import {
    buildRouteNarrationFingerprint,
    ROUTE_NARRATION_SCHEMA_VERSION
} from "../../src/domain/narration/narration-plan.js";

export function createNarrationPlanFixture(route, { itemCount = 3 } = {}) {
    const totalDistance = Number(route.totalDistanceMeters) || 0;
    return {
        schema_version: ROUTE_NARRATION_SCHEMA_VERSION,
        plan_id: `fixture_${route.name}`,
        route_fingerprint: buildRouteNarrationFingerprint(route),
        locale: "zh-CN",
        status: "ready",
        content_profile: "test",
        route: { name: route.name, total_distance_m: totalDistance },
        items: Array.from({ length: itemCount }, (_, index) => ({
            item_id: `fixture_${index + 1}`,
            route_distance_m: itemCount === 1 ? 0 : totalDistance * index / (itemCount - 1),
            title: `测试讲解 ${index + 1}`,
            summary: `第 ${index + 1} 条测试内容。`,
            trigger: { lead_distance_m: 300, expire_distance_m: 500, minimum_gap_seconds: 75 }
        })),
        warnings: []
    };
}
