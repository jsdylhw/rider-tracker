export const MAP_PROVIDERS = {
    osm: {
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; OpenStreetMap'
    }
};

export function createMapController({ previewElement, dashboardElement }) {
    let latestRoute = null;
    let latestDashboardRecord = null;
    
    function createMap(element, options) {
        if (!element) {
            return null;
        }
        if (!window.L) {
            renderMapUnavailable(element);
            return null;
        }

        const map = window.L.map(element, {
            zoomSnap: 0.25,
            attributionControl: true,
            ...options
        });

        const provider = MAP_PROVIDERS.osm;
        const tileLayer = window.L.tileLayer(provider.url, {
            maxZoom: 19,
            attribution: provider.attribution
        }).addTo(map);

        map.setView([31.2304, 121.4737], 10);

        return { map, tileLayer };
    }

    const previewData = createMap(previewElement, { zoomControl: false });
    const dashboardData = createMap(dashboardElement, { zoomControl: true });

    const previewMap = previewData?.map;
    const dashboardMap = dashboardData?.map;

    const previewLayers = createLayerSet(previewMap);
    const dashboardLayers = createLayerSet(dashboardMap);
    let plannerClickHandler = null;
    let plannerMode = null;

    if (previewMap) {
        previewMap.on("click", (event) => {
            if (!plannerClickHandler || !plannerMode) {
                return;
            }
            plannerClickHandler({
                mode: plannerMode,
                point: {
                    lat: event.latlng.lat,
                    lng: event.latlng.lng
                }
            });
        });
    }

    function syncRoute(route) {
        latestRoute = route;
        renderRoute(previewMap, previewLayers, route, null);
        renderRoute(dashboardMap, dashboardLayers, route, latestDashboardRecord, {
            preserveCurrentPosition: Boolean(latestDashboardRecord)
        });
    }

    function syncRide(route, currentRecord) {
        latestRoute = route;
        latestDashboardRecord = currentRecord ?? null;
        renderRoute(dashboardMap, dashboardLayers, route, currentRecord);
    }

    function setPlannerClickHandler(handler) {
        plannerClickHandler = handler;
    }

    function setPlannerMode(mode) {
        plannerMode = ["start", "destination", "select"].includes(mode) ? mode : null;
        if (previewMap?._container) {
            previewMap._container.style.cursor = plannerMode ? "crosshair" : "";
        }
    }

    function syncPlannerSelection(selection) {
        renderPlannerSelection(previewMap, previewLayers, selection);
    }

    function invalidatePreviewSize() {
        refreshMapAfterVisibility(previewMap, previewLayers, latestRoute);
    }

    function invalidateDashboardSize() {
        refreshMapAfterVisibility(dashboardMap, dashboardLayers, latestRoute, latestDashboardRecord);
    }

    return {
        syncRoute,
        syncRide,
        setPlannerClickHandler,
        setPlannerMode,
        syncPlannerSelection,
        invalidatePreviewSize,
        invalidateDashboardSize,
        isReady: Boolean(window.L)
    };
}

function renderMapUnavailable(element) {
    if (element.dataset?.mapUnavailable === "true") return;
    if (element.dataset) element.dataset.mapUnavailable = "true";
    element.classList?.add("map-unavailable");
    element.innerHTML = `
        <div class="map-unavailable-message" role="status">
            <strong>地图组件加载失败</strong>
            <span>请检查网络或代理设置后刷新页面。</span>
        </div>
    `;
}

function refreshMapAfterVisibility(map, layers, route, currentRecord = null) {
    if (!map || !layers) {
        return;
    }

    map.invalidateSize({ pan: false });
    // A route may have arrived while this map was inside a hidden route tab or dashboard.
    // Refit only after the container becomes measurable.
    if (route) {
        renderRoute(map, layers, route, currentRecord, { forceFocus: true });
    }
}

