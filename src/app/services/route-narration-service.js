import {
    buildRouteNarrationFingerprint,
    normalizeRouteNarrationPlan
} from "../../domain/narration/narration-plan.js";
import { createNarrationTimeline } from "../../domain/narration/narration-timeline.js";

/** Ride-session consent and cache for route narration. */
export function createRouteNarrationService({ preparePlan, refreshHint, buildHintSnapshot, onChange = () => {}, now = Date.now, hintTimeoutMs = 10_000 } = {}) {
    if (typeof preparePlan !== "function") {
        throw new TypeError("route narration preparePlan provider is required");
    }

    const cache = new Map();
    const hints = new Map();
    const consumed = new Set();
    let liveContext = null;
    let contextRevision = "";
    let generation = 0;
    let pending = null;
    function invalidateHint() {
        generation += 1;
        pending?.controller.abort();
        if (pending) clearTimeout(pending.timer);
        pending = null;
    }

    let activeRoute = null;
    let activeFingerprint = "";
    let viewStatus = "idle";
    let currentDistanceMeters = 0;
    let currentElapsedSeconds = 0;

    function enter(route) {
        invalidateHint();
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
        invalidateHint();
        activeRoute = null;
        activeFingerprint = "";
        viewStatus = "idle";
        return getState();
    }

    function dismiss() {
        invalidateHint();
        viewStatus = "closed";
        return getState();
    }

    async function load(route = activeRoute, { force = false } = {}) {
        const fingerprint = buildRouteNarrationFingerprint(route);
        if (!fingerprint) return enter(route);
        if (fingerprint !== activeFingerprint) enter(route);

        if (force) invalidateHint();
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
            .then(() => preparePlan(route, { routeFingerprint: fingerprint, force }))
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

    function update({ distanceMeters = 0, elapsedSeconds = 0, rideContext = null } = {}) {
        const wasActive = liveContext?.active;
        liveContext = rideContext;
        if (wasActive && !rideContext?.active) invalidateHint();
        const revision = rideContext?.revision ?? "";
        if (revision !== contextRevision) {
            invalidateHint();
            hints.clear();
            contextRevision = revision;
        }
        currentDistanceMeters = Math.max(0, Number(distanceMeters) || 0);
        currentElapsedSeconds = Math.max(0, Number(elapsedSeconds) || 0);
        return getState();
    }

    function previous() {
        invalidateHint();
        cache.get(activeFingerprint)?.timeline?.previous(currentDistanceMeters);
        return getState();
    }

    function next() {
        invalidateHint();
        cache.get(activeFingerprint)?.timeline?.next(currentDistanceMeters);
        return getState();
    }

    function clear() {
        invalidateHint();
        hints.clear();
        consumed.clear();
        liveContext = null;
        contextRevision = "";
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
        if (entry) entry.timelineState = timelineState;
        maybeRefreshHint(timelineState);
        const key = hintKey(timelineState);
        const hint = hints.get(key);
        const inRange = timelineState.item && currentDistanceMeters >= timelineState.item.route_distance_m - timelineState.item.trigger.lead_distance_m
            && currentDistanceMeters <= timelineState.item.route_distance_m + timelineState.item.trigger.expire_distance_m;
        const freshHint = inRange && hint && now() - hint.captured_at_ms <= hint.valid_for_s * 1000 && currentElapsedSeconds - hint.elapsed_s <= hint.valid_for_s
            && currentElapsedSeconds >= hint.elapsed_s ? hint : null;
        return {
            rideHint: viewStatus === "ready" && liveContext?.active ? freshHint : null,
            hintLoading: pending?.key === key,
            routeFingerprint: activeFingerprint,
            status: viewStatus,
            error: entry?.error ?? null,
            cached: Boolean(entry),
            ...timelineState
        };
    }

    function hintKey(state) {
        return [liveContext?.sessionId, activeFingerprint, state.plan?.plan_id, state.item?.item_id, contextRevision].join(":");
    }

    function maybeRefreshHint(state) {
        const trigger = state.automaticTrigger;
        if (viewStatus !== "ready" || !liveContext?.active || !trigger || !refreshHint || !buildHintSnapshot) return;
        const triggerKey = [liveContext.sessionId, activeFingerprint, state.plan?.plan_id, trigger.sequence].join(":");
        if (consumed.has(triggerKey)) return;
        consumed.add(triggerKey);
        if (trigger.itemId !== state.item?.item_id) return;
        if (pending) invalidateHint();
        const item = state.item;
        if (currentDistanceMeters < item.route_distance_m - item.trigger.lead_distance_m
            || currentDistanceMeters > item.route_distance_m + item.trigger.expire_distance_m) return;
        let snapshot;
        try { snapshot = buildHintSnapshot({ item }); } catch { return; }
        if (!snapshot) return;
        const key = hintKey(state);
        if (hints.has(key)) return;
        const request = { schema_version: "route_narration_ride_hint.v1", session_id: String(liveContext.sessionId),
            route_fingerprint: activeFingerprint, plan_id: state.plan.plan_id, item_id: item.item_id,
            context_revision: contextRevision, snapshot };
        const controller = new AbortController();
        const token = ++generation;
        const entry = { key, controller, timer: null };
        pending = entry;
        entry.timer = setTimeout(() => {
            if (pending !== entry) return;
            invalidateHint();
            onChange();
        }, hintTimeoutMs);
        Promise.resolve().then(() => refreshHint(request, { signal: controller.signal })).then((result) => {
            if (pending !== entry || generation !== token || viewStatus !== "ready" || !liveContext?.active) return;
            // Re-check the currently displayed item without advancing the timeline.
            if (hintKey(state) !== key || cache.get(activeFingerprint)?.timelineState?.item?.item_id !== item.item_id) return;
            if (["schema_version", "session_id", "route_fingerprint", "plan_id", "item_id", "context_revision"]
                .some((field) => result?.[field] !== request[field])) return;
            if (currentDistanceMeters < item.route_distance_m - item.trigger.lead_distance_m
                || currentDistanceMeters > item.route_distance_m + item.trigger.expire_distance_m) return;
            if (result.status === "ready" && typeof result.text === "string") {
                hints.set(key, { ...result, elapsed_s: snapshot.elapsed_s, captured_at_ms: snapshot.captured_at_ms,
                    valid_for_s: Math.min(90, Math.max(0, Number(result.valid_for_s) || 0)) });
            }
        }).catch(() => {}).finally(() => {
            clearTimeout(entry.timer);
            if (pending === entry) { pending = null; onChange(); }
        });
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
