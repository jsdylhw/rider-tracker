const GOOGLE_CALLBACK_NAME = "__osmRoadNetworkDemoStreetViewInit";
const PANORAMA_LOOKUP_INTERVAL_MS = 1000;
const PANORAMA_LOOKUP_DISTANCE_METERS = 18;
const PANORAMA_LOOKUP_TIMEOUT_MS = 10000;
const PANORAMA_CACHE_MAX_ENTRIES = 240;
const POV_READY_TIMEOUT_MS = 1200;
const USER_INTERACTION_PAUSE_MS = 3000;
const NATIVE_LINK_MOVE_MIN_DISTANCE_METERS = 1.2;
const NATIVE_LINK_MOVE_MAX_DISTANCE_METERS = 4;
const NATIVE_LINK_MOVE_MIN_INTERVAL_MS = 100;
const NATIVE_LINK_MOVE_MAX_INTERVAL_MS = 500;
const MAX_NATIVE_LINK_HEADING_DELTA_DEGREES = 75;
const NATIVE_PANO_ROUTE_LEAD_METERS = 2;
const USER_PANO_RESYNC_DISTANCE_METERS = 45;
const AUTO_CATCH_UP_MIN_INTERVAL_MS = 900;
const AUTO_CATCH_UP_MIN_DISTANCE_METERS = 28;
const SINGLE_PANO_PREDICTION_SECONDS = 0.7;
const NATIVE_LOOKAHEAD_MAX_HOPS = 3;
const NATIVE_LOOKAHEAD_ROUTE_STEP_METERS = 12;
const NATIVE_LOOKAHEAD_CACHE_MAX_ENTRIES = 48;
const TWO_HOP_SPEED_KPH = 28;
const THREE_HOP_SPEED_KPH = 42;

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

