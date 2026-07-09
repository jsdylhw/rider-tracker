const GOOGLE_CALLBACK_NAME = "__osmRoadNetworkDemoStreetViewInit";
const PANORAMA_LOOKUP_INTERVAL_MS = 1000;
const PANORAMA_LOOKUP_DISTANCE_METERS = 18;
const PANORAMA_LOOKUP_TIMEOUT_MS = 10000;
const PANORAMA_CACHE_MAX_ENTRIES = 240;
const POV_READY_TIMEOUT_MS = 1200;
const USER_INTERACTION_PAUSE_MS = 3000;

let googleMapsLoadPromise = null;

export function loadGoogleMapsForStreetView(apiKey) {
    if (!apiKey) {
        return Promise.reject(new Error("缺少 Google Maps API Key"));
    }

    if (window.google?.maps?.StreetViewPanorama && window.google?.maps?.geometry) {
        return Promise.resolve();
    }

    if (googleMapsLoadPromise) {
        return googleMapsLoadPromise;
    }

    googleMapsLoadPromise = new Promise((resolve, reject) => {
        const previousAuthFailure = window.gm_authFailure;

        window.gm_authFailure = () => {
            cleanup();
            reject(new Error("API Key 验证失败，请检查 Key 与配额设置。"));
        };

        window[GOOGLE_CALLBACK_NAME] = () => {
            cleanup();
            resolve();
        };

        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=geometry&callback=${GOOGLE_CALLBACK_NAME}`;
        script.async = true;
        script.defer = true;
        script.onerror = () => {
            cleanup();
            reject(new Error("Google Maps API 加载失败，请检查网络连接或 API Key。"));
        };

        function cleanup() {
            delete window[GOOGLE_CALLBACK_NAME];
            if (previousAuthFailure) {
                window.gm_authFailure = previousAuthFailure;
            } else {
                delete window.gm_authFailure;
            }
        }

        document.body.appendChild(script);
    }).catch((error) => {
        googleMapsLoadPromise = null;
        throw error;
    });

    return googleMapsLoadPromise;
}

export function createStreetViewController({ container1, container2 }) {
    const svService = new window.google.maps.StreetViewService();
    const googleEvent = window.google.maps.event;
    const listeners = [];
    const cleanupFns = [];
    const panoramaCache = new Map();
    const pendingPanoramaRequests = new Map();
    let lookupInFlight = false;
    let lookupTimeoutId = null;
    let povReadyTimeoutId = null;

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
        disableDefaultUI: true,
        visible: true
    };

    const panorama = new window.google.maps.StreetViewPanorama(container1, { ...commonOptions });
    if (container1?.style) {
        container1.style.opacity = "1";
        container1.style.zIndex = "2";
    }
    if (container2?.style) {
        container2.style.opacity = "0";
        container2.style.zIndex = "1";
        container2.style.pointerEvents = "none";
    }

    let activePanoId = "";
    let lastLookupDistance = -1;
    let lastLookupTime = 0;
    let pauseAutoUntil = 0;
    let applyingProgrammaticPov = false;

    bindUserInteractionPause(container1, panorama);

    function update(route, currentRecord) {
        if (!route || !currentRecord || isAutoUpdatePaused()) return;

        const now = Date.now();
        const currentDistanceMeters = currentRecord.distanceKm * 1000;
        const pov = getPovAtDistance(route, currentDistanceMeters);
        if (!pov) return;

        setProgrammaticPov(panorama, { heading: pov.heading, pitch: pov.pitch });

        const movedEnough = lastLookupDistance === -1
            || Math.abs(currentDistanceMeters - lastLookupDistance) >= PANORAMA_LOOKUP_DISTANCE_METERS;
        const waitedEnough = lastLookupDistance === -1
            || now - lastLookupTime >= PANORAMA_LOOKUP_INTERVAL_MS;
        if (lookupInFlight || (!movedEnough && !waitedEnough)) {
            return;
        }

        lastLookupTime = now;
        lastLookupDistance = currentDistanceMeters;

        requestPanorama(pov.state, (data, status) => {
            if (status !== window.google.maps.StreetViewStatus.OK || !data.location?.pano) return;

            const targetPanoId = data.location.pano;
            if (targetPanoId === activePanoId || targetPanoId === panorama.getPano()) {
                activePanoId = targetPanoId;
                setProgrammaticPov(panorama, { heading: pov.heading, pitch: pov.pitch });
                return;
            }

            activePanoId = targetPanoId;
            panorama.setPano(targetPanoId);
            setProgrammaticPov(panorama, { heading: pov.heading, pitch: pov.pitch });
            restorePovWhenPanoramaReady({ heading: pov.heading, pitch: pov.pitch });
        }, { trackInFlight: true });
    }

    function destroy() {
        if (lookupTimeoutId !== null) {
            window.clearTimeout(lookupTimeoutId);
            lookupTimeoutId = null;
        }
        if (povReadyTimeoutId !== null) {
            window.clearTimeout(povReadyTimeoutId);
            povReadyTimeoutId = null;
        }
        lookupInFlight = false;
        listeners.forEach((listener) => {
            try {
                googleEvent.removeListener(listener);
            } catch {
                // ignore cleanup failure
            }
        });
        cleanupFns.forEach((fn) => fn());
        pendingPanoramaRequests.clear();
        panoramaCache.clear();
    }

    function bindUserInteractionPause(container, pano) {
        if (container) {
            const onPointerDown = () => pauseAutoUpdateForUserInteraction();
            const onWheel = () => pauseAutoUpdateForUserInteraction();
            const onTouchStart = () => pauseAutoUpdateForUserInteraction();

            container.addEventListener("pointerdown", onPointerDown);
            container.addEventListener("wheel", onWheel, { passive: true });
            container.addEventListener("touchstart", onTouchStart, { passive: true });

            cleanupFns.push(() => {
                container.removeEventListener("pointerdown", onPointerDown);
                container.removeEventListener("wheel", onWheel);
                container.removeEventListener("touchstart", onTouchStart);
            });
        }

        listeners.push(
            googleEvent.addListener(pano, "pov_changed", () => {
                if (!applyingProgrammaticPov) {
                    pauseAutoUpdateForUserInteraction();
                }
            })
        );
    }

    function pauseAutoUpdateForUserInteraction() {
        pauseAutoUntil = Date.now() + USER_INTERACTION_PAUSE_MS;
    }

    function isAutoUpdatePaused() {
        return Date.now() < pauseAutoUntil;
    }

    function setProgrammaticPov(pano, pov) {
        applyingProgrammaticPov = true;
        pano.setPov(pov);
        queueMicrotask(() => {
            applyingProgrammaticPov = false;
        });
    }

    function restorePovWhenPanoramaReady(pov) {
        let statusListener = null;
        let linksListener = null;
        const cleanup = () => {
            if (statusListener) {
                googleEvent.removeListener(statusListener);
                statusListener = null;
            }
            if (linksListener) {
                googleEvent.removeListener(linksListener);
                linksListener = null;
            }
            if (povReadyTimeoutId !== null) {
                window.clearTimeout(povReadyTimeoutId);
                povReadyTimeoutId = null;
            }
        };
        const applyAndCleanup = () => {
            setProgrammaticPov(panorama, pov);
            cleanup();
        };

        statusListener = googleEvent.addListener(panorama, "status_changed", () => {
            if (panorama.getStatus() === window.google.maps.StreetViewStatus.OK) {
                applyAndCleanup();
            }
        });
        linksListener = googleEvent.addListener(panorama, "links_changed", applyAndCleanup);
        povReadyTimeoutId = window.setTimeout(applyAndCleanup, POV_READY_TIMEOUT_MS);
    }

    function getTargetStateAtDistance(route, distanceMeters) {
        if (!route.points?.length) return null;
        const points = route.points;
        if (distanceMeters <= 0) return pointToState(points[0]);
        if (distanceMeters >= route.totalDistanceMeters) return pointToState(points.at(-1));

        let low = 0;
        let high = points.length - 1;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (points[mid].distanceMeters < distanceMeters) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        const idx = Math.max(0, low - 1);
        const p1 = points[idx];
        const p2 = points[idx + 1];
        if (!p2) return pointToState(p1);

        const segmentDist = Math.max(1, p2.distanceMeters - p1.distanceMeters);
        const ratio = (distanceMeters - p1.distanceMeters) / segmentDist;

        return {
            lat: p1.latitude + (p2.latitude - p1.latitude) * ratio,
            lng: p1.longitude + (p2.longitude - p1.longitude) * ratio,
            grade: (p1.gradePercent ?? 0) + ((p2.gradePercent ?? 0) - (p1.gradePercent ?? 0)) * ratio
        };
    }

    function pointToState(point) {
        return {
            lat: point.latitude,
            lng: point.longitude,
            grade: point.gradePercent ?? 0
        };
    }

    function getPovAtDistance(route, distanceMeters) {
        const state = getTargetStateAtDistance(route, distanceMeters);
        if (!state) return null;

        const nextState = getTargetStateAtDistance(route, distanceMeters + 5);
        let heading = 0;
        if (nextState) {
            heading = window.google.maps.geometry.spherical.computeHeading(
                new window.google.maps.LatLng(state.lat, state.lng),
                new window.google.maps.LatLng(nextState.lat, nextState.lng)
            );
        }
        const pitch = Math.atan(state.grade / 100) * (180 / Math.PI);

        return { state, heading, pitch };
    }

    function getPanoramaCacheKey(state) {
        return `${state.lat.toFixed(4)},${state.lng.toFixed(4)}`;
    }

    function requestPanorama(state, callback, { trackInFlight = false } = {}) {
        const key = getPanoramaCacheKey(state);
        const cached = panoramaCache.get(key);
        if (cached) {
            callback(cached.data, cached.status);
            return;
        }

        const pending = pendingPanoramaRequests.get(key);
        if (pending) {
            pending.push(callback);
            return;
        }

        pendingPanoramaRequests.set(key, [callback]);
        if (trackInFlight) {
            startTrackedPanoramaRequest();
        }

        svService.getPanorama({ location: new window.google.maps.LatLng(state.lat, state.lng), radius: 50 }, (data, status) => {
            if (trackInFlight) {
                finishTrackedPanoramaRequest();
            }

            rememberPanoramaResult(key, { data, status });
            const callbacks = pendingPanoramaRequests.get(key) ?? [];
            pendingPanoramaRequests.delete(key);
            callbacks.forEach((fn) => fn(data, status));
        });
    }

    function startTrackedPanoramaRequest() {
        if (lookupTimeoutId !== null) {
            window.clearTimeout(lookupTimeoutId);
        }
        lookupInFlight = true;
        lookupTimeoutId = window.setTimeout(() => {
            lookupInFlight = false;
            lookupTimeoutId = null;
        }, PANORAMA_LOOKUP_TIMEOUT_MS);
    }

    function finishTrackedPanoramaRequest() {
        lookupInFlight = false;
        if (lookupTimeoutId !== null) {
            window.clearTimeout(lookupTimeoutId);
            lookupTimeoutId = null;
        }
    }

    function rememberPanoramaResult(key, result) {
        panoramaCache.set(key, result);
        if (panoramaCache.size > PANORAMA_CACHE_MAX_ENTRIES) {
            panoramaCache.delete(panoramaCache.keys().next().value);
        }
    }

    return { update, destroy };
}
