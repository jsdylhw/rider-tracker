export function createNarrationTimeline() {
    const MANUAL_BROWSE_HOLD_SECONDS = 10;
    let plan = null;
    let activeIndex = -1;
    let lastAutomaticAtSeconds = Number.NEGATIVE_INFINITY;
    let manualBrowseUntilSeconds = Number.NEGATIVE_INFINITY;
    let currentElapsedSeconds = 0;
    const announcedIds = new Set();

    function setPlan(nextPlan) {
        if (plan?.route_fingerprint === nextPlan?.route_fingerprint && plan?.plan_id === nextPlan?.plan_id) {
            return snapshot(0);
        }
        plan = nextPlan ?? null;
        resetProgress();
        return snapshot(0);
    }

    function update({ distanceMeters = 0, elapsedSeconds = 0 } = {}) {
        if (!plan?.items?.length) return snapshot(distanceMeters);
        currentElapsedSeconds = Math.max(0, Number(elapsedSeconds) || 0);

        if (currentElapsedSeconds < manualBrowseUntilSeconds) return snapshot(distanceMeters);

        const candidate = plan.items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => {
                if (announcedIds.has(item.item_id)) return false;
                const triggerStart = item.route_distance_m - item.trigger.lead_distance_m;
                const triggerEnd = item.route_distance_m + item.trigger.expire_distance_m;
                const gapSatisfied = elapsedSeconds - lastAutomaticAtSeconds >= item.trigger.minimum_gap_seconds;
                return distanceMeters >= triggerStart && distanceMeters <= triggerEnd && gapSatisfied;
            })
            .sort((first, second) => (
                second.item.trigger.priority - first.item.trigger.priority
                || first.item.route_distance_m - second.item.route_distance_m
            ))[0];
        const candidateIndex = candidate?.index ?? -1;

        if (candidateIndex >= 0) {
            activeIndex = candidateIndex;
            const item = plan.items[candidateIndex];
            announcedIds.add(item.item_id);
            lastAutomaticAtSeconds = elapsedSeconds;
        } else if (activeIndex < 0) {
            activeIndex = findUpcomingIndex(distanceMeters);
        }

        return snapshot(distanceMeters);
    }

    function move(delta, distanceMeters = 0) {
        if (!plan?.items?.length) return snapshot(distanceMeters);
        const startIndex = activeIndex >= 0 ? activeIndex : findUpcomingIndex(distanceMeters);
        activeIndex = Math.max(0, Math.min(plan.items.length - 1, startIndex + delta));
        manualBrowseUntilSeconds = currentElapsedSeconds + MANUAL_BROWSE_HOLD_SECONDS;
        return snapshot(distanceMeters);
    }

    function reset() {
        plan = null;
        resetProgress();
    }

    function resetProgress() {
        activeIndex = -1;
        lastAutomaticAtSeconds = Number.NEGATIVE_INFINITY;
        manualBrowseUntilSeconds = Number.NEGATIVE_INFINITY;
        currentElapsedSeconds = 0;
        announcedIds.clear();
    }

    function findUpcomingIndex(distanceMeters) {
        const index = plan.items.findIndex((item) => item.route_distance_m >= distanceMeters);
        return index >= 0 ? index : plan.items.length - 1;
    }

    function snapshot(distanceMeters) {
        const item = activeIndex >= 0 ? plan?.items?.[activeIndex] ?? null : null;
        return {
            plan,
            item,
            itemIndex: activeIndex,
            itemCount: plan?.items?.length ?? 0,
            distanceToItemMeters: item ? item.route_distance_m - distanceMeters : null,
            canMovePrevious: activeIndex > 0,
            canMoveNext: activeIndex >= 0 && activeIndex < (plan?.items?.length ?? 0) - 1,
            isAnnounced: item ? announcedIds.has(item.item_id) : false
        };
    }

    return {
        setPlan,
        update,
        previous: (distanceMeters) => move(-1, distanceMeters),
        next: (distanceMeters) => move(1, distanceMeters),
        reset
    };
}
