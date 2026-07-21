import { collectRouteMapLatLngs, MAP_PROVIDERS } from "./map-controller.js";

export function hasActivityRouteMap(activity) {
    return collectActivityRouteMapLatLngs(activity).length >= 2;
}

export function collectActivityRouteMapLatLngs(activity) {
    const session = activity?.rawSession ?? {};
    const route = session.route ?? null;
    if (route?.source === "manual") {
        return [];
    }

    const routePoints = collectRouteMapLatLngs(route);
    if (routePoints.length >= 2) {
        return routePoints;
    }

    return (session.records ?? [])
        .map((record) => {
            const latitude = record?.positionLat;
            const longitude = record?.positionLong;
            return Number.isFinite(latitude) && Number.isFinite(longitude)
                ? [latitude, longitude]
                : null;
        })
        .filter(Boolean);
}

export function createActivityRouteMapController({ getProviderKey = () => "osm" } = {}) {
    let map = null;
    let mapElement = null;
    let leaflet = null;
    let tileLayer = null;
    let routeLine = null;
    let startMarker = null;
    let endMarker = null;
    let currentMarker = null;
    let lastPoints = [];

    function render(activity, element) {
        const points = downsampleActivityRouteMapLatLngs(collectActivityRouteMapLatLngs(activity));
        if (!element || points.length < 2 || !ensureMap(element)) {
            destroy();
            return false;
        }

        lastPoints = points;
        routeLine.setLatLngs(points);
        routeLine.redraw?.();
        startMarker.setLatLng(points[0]).setStyle({ opacity: 1, fillOpacity: 1 });
        endMarker.setLatLng(points.at(-1)).setStyle({ opacity: 1, fillOpacity: 1 });
        setCurrentRecord(activity?.rawSession?.records?.at(-1) ?? null);
        refreshRouteView(points);
        return true;
    }

    function setCurrentRecord(record) {
        if (!currentMarker) {
            return;
        }
        const latitude = record?.positionLat;
        const longitude = record?.positionLong;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
            return;
        }
        currentMarker.setLatLng([latitude, longitude]).setStyle({ opacity: 1, fillOpacity: 1 }).bringToFront?.();
    }

    function invalidateSize() {
        if (!map || lastPoints.length < 2) {
            return;
        }
        refreshRouteView(lastPoints);
    }

    function ensureMap(element) {
        if (map && mapElement === element) {
            return true;
        }
        destroy();

        leaflet = globalThis.window?.L;
        if (!leaflet) {
            return false;
        }

        mapElement = element;
        map = leaflet.map(element, {
            zoomControl: true,
            scrollWheelZoom: false,
            zoomSnap: 0.25,
            attributionControl: true
        });
        const provider = MAP_PROVIDERS[getProviderKey()] ?? MAP_PROVIDERS.osm;
        tileLayer = leaflet.tileLayer(provider.url, {
            maxZoom: 19,
            attribution: provider.attribution
        }).addTo(map);
        // Give Leaflet a concrete initial view before fitting a route. This keeps
        // tile and overlay panes valid when the detail page has just become visible.
        map.setView([31.2304, 121.4737], 10, { animate: false });
        routeLine = leaflet.polyline([], {
            color: "#0ea5e9",
            weight: 5,
            opacity: 0.95,
            interactive: false
        }).addTo(map);
        startMarker = createMarker("#2ed573");
        endMarker = createMarker("#ff4757");
        currentMarker = leaflet.circleMarker([0, 0], {
            radius: 8,
            color: "#ffffff",
            weight: 3,
            fillColor: "#3742fa",
            opacity: 0,
            fillOpacity: 0
        }).addTo(map);
        return true;
    }

    function createMarker(fillColor) {
        return leaflet.circleMarker([0, 0], {
            radius: 6,
            color: "#ffffff",
            weight: 2,
            fillColor,
            opacity: 0,
            fillOpacity: 0
        }).addTo(map);
    }

    function refreshRouteView(points) {
        applyRouteView(points);
        // The detail view may have been hidden immediately before this render.
        // Repeating after two paint frames makes both the Leaflet tile pane and
        // the polyline settle after the page has a measurable size.
        scheduleAfterLayout(() => scheduleAfterLayout(() => applyRouteView(points)));
    }

    function applyRouteView(points) {
        if (!map || points !== lastPoints || points.length < 2) {
            return;
        }
        map.invalidateSize({ pan: false });
        map.fitBounds(leaflet.latLngBounds(points), { padding: [24, 24], animate: false });
        tileLayer?.redraw?.();
        routeLine.redraw?.();
        routeLine.bringToFront?.();
        startMarker.bringToFront?.();
        endMarker.bringToFront?.();
        currentMarker.bringToFront?.();
    }

    function destroy() {
        map?.remove?.();
        map = null;
        mapElement = null;
        leaflet = null;
        tileLayer = null;
        routeLine = null;
        startMarker = null;
        endMarker = null;
        currentMarker = null;
        lastPoints = [];
    }

    return { render, setCurrentRecord, invalidateSize, destroy };
}

function downsampleActivityRouteMapLatLngs(points, maxPoints = 1600) {
    if (points.length <= maxPoints) {
        return points;
    }

    const lastIndex = points.length - 1;
    const step = lastIndex / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, index) => {
        const sourceIndex = index === maxPoints - 1 ? lastIndex : Math.round(index * step);
        return points[sourceIndex];
    });
}

function scheduleAfterLayout(callback) {
    if (typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(callback);
        return;
    }
    queueMicrotask(callback);
}