export function createStreetViewController({ container1, container2, onTrace } = {}) {
    const svService = new window.google.maps.StreetViewService();
    const googleEvent = window.google.maps.event;
    const listeners = [];
    const cleanupFns = [];
    const panoramaCache = new Map();
    const pendingPanoramaRequests = new Map();
    const panoMetadataCache = new Map();
    const pendingPanoMetadataRequests = new Map();
    const nativeLookaheadCache = new Map();
    let lookupInFlight = false;
    let lookupTimeoutId = null;
    let cancelPanoReadyWait = null;
    let panoLoad = null;

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
    let lastNativeLinkDistance = -1;
    let lastNativeLinkTime = 0;
    let pauseAutoUntil = 0;
    let lastAutoCatchUpTime = 0;
    let latestDesiredPov = null;
    let latestRoutePov = null;
    let latestRouteDistanceMeters = 0;
    let gpsLookupGeneration = 0;
    let previousNativePanoId = "";
    let lastNativeWaitPanoId = "";
    let lastNativeWaitLogTime = 0;
    let waitingForNativeRoutePosition = false;

    bindUserInteractionPause(container1, panorama);
    trace("controller-ready", "Street View controller 已就绪");

    function update(route, currentRecord) {
        if (!route || !currentRecord) return { navigation: "waiting" };
        if (isAutoUpdatePaused()) return { navigation: "paused" };

        const now = Date.now();
        const currentDistanceMeters = currentRecord.distanceKm * 1000;
        const pov = getPovAtDistance(route, currentDistanceMeters);
        if (!pov) return { navigation: "waiting" };
        waitingForNativeRoutePosition = false;
        latestDesiredPov = { heading: pov.heading, pitch: pov.pitch };
        latestRoutePov = pov;
        latestRouteDistanceMeters = currentDistanceMeters;

        const panoramaPosition = readLatLng(panorama.getPosition?.());

        const hasNativeForwardLink = hasRouteAlignedNativeLink(pov.heading, previousNativePanoId);
        if (!hasNativeForwardLink && shouldAutoCatchUp(panoramaPosition, pov.state, currentRecord.speedKph, now)) {
            lastLookupTime = now;
            lastLookupDistance = currentDistanceMeters;
            lookupRoutePanorama(
                getPredictedPov(route, currentDistanceMeters, currentRecord.speedKph) ?? pov,
                { trackInFlight: true, reason: "gps-catch-up" }
            );
            return { navigation: "gps-catch-up" };
        }

        if (isPanoLoadPending(now)) {
            setProgrammaticPov(panorama, latestDesiredPov);
            return { navigation: "pano-loading", pano: panoLoad.pano };
        }

        const nativeMove = moveToRouteAlignedNativeLink(route, pov, currentDistanceMeters, currentRecord.speedKph, now);
        if (nativeMove) {
            return { navigation: "native-link", nativeLinkHops: nativeMove.hops };
        }

        if (hasNativeForwardLink) {
            if (waitingForNativeRoutePosition) {
                return { navigation: "pano-waiting" };
            }
            setProgrammaticPov(panorama, latestDesiredPov);
            return { navigation: "pov-only" };
        }

        const movedEnough = lastLookupDistance === -1
            || Math.abs(currentDistanceMeters - lastLookupDistance) >= PANORAMA_LOOKUP_DISTANCE_METERS;
        const waitedEnough = lastLookupDistance === -1
            || now - lastLookupTime >= PANORAMA_LOOKUP_INTERVAL_MS;
        if (lookupInFlight || (!movedEnough && !waitedEnough)) {
            return { navigation: "pano-waiting" };
        }

        lastLookupTime = now;
        lastLookupDistance = currentDistanceMeters;

        lookupRoutePanorama(pov, { trackInFlight: true, reason: "gps-lookup" });

        return { navigation: "gps-lookup" };
    }

    function lookupRoutePanorama(pov, {
        trackInFlight = false,
        reason = "gps-lookup",
        distanceMeters = latestRouteDistanceMeters
    } = {}) {
        const startedAt = Date.now();
        const lookupGeneration = ++gpsLookupGeneration;
        trace("gps-request", `GPS 查找 pano (${reason})`, { reason, lat: pov.state.lat, lng: pov.state.lng });
        requestPanorama(pov.state, (data, status, requestMeta) => {
            const durationMs = Date.now() - startedAt;
            if (lookupGeneration !== gpsLookupGeneration) {
                trace("gps-stale", "忽略已过期的 GPS 查找结果", {
                    reason,
                    durationMs,
                    source: requestMeta.source
                });
                return;
            }
            if (status !== window.google.maps.StreetViewStatus.OK || !data.location?.pano) {
                trace("gps-failed", `GPS 查找失败: ${status}`, { reason, durationMs, source: requestMeta.source });
                return;
            }

            if (!activePanoId
                && latestRoutePov
                && Math.abs(latestRouteDistanceMeters - distanceMeters) >= PANORAMA_LOOKUP_DISTANCE_METERS) {
                trace("gps-stale", "初始 GPS 查找已落后路线，重新查找当前位置", {
                    reason,
                    durationMs,
                    advancedMeters: Math.round(Math.abs(latestRouteDistanceMeters - distanceMeters))
                });
                lookupRoutePanorama(latestRoutePov, {
                    trackInFlight,
                    reason: "gps-refresh",
                    distanceMeters: latestRouteDistanceMeters
                });
                return;
            }

            const targetPanoId = data.location.pano;
            trace("gps-ready", `GPS 查找到 pano ${targetPanoId}`, {
                reason,
                durationMs,
                source: requestMeta.source
            });
            if (targetPanoId === activePanoId || targetPanoId === panorama.getPano()) {
                activePanoId = targetPanoId;
                setProgrammaticPov(panorama, { heading: pov.heading, pitch: pov.pitch });
                trace("gps-reuse", `GPS 结果与当前 pano 相同: ${targetPanoId}`, { reason });
                return;
            }

            activePanoId = targetPanoId;
            beginPanoLoad(targetPanoId, reason);
            panorama.setPano(targetPanoId);
            setProgrammaticPov(panorama, latestDesiredPov ?? { heading: pov.heading, pitch: pov.pitch });
            restorePovWhenPanoramaReady({ heading: pov.heading, pitch: pov.pitch }, targetPanoId);
        }, { trackInFlight });
    }

    function destroy() {
        if (lookupTimeoutId !== null) {
            window.clearTimeout(lookupTimeoutId);
            lookupTimeoutId = null;
        }
        cancelPanoReadyWait?.();
        cancelPanoReadyWait = null;
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
        pendingPanoMetadataRequests.clear();
        panoMetadataCache.clear();
        nativeLookaheadCache.clear();
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

    }

    function pauseAutoUpdateForUserInteraction() {
        pauseAutoUntil = Date.now() + USER_INTERACTION_PAUSE_MS;
    }

    function isAutoUpdatePaused() {
        return Date.now() < pauseAutoUntil;
    }

    function setProgrammaticPov(pano, pov) {
        pano.setPov(pov);
    }

    function shouldAutoCatchUp(panoramaPosition, routePosition, speedKph, now) {
        if (!panoramaPosition || now - lastAutoCatchUpTime < AUTO_CATCH_UP_MIN_INTERVAL_MS) {
            return false;
        }

        const speedMetersPerSecond = Math.max(0, Number(speedKph) || 0) / 3.6;
        const maxDistanceMeters = Math.max(
            AUTO_CATCH_UP_MIN_DISTANCE_METERS,
            speedMetersPerSecond * 2
        );
        if (!shouldResyncToRoutePano(panoramaPosition, routePosition, maxDistanceMeters)) {
            return false;
        }

        lastAutoCatchUpTime = now;
        return true;
    }

    function getPredictedPov(route, distanceMeters, speedKph) {
        const speedMetersPerSecond = Math.max(0, Number(speedKph) || 0) / 3.6;
        return getPovAtDistance(
            route,
            distanceMeters + speedMetersPerSecond * SINGLE_PANO_PREDICTION_SECONDS
        );
    }

    function moveToRouteAlignedNativeLink(route, pov, distanceMeters, speedKph, now) {
        const currentPanoId = activePanoId || panorama.getPano?.();
        const moveDistanceMeters = getNativeLinkMoveDistanceMeters(speedKph);
        const movedEnough = lastNativeLinkDistance === -1
            || Math.abs(distanceMeters - lastNativeLinkDistance) >= moveDistanceMeters;
        const waitedEnough = now - lastNativeLinkTime >= getNativeLinkMoveIntervalMs(speedKph);
        if (!currentPanoId || !movedEnough || !waitedEnough) {
            return false;
        }

        const target = getNativeLookaheadTarget(
            route,
            currentPanoId,
            pov.heading,
            distanceMeters,
            speedKph,
            previousNativePanoId
        );
        if (!target) {
            return false;
        }

        const targetRouteDistanceMeters = getRouteDistanceAtPosition(route, target.position);
        if (Number.isFinite(targetRouteDistanceMeters)
            && targetRouteDistanceMeters > distanceMeters + NATIVE_PANO_ROUTE_LEAD_METERS) {
            waitingForNativeRoutePosition = true;
            if (target.pano !== lastNativeWaitPanoId || now - lastNativeWaitLogTime >= 1000) {
                trace("native-wait", "等待模拟位置追上前方 pano", {
                    pano: target.pano,
                    routeDistanceMeters: Math.round(distanceMeters),
                    targetRouteDistanceMeters: Math.round(targetRouteDistanceMeters)
                });
                lastNativeWaitPanoId = target.pano;
                lastNativeWaitLogTime = now;
            }
            return false;
        }

        lastNativeLinkDistance = distanceMeters;
        lastNativeLinkTime = now;
        lastLookupDistance = distanceMeters;
        lastLookupTime = now;
        gpsLookupGeneration += 1;
        previousNativePanoId = currentPanoId;
        lastNativeWaitPanoId = "";
        activePanoId = target.pano;
        beginPanoLoad(target.pano, `native-link-${target.hops}`);
        panorama.setPano(target.pano);
        setProgrammaticPov(panorama, latestDesiredPov ?? { heading: pov.heading, pitch: pov.pitch });
        restorePovWhenPanoramaReady({ heading: pov.heading, pitch: pov.pitch }, target.pano);
        promoteNativeLookaheadTarget(target, pov.heading);
        trace("native-link", `原生 link 切换到 ${target.pano}`, {
            hops: target.hops,
            lookaheadHops: target.lookaheadHops,
            routeDistanceMeters: Math.round(distanceMeters),
            targetRouteDistanceMeters: Number.isFinite(targetRouteDistanceMeters)
                ? Math.round(targetRouteDistanceMeters)
                : null
        });
        return target;
    }

    function hasRouteAlignedNativeLink(routeHeading, blockedPanoId = "") {
        const currentPanoId = activePanoId || panorama.getPano?.();
        return Boolean(chooseRouteAlignedLink(
            panorama.getLinks?.() ?? [],
            routeHeading,
            currentPanoId,
            blockedPanoId ? [blockedPanoId] : []
        ));
    }

    function getNativeLookaheadTarget(route, currentPanoId, routeHeading, distanceMeters, speedKph, blockedPanoId = "") {
        if (!currentPanoId) return null;

        const lookahead = primeNativeLookahead(route, currentPanoId, routeHeading, distanceMeters, blockedPanoId);
        if (!lookahead?.entries.length) return null;

        const desiredHops = getNativeLookaheadHopCount(speedKph);
        const index = 0;
        const entry = lookahead.entries[index];
        if (!entry.position && lookahead.pending) return null;
        return {
            ...entry,
            sourcePanoId: currentPanoId,
            cacheKey: lookahead.cacheKey,
            index,
            hops: 1,
            lookaheadHops: Math.min(desiredHops, lookahead.entries.length)
        };
    }

    function primeNativeLookahead(route, currentPanoId, routeHeading, distanceMeters, blockedPanoId = "") {
        const cached = nativeLookaheadCache.get(currentPanoId);
        if (cached
            && cached.blockedPanoId === blockedPanoId
            && angularDistanceDegrees(cached.routeHeading, routeHeading) <= MAX_NATIVE_LINK_HEADING_DELTA_DEGREES) {
            return cached;
        }

        const firstLink = chooseRouteAlignedLink(
            panorama.getLinks?.() ?? [],
            routeHeading,
            currentPanoId,
            blockedPanoId ? [blockedPanoId] : []
        );
        if (!firstLink) return null;

        const lookahead = {
            cacheKey: `${currentPanoId}:${Date.now()}`,
            routeHeading,
            blockedPanoId,
            entries: [toLookaheadEntry(firstLink)],
            pending: true
        };
        rememberNativeLookahead(currentPanoId, lookahead);
        resolveNativeLookahead(route, lookahead, distanceMeters);
        return lookahead;
    }

    function resolveNativeLookahead(route, lookahead, distanceMeters) {
        const currentEntry = lookahead.entries.at(-1);
        if (!currentEntry || lookahead.entries.length >= NATIVE_LOOKAHEAD_MAX_HOPS) {
            lookahead.pending = false;
            return;
        }

        requestPanoramaMetadata(currentEntry.pano, (data, status) => {
            if (status !== window.google.maps.StreetViewStatus.OK || !data) {
                lookahead.pending = false;
                return;
            }

            currentEntry.position = readLatLng(data.location?.latLng);
            const futurePov = getPovAtDistance(
                route,
                distanceMeters + lookahead.entries.length * NATIVE_LOOKAHEAD_ROUTE_STEP_METERS
            );
            const nextLink = chooseRouteAlignedLink(data.links ?? [], futurePov?.heading, currentEntry.pano);
            if (!nextLink) {
                lookahead.pending = false;
                return;
            }

            lookahead.entries.push(toLookaheadEntry(nextLink));
            resolveNativeLookahead(route, lookahead, distanceMeters);
        });
    }

    function promoteNativeLookaheadTarget(target, routeHeading) {
        const sourceLookahead = nativeLookaheadCache.get(target.sourcePanoId);
        if (!sourceLookahead || sourceLookahead.cacheKey !== target.cacheKey) return;

        const remainingEntries = sourceLookahead.entries.slice(target.index + 1);
        if (!remainingEntries.length) return;

        rememberNativeLookahead(target.pano, {
            cacheKey: `${target.pano}:${Date.now()}`,
            routeHeading,
            blockedPanoId: "",
            entries: remainingEntries,
            pending: sourceLookahead.pending
        });
    }

    function toLookaheadEntry(link) {
        return {
            pano: link.pano,
            heading: link.heading,
            position: null
        };
    }

    function beginPanoLoad(panoId, reason) {
        cancelPanoReadyWait?.();
        cancelPanoReadyWait = null;
        panoLoad = {
            pano: panoId,
            reason,
            startedAt: Date.now(),
            ready: false
        };
        trace("pano-set", `切换 pano ${panoId}`, { reason });
    }

    function isPanoLoadPending(now) {
        if (!panoLoad || panoLoad.ready) return false;
        if (now - panoLoad.startedAt <= POV_READY_TIMEOUT_MS) return true;

        trace("pano-ready-timeout", `pano ${panoLoad.pano} 等待就绪超时`, {
            reason: panoLoad.reason,
            durationMs: now - panoLoad.startedAt
        });
        panoLoad = null;
        return false;
    }

    function restorePovWhenPanoramaReady(pov, expectedPanoId) {
        let statusListener = null;
        let linksListener = null;
        let timeoutId = null;
        let finished = false;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            if (statusListener) {
                googleEvent.removeListener(statusListener);
                statusListener = null;
            }
            if (linksListener) {
                googleEvent.removeListener(linksListener);
                linksListener = null;
            }
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (cancelPanoReadyWait === cleanup) {
                cancelPanoReadyWait = null;
            }
        };
        const applyAndCleanup = (source) => {
            if (panorama.getPano?.() !== expectedPanoId) {
                cleanup();
                return;
            }
            setProgrammaticPov(panorama, latestDesiredPov ?? pov);
            if (panoLoad?.pano === expectedPanoId) {
                panoLoad.ready = true;
                trace("pano-ready", `pano ${expectedPanoId} 已就绪`, {
                    reason: panoLoad.reason,
                    source,
                    durationMs: Date.now() - panoLoad.startedAt
                });
            }
            cleanup();
        };

        statusListener = googleEvent.addListener(panorama, "status_changed", () => {
            if (panorama.getStatus() === window.google.maps.StreetViewStatus.OK) {
                applyAndCleanup("status");
            }
        });
        linksListener = googleEvent.addListener(panorama, "links_changed", () => applyAndCleanup("links"));
        timeoutId = window.setTimeout(() => applyAndCleanup("timeout"), POV_READY_TIMEOUT_MS);
        cancelPanoReadyWait = cleanup;
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
            callback(cached.data, cached.status, { source: "cache" });
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
            callbacks.forEach((fn) => fn(data, status, { source: "network" }));
        });
    }

    function requestPanoramaMetadata(panoId, callback) {
        const cached = panoMetadataCache.get(panoId);
        if (cached) {
            callback(cached.data, cached.status);
            return;
        }

        const pending = pendingPanoMetadataRequests.get(panoId);
        if (pending) {
            pending.push(callback);
            return;
        }

        pendingPanoMetadataRequests.set(panoId, [callback]);
        svService.getPanorama({ pano: panoId }, (data, status) => {
            rememberPanoMetadata(panoId, { data, status });
            const callbacks = pendingPanoMetadataRequests.get(panoId) ?? [];
            pendingPanoMetadataRequests.delete(panoId);
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

    function rememberPanoMetadata(panoId, result) {
        panoMetadataCache.set(panoId, result);
        if (panoMetadataCache.size > NATIVE_LOOKAHEAD_CACHE_MAX_ENTRIES) {
            panoMetadataCache.delete(panoMetadataCache.keys().next().value);
        }
    }

    function rememberNativeLookahead(panoId, lookahead) {
        nativeLookaheadCache.set(panoId, lookahead);
        if (nativeLookaheadCache.size > NATIVE_LOOKAHEAD_CACHE_MAX_ENTRIES) {
            nativeLookaheadCache.delete(nativeLookaheadCache.keys().next().value);
        }
    }

    function trace(event, message, details = {}) {
        const entry = { event, message, at: Date.now(), ...details };
        onTrace?.(entry);
    }

    return { update, destroy };
}

export function getNativeLinkMoveDistanceMeters(speedKph) {
    return clamp(
        45 / Math.max(1, Number(speedKph) || 0),
        NATIVE_LINK_MOVE_MIN_DISTANCE_METERS,
        NATIVE_LINK_MOVE_MAX_DISTANCE_METERS
    );
}

export function getNativeLinkMoveIntervalMs(speedKph) {
    return clamp(
        7000 / Math.max(1, Number(speedKph) || 0),
        NATIVE_LINK_MOVE_MIN_INTERVAL_MS,
        NATIVE_LINK_MOVE_MAX_INTERVAL_MS
    );
}

export function getNativeLookaheadHopCount(speedKph) {
    const speed = Math.max(0, Number(speedKph) || 0);
    if (speed >= THREE_HOP_SPEED_KPH) return 3;
    if (speed >= TWO_HOP_SPEED_KPH) return 2;
    return 1;
}

export function getRouteDistanceAtPosition(route, position) {
    const target = readLatLng(position);
    const points = route?.points ?? [];
    if (!target || points.length === 0) return null;
    if (points.length === 1) return points[0].distanceMeters ?? 0;

    let nearestDistanceMeters = null;
    let nearestSquaredDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length - 1; index += 1) {
        const first = toRoutePointState(points[index]);
        const second = toRoutePointState(points[index + 1]);
        const segment = toLocalMeters(second, first);
        const targetOffset = toLocalMeters(target, first);
        const segmentLengthSquared = segment.x ** 2 + segment.y ** 2;
        if (segmentLengthSquared === 0) continue;

        const ratio = clamp(
            (targetOffset.x * segment.x + targetOffset.y * segment.y) / segmentLengthSquared,
            0,
            1
        );
        const closest = { x: segment.x * ratio, y: segment.y * ratio };
        const squaredDistance = (targetOffset.x - closest.x) ** 2 + (targetOffset.y - closest.y) ** 2;
        if (squaredDistance >= nearestSquaredDistance) continue;

        const firstDistance = points[index].distanceMeters ?? 0;
        const secondDistance = points[index + 1].distanceMeters ?? firstDistance;
        nearestSquaredDistance = squaredDistance;
        nearestDistanceMeters = firstDistance + (secondDistance - firstDistance) * ratio;
    }
    return nearestDistanceMeters;
}

export function chooseRouteAlignedLink(links, routeHeading, currentPanoId = "", excludedPanoIds = []) {
    if (!Number.isFinite(routeHeading)) return null;
    const excluded = new Set(excludedPanoIds);

    return (links ?? [])
        .filter((link) => link?.pano
            && link.pano !== currentPanoId
            && !excluded.has(link.pano)
            && Number.isFinite(link.heading))
        .map((link) => ({
            ...link,
            headingDelta: angularDistanceDegrees(routeHeading, link.heading)
        }))
        .filter((link) => link.headingDelta <= MAX_NATIVE_LINK_HEADING_DELTA_DEGREES)
        .sort((left, right) => left.headingDelta - right.headingDelta)[0] ?? null;
}

export function shouldResyncToRoutePano(currentPosition, routePosition, maxDistanceMeters = USER_PANO_RESYNC_DISTANCE_METERS) {
    const current = readLatLng(currentPosition);
    const target = readLatLng(routePosition);
    if (!current || !target) return false;
    return haversineDistanceMeters(current, target) > maxDistanceMeters;
}

function readLatLng(value) {
    const lat = typeof value?.lat === "function" ? value.lat() : value?.lat;
    const lng = typeof value?.lng === "function" ? value.lng() : value?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

function haversineDistanceMeters(first, second) {
    const earthRadiusMeters = 6371000;
    const latitudeDelta = toRadians(second.lat - first.lat);
    const longitudeDelta = toRadians(second.lng - first.lng);
    const firstLatitude = toRadians(first.lat);
    const secondLatitude = toRadians(second.lat);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toLocalMeters(point, origin) {
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(toRadians(origin.lat));
    return {
        x: (point.lng - origin.lng) * metersPerDegreeLng,
        y: (point.lat - origin.lat) * metersPerDegreeLat
    };
}

function toRoutePointState(point) {
    return {
        lat: point.latitude,
        lng: point.longitude
    };
}

function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}

function angularDistanceDegrees(first, second) {
    const delta = ((first - second + 540) % 360) - 180;
    return Math.abs(delta);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
