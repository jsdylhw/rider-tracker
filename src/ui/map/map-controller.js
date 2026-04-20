import { createStreetViewController, loadGoogleMapsForStreetView } from "./street-view-controller.js";

const MAP_PROVIDERS = {
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
        renderRoute(previewMap, previewLayers, route, null);
        renderRoute(dashboardMap, dashboardLayers, route, null);
    }

    function syncRide(route, currentRecord) {
        renderRoute(dashboardMap, dashboardLayers, route, currentRecord);
        if (streetViewController) {
            streetViewController.update(route, currentRecord);
        }
    }

    let streetViewController = null;

    async function enableStreetView({ apiKey, container1, container2 }) {
        await loadGoogleMapsForStreetView(apiKey);
        if (streetViewController) {
            streetViewController.destroy();
        }
        streetViewController = createStreetViewController({ container1, container2 });
    }

    return {
        syncRoute,
        syncRide,
        setMapProvider,
        enableStreetView,
        isReady: Boolean(window.L)
    };
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
