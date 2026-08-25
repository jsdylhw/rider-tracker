import { buildMapDrawRoute } from "./map-draw-route.js";

const VIRTUAL_ROUTE_SPEED_KMH = 25;

export function parseAgentRouteDraft(turnResult) {
    const presentations = Array.isArray(turnResult?.presentations) ? turnResult.presentations : [];
    const routeMaps = presentations.filter((item) => item?.type === "route_map");
    const candidateTable = presentations.find((item) => (
        item?.type === "table" && Array.isArray(item?.data?.rows)
        && item.data.rows.some((row) => row?.candidate)
    ));
    const metadata = collectCandidateMetadata(candidateTable?.data?.rows ?? []);
    const segmentMetadata = collectSegmentMetadata(presentations);
    const routes = routeMaps.flatMap((item) => item?.data?.routes ?? []);
    const plannedRoutes = routes.filter((route) => route?.kind === "planned_route" && route?.candidate_id);
    const planId = routeMaps.map((item) => item?.data?.plan_id).find(Boolean);
    const countryCode = routeMaps.map((item) => item?.data?.country_code).find(Boolean) || null;
    const grouped = new Map();

    for (const route of plannedRoutes) {
        const candidateId = String(route.candidate_id);
        const coordinates = normalizeCoordinates(route?.geometry?.coordinates);
        if (coordinates.length < 2) continue;
        if (!grouped.has(candidateId)) grouped.set(candidateId, []);
        grouped.get(candidateId).push({ route, coordinates });
    }

    const candidates = [...grouped.entries()].map(([candidateId, segments]) => {
        const info = metadata.get(candidateId)
            ?? metadata.get(segments[0].route.name)
            ?? metadata.get(stripStageSuffix(segments[0].route.name))
            ?? {};
        return {
            candidateId,
            parentCandidateId: segments[0].route.parent_candidate_id
                ? String(segments[0].route.parent_candidate_id) : null,
            name: info.name || stripStageSuffix(segments[0].route.name) || `路线候选 ${candidateId}`,
            distanceKm: positiveNumber(info.distanceKm),
            durationMinutes: virtualDurationMinutes(info.distanceKm, info.durationMinutes),
            provider: info.provider || "Personal FIT Agent",
            travelMode: info.travelMode || "BICYCLE",
            stravaSegments: info.stravaSegments || "",
            confirmed: info.confirmed === true,
            active: segments.some((segment) => segment.route.active === true),
            coordinates: joinCoordinateSegments(segments.map((segment) => segment.coordinates))
        };
    }).filter((candidate) => candidate.coordinates.length >= 2);

    if (!planId || candidates.length === 0) {
        throw new Error(routeDraftError(turnResult));
    }

    const stravaRoutes = routes.filter((route) => route?.kind === "strava_segment" && route?.segment_id);
    const segmentGeometry = new Map(stravaRoutes.map((route) => [
        Number(route.segment_id), normalizeCoordinates(route?.geometry?.coordinates),
    ]));
    const segments = [...segmentMetadata.values()].map((segment) => ({
        ...segment,
        coordinates: segmentGeometry.get(segment.segmentId) ?? [],
    }));

    return {
        planId: String(planId),
        countryCode,
        answer: String(turnResult?.answer || ""),
        planningStatus: routeMaps.map((item) => item?.data?.planning_status).find(Boolean) || "awaiting_selection",
        candidates,
        segments
    };
}

export function buildRiderRouteFromAgentCandidate(draft, candidateId) {
    const candidate = draft?.candidates?.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error("所选 AI 路线候选不存在。");
    const routePath = candidate.coordinates.map(([longitude, latitude]) => ({ lat: latitude, lng: longitude }));
    const routeWaypoints = resolveRouteWaypoints(routePath);
    const route = buildMapDrawRoute({
        waypoints: routeWaypoints,
        routePath,
        totalDistanceMeters: candidate.distanceKm ? candidate.distanceKm * 1000 : null,
        estimatedDuration: candidate.durationMinutes ? `${Math.round(candidate.durationMinutes * 60)}s` : null,
        travelMode: candidate.travelMode
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
            planningStatus: draft.planningStatus
        }
    };
}

