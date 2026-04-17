import { STREET_VIEW_UPDATE_INTERVAL_MS } from "../../app/store/initial-state.js";

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

    function enableStreetView(containers) {
        if (!window.google || !window.google.maps || !window.google.maps.StreetViewPanorama) {
            console.error("Google Maps API not loaded");
            return;
        }

        streetViewController = createStreetViewController(containers);
    }

    return {
        syncRoute,
        syncRide,
        setMapProvider,
        enableStreetView,
        isReady: Boolean(window.L)
    };
}

function createStreetViewController({ container1, container2 }) {
    const svService = new window.google.maps.StreetViewService();
    
    const commonOptions = {
        zoom: 1,
        addressControl: false,
        showRoadLabels: false,
        linksControl: false,
        panControl: false,
        enableCloseButton: false,
        motionTracking: false,
        motionTrackingControl: false,
        clickToGo: false,
        disableDefaultUI: true
    };

    const pano1 = new window.google.maps.StreetViewPanorama(container1, { ...commonOptions });
    const pano2 = new window.google.maps.StreetViewPanorama(container2, { ...commonOptions });
    
    let activeIndex = 1;
    let lastDistance = -1;
    let pauseAutoUntil = 0;
    let applyingProgrammaticPov = false;
    const USER_INTERACTION_PAUSE_MS = 3000;
    
    // 街景更新节流（由全局配置统一管理）
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL_MS = STREET_VIEW_UPDATE_INTERVAL_MS;

    function pauseAutoUpdateForUserInteraction() {
        pauseAutoUntil = Date.now() + USER_INTERACTION_PAUSE_MS;
    }

    function isAutoUpdatePaused() {
        return Date.now() < pauseAutoUntil;
    }

    function setProgrammaticPov(panorama, pov) {
        applyingProgrammaticPov = true;
        panorama.setPov(pov);
        queueMicrotask(() => {
            applyingProgrammaticPov = false;
        });
    }

    function bindUserInteractionPause(container, panorama) {
        if (container) {
            container.addEventListener("pointerdown", pauseAutoUpdateForUserInteraction);
            container.addEventListener("wheel", pauseAutoUpdateForUserInteraction, { passive: true });
            container.addEventListener("touchstart", pauseAutoUpdateForUserInteraction, { passive: true });
        }

        window.google.maps.event.addListener(panorama, "pov_changed", () => {
            if (!applyingProgrammaticPov) {
                pauseAutoUpdateForUserInteraction();
            }
        });
    }

    bindUserInteractionPause(container1, pano1);
    bindUserInteractionPause(container2, pano2);

    function getTargetStateAtDistance(route, distanceMeters) {
        if (!route || !route.points || route.points.length === 0) return null;
        const points = route.points;
        if (distanceMeters <= 0) return { lat: points[0].latitude, lng: points[0].longitude, grade: points[0].gradePercent };
        if (distanceMeters >= route.totalDistanceMeters) return { lat: points[points.length - 1].latitude, lng: points[points.length - 1].longitude, grade: points[points.length - 1].gradePercent };

        let idx = 0;
        while (idx < points.length - 1 && points[idx + 1].distanceMeters < distanceMeters) {
            idx++;
        }
        const p1 = points[idx];
        const p2 = points[idx + 1];
        if (!p2) return { lat: p1.latitude, lng: p1.longitude, grade: p1.gradePercent };

        const segmentDist = p2.distanceMeters - p1.distanceMeters;
        const ratio = segmentDist === 0 ? 0 : (distanceMeters - p1.distanceMeters) / segmentDist;

        return {
            lat: p1.latitude + (p2.latitude - p1.latitude) * ratio,
            lng: p1.longitude + (p2.longitude - p1.longitude) * ratio,
            grade: p1.gradePercent + (p2.gradePercent - p1.gradePercent) * ratio
        };
    }

    function update(route, currentRecord) {
        if (!route || !currentRecord) return;
        if (isAutoUpdatePaused()) return;
        
        const now = Date.now();
        const currentDistanceMeters = currentRecord.distanceKm * 1000;

        // 初始化或者时间到达 5 秒间隔
        if (lastDistance === -1 || (now - lastUpdateTime > UPDATE_INTERVAL_MS)) {
            lastUpdateTime = now;
            lastDistance = currentDistanceMeters;

            const state = getTargetStateAtDistance(route, currentDistanceMeters);
            if (!state) return;

            const nextState = getTargetStateAtDistance(route, currentDistanceMeters + 5);
            let heading = 0;
            if (nextState) {
                heading = window.google.maps.geometry.spherical.computeHeading(
                    new window.google.maps.LatLng(state.lat, state.lng),
                    new window.google.maps.LatLng(nextState.lat, nextState.lng)
                );
            }
            const pitch = Math.atan(state.grade / 100) * (180 / Math.PI);

            const activePanorama = activeIndex === 1 ? pano1 : pano2;
            const nextPanorama = activeIndex === 1 ? pano2 : pano1;
            const activeEl = container1.parentElement.querySelector(`#svPano${activeIndex}`);
            const nextEl = container1.parentElement.querySelector(`#svPano${activeIndex === 1 ? 2 : 1}`);

            svService.getPanorama({ location: new window.google.maps.LatLng(state.lat, state.lng), radius: 50 }, (data, status) => {
                if (status === window.google.maps.StreetViewStatus.OK && data.location && data.location.pano) {
                    const targetPanoId = data.location.pano;
                    const currentPanoId = activePanorama.getPano();

                    if (targetPanoId === currentPanoId) {
                        setProgrammaticPov(activePanorama, { heading, pitch });
                        return;
                    }

                    nextPanorama.setPano(targetPanoId);
                    setProgrammaticPov(nextPanorama, { heading, pitch });

                    const listener = window.google.maps.event.addListener(nextPanorama, 'status_changed', () => {
                        if (nextPanorama.getStatus() === 'OK') {
                            window.google.maps.event.removeListener(listener);
                            if (nextEl && activeEl) {
                                nextEl.style.opacity = '1';
                                nextEl.style.zIndex = '2';
                                activeEl.style.opacity = '0';
                                activeEl.style.zIndex = '1';
                            }
                            activeIndex = activeIndex === 1 ? 2 : 1;
                        }
                    });
                    
                    // Preload next update window
                    const speedMps = (currentRecord.speedKph || 25) / 3.6;
                    const futureState = getTargetStateAtDistance(route, currentDistanceMeters + speedMps * (UPDATE_INTERVAL_MS / 1000));
                    if (futureState) {
                        svService.getPanorama({ location: new window.google.maps.LatLng(futureState.lat, futureState.lng), radius: 50 }, () => {});
                    }
                }
            });
        }
    }

    return { update };
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