function createLayerSet(map) {
    if (!map || !window.L) {
        return null;
    }

    const layers = {
        routeLine: window.L.polyline([], {
            color: "#0ea5e9",
            weight: 5,
            opacity: 0.95,
            interactive: false
        }).addTo(map),
        riddenLine: window.L.polyline([], {
            color: "#2ed573",
            weight: 6,
            opacity: 0.95
        }).addTo(map),
        currentMarker: window.L.circleMarker([0, 0], {
            radius: 8,
            color: "#ffffff",
            weight: 3,
            fillColor: "#3742fa",
            fillOpacity: 1
        }).addTo(map),
        startMarker: window.L.circleMarker([0, 0], {
            radius: 6,
            color: "#ffffff",
            weight: 2,
            fillColor: "#2ed573",
            fillOpacity: 1
        }).addTo(map),
        endMarker: window.L.circleMarker([0, 0], {
            radius: 6,
            color: "#ffffff",
            weight: 2,
            fillColor: "#ff4757",
            fillOpacity: 1
        }).addTo(map),
        plannerStartMarker: window.L.circleMarker([0, 0], {
            radius: 10,
            color: "#ffffff",
            weight: 3,
            fillColor: "#22c55e",
            opacity: 0,
            fillOpacity: 0
        }).addTo(map),
        plannerDestinationMarker: window.L.circleMarker([0, 0], {
            radius: 10,
            color: "#ffffff",
            weight: 3,
            fillColor: "#ef4444",
            opacity: 0,
            fillOpacity: 0
        }).addTo(map),
        plannerGuideLine: window.L.polyline([], {
            color: "#64748b",
            weight: 3,
            opacity: 0.85,
            dashArray: "8 10"
        }).addTo(map),
        plannerWaypointMarkers: [],
        agentSegmentLines: [],
        requestedWaypointLinks: [],
        requestedWaypointMarkers: [],
        routeLineOpacity: 0.95,
        hasVisibleRoute: false,
        lastRouteKey: ""
    };

    layers.plannerStartMarker.bindTooltip?.("起点", {
        direction: "top",
        offset: [0, -10],
        opacity: 0.95
    });
    layers.plannerDestinationMarker.bindTooltip?.("起步目标", {
        direction: "top",
        offset: [0, -10],
        opacity: 0.95
    });

    return layers;
}

function renderRoute(map, layers, route, currentRecord, {
    forceFocus = false,
    preserveCurrentPosition = false
} = {}) {
    if (!map || !layers) {
        return;
    }

    const geoPoints = collectRouteMapLatLngs(route);
    const routeKey = buildRouteGeometryKey(route, geoPoints);
    renderAgentSegmentOverlays(map, layers, route?.agentSegmentOverlays);

    if (geoPoints.length < 2) {
        layers.routeLine.setLatLngs([]);
        layers.riddenLine.setLatLngs([]);
        layers.currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.startMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.endMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        clearRequestedWaypointSnaps(layers);
        layers.hasVisibleRoute = false;
        layers.lastRouteKey = "";
        return;
    }

    const routeLineStyle = resolveRouteLineStyle(route);
    layers.routeLineOpacity = routeLineStyle.opacity;
    const routeChanged = layers.lastRouteKey !== routeKey;
    const shouldRenderStaticRoute = routeChanged || forceFocus || !layers.hasVisibleRoute;
    if (shouldRenderStaticRoute) {
        map.invalidateSize({ pan: false });
        layers.routeLine.setStyle(routeLineStyle);
        layers.routeLine.setLatLngs(geoPoints);
        layers.routeLine.bringToFront?.();
        layers.startMarker.setLatLng(geoPoints[0]).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
        layers.endMarker.setLatLng(geoPoints.at(-1)).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
        renderRequestedWaypointSnaps(map, layers, route);
        layers.hasVisibleRoute = true;
        layers.lastRouteKey = routeKey;
        focusRouteAfterLayout(map, layers, geoPoints, routeKey);
    }

    if (preserveCurrentPosition) {
        return;
    }

    if (!currentRecord || typeof currentRecord.positionLat !== "number" || typeof currentRecord.positionLong !== "number") {
        layers.riddenLine.setLatLngs([]);
        layers.currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        return;
    }

    const currentLatLng = [currentRecord.positionLat, currentRecord.positionLong];
    const riddenPoints = buildRiddenPoints(route, currentRecord.distanceKm * 1000, currentLatLng);

    layers.riddenLine.setLatLngs(riddenPoints);
    layers.riddenLine.bringToFront?.();
    layers.currentMarker.setLatLng(currentLatLng).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
    map.panTo(currentLatLng, { animate: true, duration: 0.5 });
}

