const SCHEMA_VERSION = "route_plan_view.v1";
const VIRTUAL_ROUTE_SPEED_KMH = 25;

/** Validate and translate the Python route domain view into Rider UI state. */
export function parseRoutePlanView(view, { answer = "" } = {}) {
    if (view?.schema_version !== SCHEMA_VERSION) throw new Error("路线数据版本不受支持。");
    const planId = text(view.plan_id);
    const revision = positiveInteger(view.revision);
    if (!planId || !revision) throw new Error("路线数据缺少 plan_id 或 revision。");
    const candidates = (Array.isArray(view.candidates) ? view.candidates : [])
        .map((candidate) => parseCandidate(candidate, view)).filter(Boolean);
    if (candidates.length === 0) throw new Error("路线计划没有可用候选。");
    return {
        planId,
        revision,
        countryCode: text(view.country_code) || null,
        answer: String(answer || ""),
        planningStatus: text(view.planning_status) || "awaiting_selection",
        activeCandidateId: text(view.active_candidate_id) || candidates[0].candidateId,
        confirmedCandidateId: text(view.confirmed_candidate_id) || null,
        candidates,
        segments: (Array.isArray(view.segments) ? view.segments : []).map(parseSegment).filter(Boolean)
    };
}

function parseCandidate(candidate, view) {
    const candidateId = text(candidate?.candidate_id);
    const direct = normalizeCoordinates(candidate?.geometry?.coordinates);
    const staged = joinCoordinateSegments((candidate?.stages ?? []).map(
        (stage) => normalizeCoordinates(stage?.geometry?.coordinates)
    ));
    const coordinates = direct.length >= 2 ? direct : staged;
    if (!candidateId || coordinates.length < 2) return null;
    const distanceKm = positiveNumber(candidate.distance_m) / 1000 || null;
    const providerMinutes = positiveNumber(candidate.provider_duration_s) / 60 || null;
    return {
        candidateId,
        parentCandidateId: text(candidate.parent_candidate_id) || null,
        name: text(candidate.name) || `路线候选 ${candidateId}`,
        distanceKm,
        durationMinutes: distanceKm ? distanceKm / VIRTUAL_ROUTE_SPEED_KMH * 60 : providerMinutes,
        provider: text(candidate.provider) || "Personal FIT Agent",
        travelMode: text(candidate.travel_mode) || "BICYCLE",
        stravaSegments: (candidate.segment_sequence ?? []).map((item) => item?.segment_id).filter(Boolean).join(", "),
        confirmed: text(view.confirmed_candidate_id) === candidateId,
        active: text(view.active_candidate_id) === candidateId,
        coordinates,
        waypoints: (candidate.waypoints ?? []).map((point) => ({
            lat: finiteNumber(point?.latitude), lng: finiteNumber(point?.longitude)
        })).filter((point) => point.lat !== null && point.lng !== null)
    };
}

function parseSegment(segment) {
    const segmentId = positiveInteger(segment?.segment_id);
    if (!segmentId) return null;
    return {
        segmentId,
        name: text(segment.name) || String(segmentId),
        distanceKm: positiveNumber(segment.distance_m) / 1000 || null,
        averageGradePercent: finiteNumber(segment.average_grade_percent),
        elevationDifferenceMeters: finiteNumber(segment.elevation_difference_m),
        distanceToRouteKm: positiveNumber(segment.distance_to_route_m) / 1000 || 0,
        routeOverlapRatio: finiteNumber(segment.route_overlap_ratio),
        candidateIds: (segment.candidate_ids ?? []).map(text).filter(Boolean),
        coordinates: normalizeCoordinates(segment?.geometry?.coordinates)
    };
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
            if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) joined.push(coordinate);
        }
    }
    return joined;
}

function text(value) { return String(value ?? "").trim(); }
function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}
function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}
function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
