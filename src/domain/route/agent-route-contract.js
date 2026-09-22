import { buildCoordinateRoute } from "./coordinate-route.js";
import { parseRoutePlanView } from "./route-plan-view.js";

export function parseAgentRouteDraft(turnResult) {
    const operation = turnResult?.route_operation;
    const view = turnResult?.route_plan;
    const persistedFailure = operation?.schema_version === "route_operation.v1"
        && operation.status === "failed" && view?.itinerary_schema_version === "cycling_itinerary.v1"
        && operation.plan_id === view.plan_id && operation.revision === view.revision
        && view.candidates?.some((day) => day.candidate_id === operation.candidate_id && day.day_status === "failed");
    if (turnResult?.error?.code && !persistedFailure) {
        const diagnostic = turnResult.error;
        const error = new Error(String(diagnostic.message || turnResult.answer || "路线处理失败。"));
        error.name = "AgentRouteError";
        error.code = diagnostic.code;
        error.stage = diagnostic.stage ?? null;
        error.provider = diagnostic.provider ?? null;
        error.retryable = diagnostic.retryable === true;
        throw error;
    }
    if (!turnResult?.route_plan) {
        if (turnResult?.status === "llm_unavailable") {
            throw new Error("Personal FIT Agent 当前不可用，请稍后重试。");
        }
        throw new Error(String(
            turnResult?.answer
            || "Agent 尚未返回路线业务数据，请补充起点、距离或路线偏好后重试。"
        ));
    }
    return {
        ...parseRoutePlanView(turnResult.route_plan, { answer: turnResult.answer }),
        operationError: persistedFailure ? turnResult.error : null
    };
}

export function buildRiderRouteFromAgentCandidate(draft, candidateId) {
    const candidate = draft?.candidates?.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error("所选 AI 路线候选不存在。");
    if (draft.dailyItinerary && candidate.dayStatus !== "ready" && !candidate.previousRoute) throw new Error("当天路线尚未生成，不能加载骑行。");
    const routePath = candidate.coordinates.map(([longitude, latitude]) => ({ lat: latitude, lng: longitude }));
    const routeWaypoints = candidate.waypoints?.length >= 2
        ? candidate.waypoints
        : resolveRouteWaypoints(routePath);
    const route = buildCoordinateRoute({
        waypoints: routeWaypoints,
        routePath,
        totalDistanceMeters: candidate.distanceKm ? candidate.distanceKm * 1000 : null,
        estimatedDuration: candidate.durationMinutes ? `${Math.round(candidate.durationMinutes * 60)}s` : null,
        travelMode: candidate.travelMode,
        source: "agent-planned",
        name: candidate.name,
        routeProvider: "personal-fit-agent"
    });
    return {
        ...route,
        source: "agent-planned",
        name: candidate.name,
        routeProvider: "personal-fit-agent",
        hasElevationData: false,
        isDraft: draft.planningStatus !== "confirmed",
        agentPlanId: draft.planId,
        agentCandidateId: candidate.candidateId,
        agentSegmentOverlays: segmentsForCandidate(draft.segments, candidate).map((segment) => ({
            segmentId: segment.segmentId,
            name: segment.name,
            coordinates: segment.coordinates,
        })),
        agentMetadata: {
            provider: candidate.provider,
            stravaSegments: candidate.stravaSegments,
            planningStatus: draft.planningStatus,
            revision: draft.revision
        }
    };
}

function resolveRouteWaypoints(routePath) {
    const first = routePath[0];
    const last = routePath.at(-1);
    if (first.lat !== last.lat || first.lng !== last.lng) return [first, last];
    return [first, routePath[Math.floor(routePath.length / 2)]];
}

function segmentsForCandidate(segments, candidate) {
    const targetId = candidate?.parentCandidateId || candidate?.candidateId;
    return (segments ?? []).filter((segment) => (
        !segment.candidateIds?.length || segment.candidateIds.includes(targetId)
    ));
}