function resolveRouteWaypoints(routePath) {
    const first = routePath[0];
    const last = routePath.at(-1);
    if (first.lat !== last.lat || first.lng !== last.lng) return [first, last];
    return [first, routePath[Math.floor(routePath.length / 2)]];
}

export function isRouteActivationOnly(turnResult) {
    const hasRouteMap = (turnResult?.presentations ?? []).some((item) => item?.type === "route_map");
    const activatedRouteSkill = /^plan-/.test(String(turnResult?.skill_id || ""));
    const activatedTool = (turnResult?.executions ?? []).some((item) => item?.tool === "activate_skill");
    return !hasRouteMap && (activatedRouteSkill || activatedTool);
}

function collectCandidateMetadata(rows) {
    const metadata = new Map();
    for (const row of rows) {
        if (!row || !row.candidate) continue;
        const key = String(row.candidate);
        const current = metadata.get(key) ?? {
            name: key,
            distanceKm: 0,
            durationMinutes: 0,
            provider: row.provider,
            travelMode: row.mode,
            stravaSegments: row.strava_segments,
            confirmed: row.confirmed === true
        };
        current.distanceKm += positiveNumber(row.distance_km) || 0;
        current.durationMinutes += positiveNumber(row.duration_min) || 0;
        metadata.set(key, current);
    }
    return metadata;
}

function collectSegmentMetadata(presentations) {
    const segments = new Map();
    for (const presentation of presentations) {
        if (presentation?.type !== "table") continue;
        for (const row of presentation?.data?.rows ?? []) {
            const segmentId = Number(row?.segment_id);
            if (!Number.isInteger(segmentId) || segmentId <= 0) continue;
            segments.set(segmentId, {
                segmentId,
                name: String(row.segment_name || segmentId),
                distanceKm: positiveNumber(row.distance_km),
                averageGradePercent: finiteNumber(row.average_grade_percent),
                elevationDifferenceMeters: finiteNumber(row.elevation_difference_m),
                distanceToRouteKm: positiveNumber(row.distance_to_route_km) ?? 0,
                routeOverlapRatio: finiteNumber(row.route_overlap_ratio),
                candidateIds: (Array.isArray(row.candidate_ids) ? row.candidate_ids : [])
                    .map((value) => String(value)).filter(Boolean),
            });
        }
    }
    return segments;
}

function segmentsForCandidate(segments, candidate) {
    const targetId = candidate?.parentCandidateId || candidate?.candidateId;
    return (segments ?? []).filter((segment) => (
        !segment.candidateIds?.length || segment.candidateIds.includes(targetId)
    ));
}

function normalizeCoordinates(coordinates) {
    return (Array.isArray(coordinates) ? coordinates : []).map((coordinate) => {
        const longitude = Number(coordinate?.[0]);
        const latitude = Number(coordinate?.[1]);
        return [longitude, latitude];
    }).filter(([longitude, latitude]) => (
        Number.isFinite(longitude) && Number.isFinite(latitude)
        && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
    ));
}

function joinCoordinateSegments(segments) {
    const joined = [];
    for (const coordinates of segments) {
        for (const coordinate of coordinates) {
            const previous = joined.at(-1);
            if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
                joined.push(coordinate);
            }
        }
    }
    return joined;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function virtualDurationMinutes(distanceKm, providerDurationMinutes) {
    const distance = positiveNumber(distanceKm);
    if (distance) return distance / VIRTUAL_ROUTE_SPEED_KMH * 60;
    return positiveNumber(providerDurationMinutes);
}

function stripStageSuffix(name) {
    return String(name || "").split(" · ")[0];
}

function routeDraftError(turnResult) {
    if (turnResult?.status === "llm_unavailable") {
        return "Personal FIT Agent 当前不可用，请稍后重试。";
    }
    return String(turnResult?.answer || "Agent 尚未返回可预览的路线候选，请补充起点、距离或路线偏好后重试。");
}