function renderAgentSegmentOverlays(map, layers, overlays) {
    for (const line of layers.agentSegmentLines ?? []) map.removeLayer?.(line);
    layers.agentSegmentLines = [];
    for (const overlay of overlays ?? []) {
        const points = (overlay?.coordinates ?? []).map((coordinate) => [
            Number(coordinate?.[1]), Number(coordinate?.[0]),
        ]).filter(([latitude, longitude]) => (
            Number.isFinite(latitude) && Number.isFinite(longitude)
        ));
        if (points.length < 2) continue;
        const line = window.L.polyline(points, {
            color: "#fc7f3f",
            weight: 5,
            opacity: 0.8,
            dashArray: "8 6",
        }).addTo(map);
        const label = document.createElement("span");
        label.textContent = `Strava · ${overlay.name || overlay.segmentId}`;
        line.bindTooltip?.(label, { sticky: true });
        line.bringToFront?.();
        layers.agentSegmentLines.push(line);
    }
    layers.routeLine.bringToFront?.();
}

function renderRequestedWaypointSnaps(map, layers, route) {
    clearRequestedWaypointSnaps(layers);
    if (route?.source !== "map-drawn") return;

    for (const snap of route.waypointSnaps ?? []) {
        const requested = normalizeSnapPoint(snap?.requested);
        const snapped = normalizeSnapPoint(snap?.snapped);
        const offsetMeters = Number(snap?.offsetMeters);
        if (!requested || !snapped || !Number.isFinite(offsetMeters) || offsetMeters < 3) continue;

        const link = window.L.polyline([requested, snapped], {
            color: "#f59e0b",
            weight: 2,
            opacity: 0.85,
            dashArray: "5 7"
        }).addTo(map);
        const marker = window.L.circleMarker(requested, {
            radius: 7,
            color: "#f59e0b",
            weight: 3,
            fillColor: "#ffffff",
            fillOpacity: 0.95
        }).addTo(map);
        const label = snap.index === 1 ? "原始起点" : `原始选点 ${snap.index}`;
        marker.bindTooltip?.(`${label}，已吸附至道路（${Math.round(offsetMeters)} m）`, {
            direction: "top",
            offset: [0, -8],
            opacity: 0.95
        });
        link.bringToFront?.();
        marker.bringToFront?.();
        layers.requestedWaypointLinks.push(link);
        layers.requestedWaypointMarkers.push(marker);
    }
}

function clearRequestedWaypointSnaps(layers) {
    for (const layer of [...(layers?.requestedWaypointLinks ?? []), ...(layers?.requestedWaypointMarkers ?? [])]) {
        layer.remove?.();
    }
    if (!layers) return;
    layers.requestedWaypointLinks = [];
    layers.requestedWaypointMarkers = [];
}

