const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_ATTRIBUTION = '&copy; OpenStreetMap contributors';

export function createMapController({ previewElement, dashboardElement }) {
    const previewMap = createMap(previewElement, { zoomControl: false });
    const dashboardMap = createMap(dashboardElement, { zoomControl: true });

    const previewLayers = createLayerSet(previewMap);
    const dashboardLayers = createLayerSet(dashboardMap);

    function syncRoute(route) {
        renderRoute(previewMap, previewLayers, route, null);
        renderRoute(dashboardMap, dashboardLayers, route, null);
    }

    function syncRide(route, currentRecord) {
        renderRoute(dashboardMap, dashboardLayers, route, currentRecord);
    }

    return {
        syncRoute,
        syncRide,
        isReady: Boolean(window.L)
    };
}

function createMap(element, options) {
    if (!element || !window.L) {
        return null;
    }

    const map = window.L.map(element, {
        zoomSnap: 0.25,
        attributionControl: true,
        ...options
    });

    window.L.tileLayer(DEFAULT_TILE_URL, {
        maxZoom: 19,
        attribution: DEFAULT_ATTRIBUTION
    }).addTo(map);

    map.setView([31.2304, 121.4737], 10);

    return map;
}

function createLayerSet(map) {
    if (!map || !window.L) {
        return null;
    }

    return {
        routeLine: window.L.polyline([], {
            color: "#0ea5e9",
            weight: 5,
            opacity: 0.95
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
        lastRouteKey: ""
    };
}

function renderRoute(map, layers, route, currentRecord) {
    if (!map || !layers) {
        return;
    }

    const geoPoints = (route?.points ?? [])
        .filter((point) => typeof point.latitude === "number" && typeof point.longitude === "number")
        .map((point) => [point.latitude, point.longitude]);
    const routeKey = `${route?.source ?? "unknown"}:${route?.name ?? "route"}:${route?.totalDistanceMeters ?? 0}:${geoPoints.length}`;

    if (geoPoints.length < 2) {
        layers.routeLine.setLatLngs([]);
        layers.riddenLine.setLatLngs([]);
        layers.currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.startMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.endMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        layers.lastRouteKey = "";
        return;
    }

    map.invalidateSize();
    layers.routeLine.setLatLngs(geoPoints);
    layers.startMarker.setLatLng(geoPoints[0]).setStyle({ opacity: 1, fillOpacity: 1 });
    layers.endMarker.setLatLng(geoPoints.at(-1)).setStyle({ opacity: 1, fillOpacity: 1 });

    if (layers.lastRouteKey !== routeKey) {
        map.fitBounds(window.L.latLngBounds(geoPoints), {
            padding: [24, 24]
        });
        layers.lastRouteKey = routeKey;
    }

    if (!currentRecord || typeof currentRecord.positionLat !== "number" || typeof currentRecord.positionLong !== "number") {
        layers.riddenLine.setLatLngs([]);
        layers.currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        return;
    }

    const currentLatLng = [currentRecord.positionLat, currentRecord.positionLong];
    const riddenPoints = buildRiddenPoints(route, currentRecord.distanceKm * 1000, currentLatLng);

    layers.riddenLine.setLatLngs(riddenPoints);
    layers.currentMarker.setLatLng(currentLatLng).setStyle({ opacity: 1, fillOpacity: 1 });
    map.panTo(currentLatLng, { animate: true, duration: 0.5 });
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
