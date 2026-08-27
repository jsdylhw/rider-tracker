import { buildCoordinateRoute } from "./coordinate-route.js";
import { parseRoutePlanView } from "./route-plan-view.js";

export function parseAgentRouteDraft(turnResult) {
    if (!turnResult?.route_plan) {
        if (turnResult?.status === "llm_unavailable") {
            throw new Error("Personal FIT Agent 当前不可用，请稍后重试。");
        }
        throw new Error(String(
            turnResult?.answer
            || "Agent 尚未返回路线业务数据，请补充起点、距离或路线偏好后重试。"
        ));
    }
    return parseRoutePlanView(turnResult.route_plan, { answer: turnResult.answer });
}

export function buildRiderRouteFromAgentCandidate(draft, candidateId) {
    const candidate = draft?.candidates?.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error("所选 AI 路线候选不存在。");
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

export function isRouteActivationOnly(turnResult) {
    const activatedRouteSkill = /^plan-/.test(String(turnResult?.skill_id || ""));
    const activatedTool = (turnResult?.executions ?? []).some((item) => item?.tool === "activate_skill");
    return !turnResult?.route_plan && (activatedRouteSkill || activatedTool);
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
