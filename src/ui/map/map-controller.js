export const MAP_PROVIDERS = {
    osm: {
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; OpenStreetMap'
    },
    amap: {
        url: "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
        attribution: '&copy; 高德地图'
    },
    amap_satellite: {
        url: "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
        attribution: '&copy; 高德卫星'
    }
};

export function createMapController({ previewElement, dashboardElement, initialProviderKey = "amap" }) {
    let currentProviderKey = MAP_PROVIDERS[initialProviderKey] ? initialProviderKey : "amap";
    let latestRoute = null;
    
    // Store tile layers references so we can update them later
    let previewTileLayer = null;
    let dashboardTileLayer = null;

    function createMap(element, options) {
        if (!element || !window.L) {
            return null;
        }

        const map = window.L.map(element, {
            zoomSnap: 0.25,
            attributionControl: true,
            ...options
        });

        const provider = MAP_PROVIDERS[currentProviderKey];
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
    previewTileLayer = previewData?.tileLayer;
    
    const dashboardMap = dashboardData?.map;
    dashboardTileLayer = dashboardData?.tileLayer;

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

    function setMapProvider(providerKey) {
        if (!MAP_PROVIDERS[providerKey] || providerKey === currentProviderKey) {
            return;
        }
        currentProviderKey = providerKey;
        const provider = MAP_PROVIDERS[currentProviderKey];

        if (previewTileLayer) {
            previewTileLayer.setUrl(provider.url);
            previewMap.attributionControl.removeAttribution(previewTileLayer.options.attribution);
            previewTileLayer.options.attribution = provider.attribution;
            previewMap.attributionControl.addAttribution(provider.attribution);
        }
        if (dashboardTileLayer) {
            dashboardTileLayer.setUrl(provider.url);
            dashboardMap.attributionControl.removeAttribution(dashboardTileLayer.options.attribution);
            dashboardTileLayer.options.attribution = provider.attribution;
            dashboardMap.attributionControl.addAttribution(provider.attribution);
        }
    }

    function syncRoute(route) {
        latestRoute = route;
        renderRoute(previewMap, previewLayers, route, null);
        renderRoute(dashboardMap, dashboardLayers, route, null);
    }

    function syncRide(route, currentRecord) {
        latestRoute = route;
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
        refreshMapAfterVisibility(dashboardMap, dashboardLayers, latestRoute);
    }

    return {
        syncRoute,
        syncRide,
        setMapProvider,
        setPlannerClickHandler,
        setPlannerMode,
        syncPlannerSelection,
        invalidatePreviewSize,
        invalidateDashboardSize,
        isReady: Boolean(window.L)
    };
}

function refreshMapAfterVisibility(map, layers, route) {
    if (!map || !layers) {
        return;
    }

    map.invalidateSize({ pan: false });
    // A route may have arrived while this map was inside a hidden route tab or dashboard.
    // Refit only after the container becomes measurable.
    if (route) {
        renderRoute(map, layers, route, null, { forceFocus: true });
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

function renderRoute(map, layers, route, currentRecord, { forceFocus = false } = {}) {
    if (!map || !layers) {
        return;
    }

    const geoPoints = collectRouteMapLatLngs(route);
    const routeKey = buildRouteGeometryKey(route, geoPoints);

    if (geoPoints.length < 2) {
        layers.routeLine.setLatLngs([]);
        layers.riddenLine.setLatLngs([]);
        layers.currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.startMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.endMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.hasVisibleRoute = false;
        layers.lastRouteKey = "";
        return;
    }

    map.invalidateSize({ pan: false });
    const routeLineStyle = resolveRouteLineStyle(route);
    layers.routeLineOpacity = routeLineStyle.opacity;
    const routeChanged = layers.lastRouteKey !== routeKey;
    layers.routeLine.setStyle(routeLineStyle);
    layers.routeLine.setLatLngs(geoPoints);
    layers.routeLine.bringToFront?.();
    layers.startMarker.setLatLng(geoPoints[0]).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
    layers.endMarker.setLatLng(geoPoints.at(-1)).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
    layers.hasVisibleRoute = true;

    if (routeChanged || forceFocus) {
        layers.lastRouteKey = routeKey;
        focusRouteAfterLayout(map, layers, geoPoints, routeKey);
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

export function shouldFitPlannerSelection(layers, pointCount) {
    return pointCount === 2 && layers?.hasVisibleRoute !== true;
}

function resolveRouteLineStyle(route) {
    if (route?.networkSource === "synthetic") {
        return {
            color: "#f97316",
            weight: 7,
            opacity: 0.96
        };
    }

    if (route?.source === "osm-map" || route?.source === "osm-exploration") {
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
