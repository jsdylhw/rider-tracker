import { getRouteSampleAtDistance } from "../route/route-builder.js";

export const ROUTE_NARRATION_SCHEMA_VERSION = "route_narration_plan.v1";

export function buildRouteNarrationFingerprint(route) {
    if (!route || !Number.isFinite(route.totalDistanceMeters) || route.totalDistanceMeters <= 0) {
        return "";
    }

    const totalDistanceMeters = Math.round(route.totalDistanceMeters);
    const sampleCount = Math.min(2048, Math.max(2, Math.ceil(totalDistanceMeters / 100) + 1));
    const geometry = Array.from({ length: sampleCount }, (_, index) => {
        const distanceMeters = sampleCount === 1
            ? 0
            : (totalDistanceMeters * index) / (sampleCount - 1);
        const point = getRouteSampleAtDistance(route, distanceMeters);
        return [
            round(point.latitude, 5),
            round(point.longitude, 5),
            Math.round(distanceMeters)
        ].join(",");
    })
        .join(";");
    const identity = [
        totalDistanceMeters,
        geometry
    ].join("|");

    return `route_${fnv1a(identity)}`;
}

export function normalizeRouteNarrationPlan(plan, {
    routeFingerprint = "",
    routeTotalDistanceMeters = null
} = {}) {
    if (!plan || typeof plan !== "object") {
        throw new TypeError("route narration plan must be an object");
    }
    if (plan.schema_version !== ROUTE_NARRATION_SCHEMA_VERSION) {
        throw new TypeError(`unsupported route narration schema: ${plan.schema_version ?? "missing"}`);
    }

    const fingerprint = text(plan.route_fingerprint) || routeFingerprint;
    if (!fingerprint || (routeFingerprint && fingerprint !== routeFingerprint)) {
        throw new TypeError("route narration plan does not match the active route");
    }

    const expectedTotalDistance = Number.isFinite(routeTotalDistanceMeters)
        ? Math.max(0, routeTotalDistanceMeters)
        : nonNegativeNumber(plan.route?.total_distance_m);
    const seenIds = new Set();
    const items = (Array.isArray(plan.items) ? plan.items : [])
        .map((item, index) => normalizeItem(item, index))
        .filter((item) => {
            if (seenIds.has(item.item_id)) return false;
            seenIds.add(item.item_id);
            return true;
        })
        .sort((first, second) => first.route_distance_m - second.route_distance_m);
    const outOfRangeItem = items.find((item) => item.route_distance_m > expectedTotalDistance);
    if (outOfRangeItem) {
        throw new TypeError(`route narration item exceeds route distance: ${outOfRangeItem.item_id}`);
    }

    return Object.freeze({
        schema_version: ROUTE_NARRATION_SCHEMA_VERSION,
        plan_id: text(plan.plan_id) || `narration_${fingerprint}`,
        route_fingerprint: fingerprint,
        locale: text(plan.locale) || "zh-CN",
        status: ["ready", "partial"].includes(plan.status) ? plan.status : "ready",
        content_profile: text(plan.content_profile) || "scenic_culture",
        route: {
            name: text(plan.route?.name),
            total_distance_m: expectedTotalDistance
        },
        items: Object.freeze(items),
        warnings: Object.freeze((Array.isArray(plan.warnings) ? plan.warnings : []).map(text).filter(Boolean))
    });
}

function normalizeItem(item, index) {
    if (!item || typeof item !== "object") {
        throw new TypeError(`route narration item ${index + 1} must be an object`);
    }
    const summary = text(item.summary);
    if (!summary) {
        throw new TypeError(`route narration item ${index + 1} is missing summary`);
    }

    return Object.freeze({
        item_id: text(item.item_id) || `item_${index + 1}`,
        route_distance_m: nonNegativeNumber(item.route_distance_m),
        latitude: boundedCoordinate(item.latitude, -90, 90, "latitude", index),
        longitude: boundedCoordinate(item.longitude, -180, 180, "longitude", index),
        content_scope: ["route", "place"].includes(item.content_scope) ? item.content_scope : "place",
        category: text(item.category) || "place",
        title: text(item.title) || `沿途讲解 ${index + 1}`,
        summary,
        tts_text: text(item.tts_text) || summary,
        media: normalizeMedia(item.media),
        trigger: Object.freeze({
            lead_distance_m: nonNegativeNumber(item.trigger?.lead_distance_m, 300),
            expire_distance_m: nonNegativeNumber(item.trigger?.expire_distance_m, 500),
            minimum_gap_seconds: nonNegativeNumber(item.trigger?.minimum_gap_seconds, 75),
            priority: finiteNumber(item.trigger?.priority, 0)
        }),
        sources: Object.freeze(Array.isArray(item.sources) ? item.sources.filter((source) => source && typeof source === "object") : [])
    });
}

function normalizeMedia(media) {
    if (!media || media.type !== "google_place_photo") return null;
    const photoName = text(media.photo_name);
    if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName)) return null;
    const authorAttributions = (Array.isArray(media.author_attributions) ? media.author_attributions : [])
        .filter((item) => item && typeof item === "object")
        .map((item) => Object.freeze({
            display_name: text(item.display_name),
            uri: safeHttpUrl(item.uri),
            photo_uri: safeHttpUrl(item.photo_uri)
        }));
    return Object.freeze({
        type: "google_place_photo",
        photo_name: photoName,
        width: nonNegativeNumber(media.width),
        height: nonNegativeNumber(media.height),
        author_attributions: Object.freeze(authorAttributions),
        source_url: safeHttpUrl(media.source_url)
    });
}

function safeHttpUrl(value) {
    const normalized = text(value);
    return /^https:\/\//i.test(normalized) ? normalized : "";
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function nullableFiniteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function boundedCoordinate(value, minimum, maximum, label, index) {
    const number = nullableFiniteNumber(value);
    if (number === null) return null;
    if (number < minimum || number > maximum) {
        throw new TypeError(`route narration item ${index + 1} has invalid ${label}`);
    }
    return number;
}

function nonNegativeNumber(value, fallback = 0) {
    return Math.max(0, finiteNumber(value, fallback));
}

function round(value, digits) {
    if (!Number.isFinite(value)) return "";
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
