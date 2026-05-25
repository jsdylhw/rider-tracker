import { STREET_VIEW_UPDATE_INTERVAL_MS } from "../../app/store/initial-state.js";

const GOOGLE_CALLBACK_NAME = "__riderTrackerStreetViewInit";
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
            if (window[GOOGLE_CALLBACK_NAME]) {
                delete window[GOOGLE_CALLBACK_NAME];
            }
            if (previousAuthFailure) {
                window.gm_authFailure = previousAuthFailure;
            } else if (window.gm_authFailure) {
                delete window.gm_authFailure;
            }
        }

        document.body.appendChild(script);
    }).catch((error) => {
        // 失败后允许下次重新触发加载
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
    const pendingPanoramaCleanups = [];
    let requestInFlightTimeoutId = null;

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
    let panoramaRequestInFlight = false;

    const USER_INTERACTION_PAUSE_MS = 3000;
    const UPDATE_INTERVAL_MS = STREET_VIEW_UPDATE_INTERVAL_MS;
    let lastUpdateTime = 0;

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
            googleEvent.addListener(panorama, "pov_changed", () => {
                if (!applyingProgrammaticPov) {
                    pauseAutoUpdateForUserInteraction();
                }
            })
        );
    }

    bindUserInteractionPause(container1, pano1);
    bindUserInteractionPause(container2, pano2);

    function getTargetStateAtDistance(route, distanceMeters) {
        if (!route || !route.points || route.points.length === 0) return null;
        const points = route.points;
        if (distanceMeters <= 0) return { lat: points[0].latitude, lng: points[0].longitude, grade: points[0].gradePercent };
        if (distanceMeters >= route.totalDistanceMeters) return { lat: points[points.length - 1].latitude, lng: points[points.length - 1].longitude, grade: points[points.length - 1].gradePercent };

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
        if (!route || !currentRecord || isAutoUpdatePaused() || panoramaRequestInFlight) return;

        const now = Date.now();
        const currentDistanceMeters = currentRecord.distanceKm * 1000;

        if (lastDistance !== -1 && now - lastUpdateTime <= UPDATE_INTERVAL_MS) {
            return;
        }

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
        const activeEl = container1.parentElement?.querySelector(`#svPano${activeIndex}`);
        const nextEl = container1.parentElement?.querySelector(`#svPano${activeIndex === 1 ? 2 : 1}`);

        if (requestInFlightTimeoutId !== null) {
            window.clearTimeout(requestInFlightTimeoutId);
        }
        panoramaRequestInFlight = true;
        requestInFlightTimeoutId = window.setTimeout(() => {
            panoramaRequestInFlight = false;
            requestInFlightTimeoutId = null;
        }, 10000);

        svService.getPanorama({ location: new window.google.maps.LatLng(state.lat, state.lng), radius: 50 }, (data, status) => {
            panoramaRequestInFlight = false;
            if (requestInFlightTimeoutId !== null) {
                window.clearTimeout(requestInFlightTimeoutId);
                requestInFlightTimeoutId = null;
            }
            if (status !== window.google.maps.StreetViewStatus.OK || !data.location?.pano) return;

            const targetPanoId = data.location.pano;
            const currentPanoId = activePanorama.getPano();

            if (targetPanoId === currentPanoId) {
                setProgrammaticPov(activePanorama, { heading, pitch });
                return;
            }

            nextPanorama.setPano(targetPanoId);
            setProgrammaticPov(nextPanorama, { heading, pitch });

            let statusListener = null;
            let statusTimeoutId = null;
            const cleanupStatusListener = () => {
                const idx = pendingPanoramaCleanups.indexOf(cleanupStatusListener);
                if (idx !== -1) pendingPanoramaCleanups.splice(idx, 1);
                if (statusListener) {
                    googleEvent.removeListener(statusListener);
                    statusListener = null;
                }
                if (statusTimeoutId !== null) {
                    window.clearTimeout(statusTimeoutId);
                    statusTimeoutId = null;
                }
            };
            pendingPanoramaCleanups.push(cleanupStatusListener);
            statusListener = googleEvent.addListener(nextPanorama, "status_changed", () => {
                if (nextPanorama.getStatus() !== "OK") return;

                cleanupStatusListener();
                if (nextEl && activeEl) {
                    nextEl.style.opacity = "1";
                    nextEl.style.zIndex = "2";
                    activeEl.style.opacity = "0";
                    activeEl.style.zIndex = "1";
                }
                activeIndex = activeIndex === 1 ? 2 : 1;
            });
            statusTimeoutId = window.setTimeout(cleanupStatusListener, UPDATE_INTERVAL_MS);

            // Preload next update window
            const speedMps = (currentRecord.speedKph || 25) / 3.6;
            const futureState = getTargetStateAtDistance(route, currentDistanceMeters + speedMps * (UPDATE_INTERVAL_MS / 1000));
            if (futureState) {
                svService.getPanorama({ location: new window.google.maps.LatLng(futureState.lat, futureState.lng), radius: 50 }, () => {});
            }
        });
    }

    function destroy() {
        if (requestInFlightTimeoutId !== null) {
            window.clearTimeout(requestInFlightTimeoutId);
            requestInFlightTimeoutId = null;
        }
        panoramaRequestInFlight = false;
        while (pendingPanoramaCleanups.length) {
            pendingPanoramaCleanups.pop()();
        }
        listeners.forEach((listener) => {
            try {
                googleEvent.removeListener(listener);
            } catch {
                // ignore cleanup failure
            }
        });
        cleanupFns.forEach((fn) => fn());
    }

    return { update, destroy };
}
