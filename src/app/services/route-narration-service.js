import {
    buildRouteNarrationFingerprint,
    normalizeRouteNarrationPlan
} from "../../domain/narration/narration-plan.js";
import { createNarrationTimeline } from "../../domain/narration/narration-timeline.js";

/** Ride-session consent and cache for route narration. */
export function createRouteNarrationService({ preparePlan } = {}) {
    if (typeof preparePlan !== "function") {
        throw new TypeError("route narration preparePlan provider is required");
    }

    const cache = new Map();
    let activeRoute = null;
    let activeFingerprint = "";
    let viewStatus = "idle";
    let currentDistanceMeters = 0;
    let currentElapsedSeconds = 0;

    function enter(route) {
        const fingerprint = buildRouteNarrationFingerprint(route);
        activeRoute = route ?? null;
        activeFingerprint = fingerprint;
        if (!fingerprint) {
            viewStatus = "idle";
            return getState();
        }
        viewStatus = cache.get(fingerprint)?.status ?? "prompt";
        return getState();
    }

    function leave() {
        activeRoute = null;
        activeFingerprint = "";
        viewStatus = "idle";
        return getState();
    }

    function dismiss() {
        viewStatus = "closed";
        return getState();
    }

    async function load(route = activeRoute, { force = false } = {}) {
        const fingerprint = buildRouteNarrationFingerprint(route);
        if (!fingerprint) return enter(route);
        if (fingerprint !== activeFingerprint) enter(route);

        const existing = cache.get(fingerprint);
        if (!force && existing?.status === "ready") {
            viewStatus = "ready";
            return getState();
        }
        if (!force && existing?.status === "loading" && existing.promise) {
            viewStatus = "loading";
            return existing.promise;
        }

        const entry = {
            status: "loading",
            error: null,
            timeline: createNarrationTimeline(),
            promise: null
        };
        cache.set(fingerprint, entry);
        viewStatus = "loading";

        entry.promise = Promise.resolve()
            .then(() => preparePlan(route, { routeFingerprint: fingerprint }))
            .then((preparedPlan) => {
                if (cache.get(fingerprint) !== entry) return getState();
                const plan = normalizeRouteNarrationPlan(preparedPlan, {
                    routeFingerprint: fingerprint,
                    routeTotalDistanceMeters: route.totalDistanceMeters
                });
                entry.status = "ready";
                entry.promise = null;
                entry.timeline.setPlan(plan);
                if (activeFingerprint === fingerprint && viewStatus !== "closed") viewStatus = "ready";
                return getState();
            })
            .catch((cause) => {
                if (cache.get(fingerprint) !== entry) return getState();
                entry.status = "failed";
                entry.error = cause instanceof Error ? cause.message : String(cause);
                entry.promise = null;
                if (activeFingerprint === fingerprint && viewStatus !== "closed") viewStatus = "failed";
                return getState();
            });
        return entry.promise;
    }

    function update({ distanceMeters = 0, elapsedSeconds = 0 } = {}) {
        currentDistanceMeters = Math.max(0, Number(distanceMeters) || 0);
        currentElapsedSeconds = Math.max(0, Number(elapsedSeconds) || 0);
        return getState();
    }

    function previous() {
        cache.get(activeFingerprint)?.timeline?.previous(currentDistanceMeters);
        return getState();
    }

    function next() {
        cache.get(activeFingerprint)?.timeline?.next(currentDistanceMeters);
        return getState();
    }

    function clear() {
        cache.clear();
        activeRoute = null;
        activeFingerprint = "";
        viewStatus = "idle";
        currentDistanceMeters = 0;
        currentElapsedSeconds = 0;
        return getState();
    }

    function getState() {
        const entry = cache.get(activeFingerprint);
        const timelineState = entry?.timeline?.update({
            distanceMeters: currentDistanceMeters,
            elapsedSeconds: currentElapsedSeconds
        }) ?? emptyTimelineState();
        return {
            routeFingerprint: activeFingerprint,
            status: viewStatus,
            error: entry?.error ?? null,
            cached: Boolean(entry),
            ...timelineState
        };
    }

    return {
        enter,
        leave,
        dismiss,
        load,
        retry: (route = activeRoute) => load(route, { force: true }),
        update,
        previous,
        next,
        clear,
        reset: clear,
        getState
    };
}

function emptyTimelineState() {
    return {
        plan: null,
        item: null,
        itemIndex: -1,
        itemCount: 0,
        distanceToItemMeters: null,
        canMovePrevious: false,
        canMoveNext: false,
        isAnnounced: false
    };
}
