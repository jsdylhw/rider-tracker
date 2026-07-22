const DEFAULT_MAP_UPDATE_INTERVAL_MS = 1000;
const DEFAULT_IMMERSIVE_MAP_UPDATE_INTERVAL_MS = 1000;
const DEFAULT_STREET_VIEW_UPDATE_INTERVAL_MS = 500;

export function createRideVisualSyncController({
    visuals,
    isStreetViewLoaded,
    mapUpdateIntervalMs = DEFAULT_MAP_UPDATE_INTERVAL_MS,
    immersiveMapUpdateIntervalMs = DEFAULT_IMMERSIVE_MAP_UPDATE_INTERVAL_MS,
    streetViewUpdateIntervalMs = DEFAULT_STREET_VIEW_UPDATE_INTERVAL_MS
}) {
    const mapSlot = createVisualRenderSlot();
    const streetViewSlot = createVisualRenderSlot();

    function reset() {
        [mapSlot, streetViewSlot].forEach(resetVisualRenderSlot);
    }

    function sync({ route, currentRecord, immersive, now, force = false }) {
        const distanceMeters = Math.round((currentRecord?.distanceKm ?? 0) * 1000);
        const positionSignature = `${buildRouteSignature(route)}:${distanceMeters}`;
        const shouldSyncMap = shouldRenderVisual(
            mapSlot,
            positionSignature,
            now,
            immersive ? immersiveMapUpdateIntervalMs : mapUpdateIntervalMs,
            force
        );
        const shouldSyncStreetView = isStreetViewLoaded()
            && shouldRenderVisual(streetViewSlot, positionSignature, now, streetViewUpdateIntervalMs, force);

        if (shouldSyncMap) visuals.syncMap(route, currentRecord);
        if (shouldSyncStreetView) visuals.syncStreetView(route, currentRecord);
    }

    return { reset, sync };
}

function createVisualRenderSlot() {
    return { lastRenderedAt: 0, lastSignature: "" };
}

function resetVisualRenderSlot(slot) {
    slot.lastRenderedAt = 0;
    slot.lastSignature = "";
}

function shouldRenderVisual(slot, signature, now, intervalMs, force) {
    if (force || slot.lastRenderedAt === 0) {
        slot.lastRenderedAt = now;
        slot.lastSignature = signature;
        return true;
    }
    if (signature === slot.lastSignature || now - slot.lastRenderedAt < intervalMs) {
        return false;
    }
    slot.lastRenderedAt = now;
    slot.lastSignature = signature;
    return true;
}

function buildRouteSignature(route) {
    if (!route) return "no-route";
    return [
        route.source ?? "unknown",
        route.name ?? "route",
        route.totalDistanceMeters ?? 0,
        route.points?.length ?? 0
    ].join(":");
}