function normalizeSnapPoint(point) {
    const lat = Number(point?.lat ?? point?.latitude);
    const lng = Number(point?.lng ?? point?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

function focusRouteAfterLayout(map, layers, geoPoints, routeKey) {
    scheduleAfterLayout(() => {
        if (layers.lastRouteKey !== routeKey) {
            return;
        }
        map.invalidateSize({ pan: false });
        map.fitBounds(window.L.latLngBounds(geoPoints), {
            padding: [24, 24]
        });
        layers.routeLine?.bringToFront?.();
        layers.riddenLine.bringToFront?.();
        layers.startMarker.bringToFront?.();
        layers.endMarker.bringToFront?.();
        layers.currentMarker.bringToFront?.();
    });
}

function scheduleAfterLayout(callback) {
    if (typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(callback);
        return;
    }
    queueMicrotask(callback);
}

export function collectRouteMapLatLngs(route) {
    const mapGeometry = normalizeRouteMapLatLngs(route?.mapGeometry);
    return mapGeometry.length >= 2
        ? mapGeometry
        : normalizeRouteMapLatLngs(route?.points);
}

function normalizeRouteMapLatLngs(geometry) {
    return (geometry ?? [])
        .map((point) => {
            const latitude = point?.latitude ?? point?.lat;
            const longitude = point?.longitude ?? point?.lng;
            return Number.isFinite(latitude) && Number.isFinite(longitude)
                ? [latitude, longitude]
                : null;
        })
        .filter(Boolean);
}

export function buildRouteGeometryKey(route, geoPoints) {
    let hash = 2166136261;

    for (const [latitude, longitude] of geoPoints) {
        const coordinate = `${latitude.toFixed(6)},${longitude.toFixed(6)};`;
        for (let index = 0; index < coordinate.length; index += 1) {
            hash ^= coordinate.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
    }

    return `${route?.source ?? "unknown"}:${geoPoints.length}:${(hash >>> 0).toString(36)}`;
}

function renderPlannerSelection(map, layers, selection) {
    if (!map || !layers) {
        return;
    }

    const waypointPoints = normalizePlannerPoints(selection?.waypoints);
    if (waypointPoints.length > 0) {
        setOptionalMarker(layers.plannerStartMarker, null);
        setOptionalMarker(layers.plannerDestinationMarker, null);
        renderPlannerWaypointMarkers(map, layers, waypointPoints);
        layers.plannerGuideLine.setLatLngs(waypointPoints);
        // Keep the user's current viewport stable while they add multiple waypoints.
        // The finished route is fitted once it is committed through syncRoute().
        return;
    }

    clearPlannerWaypointMarkers(layers);

    setOptionalMarker(layers.plannerStartMarker, selection?.start);
    setOptionalMarker(layers.plannerDestinationMarker, selection?.destination);

    const points = [selection?.start, selection?.destination]
        .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
        .map((point) => [point.lat, point.lng]);

    const shouldFitSelection = shouldFitPlannerSelection(layers, points.length);
    layers.plannerGuideLine.setLatLngs(shouldFitSelection ? points : []);

    if (shouldFitSelection) {
        map.fitBounds(window.L.latLngBounds(points), {
            padding: [32, 32]
        });
    }
}

function normalizePlannerPoints(points) {
    return (points ?? [])
        .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
        .map((point) => [point.lat, point.lng]);
}

function renderPlannerWaypointMarkers(map, layers, points) {
    clearPlannerWaypointMarkers(layers);
    layers.plannerWaypointMarkers = points.map((point, index) => {
        const marker = window.L.circleMarker(point, {
            radius: 8,
            color: "#ffffff",
            weight: 2,
            fillColor: index === 0 ? "#22c55e" : "#2563eb",
            fillOpacity: 1
        }).addTo(map);
        const label = index === 0 ? "起点 1" : `途经点 ${index + 1}`;
        marker.bindTooltip?.(label, {
            direction: "top",
            offset: [0, -8],
            opacity: 0.95
        });
        return marker;
    });
}

function clearPlannerWaypointMarkers(layers) {
    for (const marker of layers?.plannerWaypointMarkers ?? []) {
        marker.remove?.();
    }
    if (layers) layers.plannerWaypointMarkers = [];
}

export function shouldFitPlannerSelection(layers, pointCount) {
    return pointCount >= 2 && layers?.hasVisibleRoute !== true;
}

function resolveRouteLineStyle(route) {
    if (route?.networkSource === "synthetic") {
        return {
            color: "#f97316",
            weight: 7,
            opacity: 0.96
        };
    }

    if (route?.source === "osm-map" || route?.source === "osm-exploration" || route?.source === "map-drawn") {
        return {
            color: "#2563eb",
            weight: 7,
            opacity: 0.96
        };
    }

    return {
        color: "#0ea5e9",
        weight: 5,
        opacity: 0.95
    };
}

function setOptionalMarker(marker, point) {
    if (!marker) {
        return;
    }

    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        marker.setStyle({ opacity: 0, fillOpacity: 0 });
        marker.closeTooltip?.();
        return;
    }

    marker.setLatLng([point.lat, point.lng]).setStyle({ opacity: 1, fillOpacity: 1 });
    marker.openTooltip?.();
}

function buildRiddenPoints(route, distanceMeters, currentLatLng) {
    const points = (route?.points ?? [])
        .filter((point) => typeof point.latitude === "number" && typeof point.longitude === "number" && point.distanceMeters <= distanceMeters)
        .map((point) => [point.latitude, point.longitude]);

    if (points.length === 0) {
        return [currentLatLng];
    }

    const lastPoint = points.at(-1);

    if (lastPoint[0] !== currentLatLng[0] || lastPoint[1] !== currentLatLng[1]) {
        points.push(currentLatLng);
    }

    return points;
}
