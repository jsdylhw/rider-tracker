import { STREET_VIEW_UPDATE_INTERVAL_MS } from "../../app/store/initial-state.js";
import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";

export function loadGoogleMapsForStreetView(apiKey) {
    return loadGoogleMapsApi(apiKey);
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
    let lastTargetSignature = "";
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

    function update(target) {
        if (!isStreetViewTarget(target) || isAutoUpdatePaused() || panoramaRequestInFlight) return;

        const now = Date.now();
        const targetSignature = `${target.latitude.toFixed(6)}:${target.longitude.toFixed(6)}:${Math.round(target.heading)}`;

        if (lastTargetSignature && now - lastUpdateTime <= UPDATE_INTERVAL_MS) {
            return;
        }

        lastUpdateTime = now;
        lastTargetSignature = targetSignature;

        const heading = normalizeHeading(target.heading);
        const pitch = Math.atan((target.gradePercent ?? 0) / 100) * (180 / Math.PI);

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

        svService.getPanorama({ location: new window.google.maps.LatLng(target.latitude, target.longitude), radius: 50 }, (data, status) => {
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
            if (isStreetViewLocation(target.prefetchLocation)) {
                svService.getPanorama({
                    location: new window.google.maps.LatLng(target.prefetchLocation.latitude, target.prefetchLocation.longitude),
                    radius: 50
                }, () => {});
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

export function buildStreetViewTargetFromRoute(route, currentRecord) {
    if (!route || !currentRecord || !Number.isFinite(currentRecord.distanceKm)) {
        return null;
    }

    const currentDistanceMeters = currentRecord.distanceKm * 1000;
    const state = getRouteStateAtDistance(route, currentDistanceMeters);
    const nextState = getRouteStateAtDistance(route, currentDistanceMeters + 5);
    if (!state || !nextState) {
        return null;
    }

    const speedKph = Number.isFinite(currentRecord.speedKph) ? currentRecord.speedKph : 25;
    const futureDistanceMeters = currentDistanceMeters + (speedKph / 3.6) * (STREET_VIEW_UPDATE_INTERVAL_MS / 1000);
    const futureState = getRouteStateAtDistance(route, futureDistanceMeters);

    return {
        latitude: state.latitude,
        longitude: state.longitude,
        heading: bearingDegrees(state, nextState),
        gradePercent: state.gradePercent,
        speedKph,
        prefetchLocation: futureState ? {
            latitude: futureState.latitude,
            longitude: futureState.longitude
        } : null
    };
}

function getRouteStateAtDistance(route, distanceMeters) {
    if (!route?.points?.length) return null;

    const points = route.points;
    if (distanceMeters <= 0) return toRouteState(points[0]);
    if (distanceMeters >= route.totalDistanceMeters) return toRouteState(points.at(-1));

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

    const first = points[Math.max(0, low - 1)];
    const second = points[low];
    if (!second) return toRouteState(first);

    const segmentDistance = second.distanceMeters - first.distanceMeters;
    const ratio = segmentDistance === 0 ? 0 : (distanceMeters - first.distanceMeters) / segmentDistance;
    return {
        latitude: first.latitude + (second.latitude - first.latitude) * ratio,
        longitude: first.longitude + (second.longitude - first.longitude) * ratio,
        gradePercent: (first.gradePercent ?? 0) + ((second.gradePercent ?? 0) - (first.gradePercent ?? 0)) * ratio
    };
}

function toRouteState(point) {
    if (!Number.isFinite(point?.latitude) || !Number.isFinite(point?.longitude)) {
        return null;
    }
    return {
        latitude: point.latitude,
        longitude: point.longitude,
        gradePercent: point.gradePercent ?? 0
    };
}

function isStreetViewTarget(target) {
    return Number.isFinite(target?.latitude)
        && Number.isFinite(target?.longitude)
        && Number.isFinite(target?.heading);
}

function isStreetViewLocation(location) {
    return Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude);
}

function bearingDegrees(from, to) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const fromLatitude = toRadians(from.latitude);
    const toLatitude = toRadians(to.latitude);
    const deltaLongitude = toRadians(to.longitude - from.longitude);
    const y = Math.sin(deltaLongitude) * Math.cos(toLatitude);
    const x = Math.cos(fromLatitude) * Math.sin(toLatitude)
        - Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(deltaLongitude);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function normalizeHeading(value) {
    return ((value % 360) + 360) % 360;
}
