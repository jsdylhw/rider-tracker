import { loadGoogleMapsApi } from "../../adapters/maps/google-maps-loader.js";

const GPS_LOOKUP_INTERVAL_MS = 1000;
const GPS_LOOKUP_DISTANCE_METERS = 18;
const GPS_CATCH_UP_DISTANCE_METERS = 28;
const GPS_CATCH_UP_INTERVAL_MS = 900;
const NATIVE_PANO_ROUTE_LEAD_METERS = 2;
// Keep the single-panorama handoff effect, but avoid replacing the image again
// before the viewer has had time to perceive the previous panorama.
const NATIVE_PANO_MIN_SWITCH_INTERVAL_MS = 700;
const NATIVE_PANO_MIN_SWITCH_DISTANCE_METERS = 6;
const STABLE_PANO_UPDATE_INTERVAL_MS = 2500;
const STABLE_PANO_RENDER_SETTLE_MS = 300;
const STABLE_PANO_SWITCH_LEAD_METERS = 2;
const USER_INTERACTION_PAUSE_MS = 3000;
const PANO_READY_TIMEOUT_MS = 1200;
const MAX_NATIVE_LINK_HEADING_DELTA_DEGREES = 75;
const NATIVE_LOOKAHEAD_MAX_HOPS = 3;
const TWO_HOP_LOOKAHEAD_SPEED_KPH = 18;
const THREE_HOP_LOOKAHEAD_SPEED_KPH = 32;
const PANO_POV_TRANSITION_MIN_MS = 180;
const PANO_POV_TRANSITION_MAX_MS = 360;

export const STREET_VIEW_MODES = {
    MOVING: "moving",
    STABLE: "stable"
};

export function loadGoogleMapsForStreetView(apiKey) {
    return loadGoogleMapsApi(apiKey);
}

export function createStreetViewController({ container1, container2, mode = STREET_VIEW_MODES.MOVING, onTrace } = {}) {
    if (mode === STREET_VIEW_MODES.STABLE) {
        return createStableStreetViewController({ container1, container2, onTrace });
    }
    if (container1) {
        container1.style.display = "";
        container1.style.opacity = "1";
        container1.style.zIndex = "2";
    }
    const streetViewService = new window.google.maps.StreetViewService();
    const googleEvent = window.google.maps.event;
    const listeners = [];
    const cleanupFns = [];
    const nativeLinkCache = new Map();
    const panorama = new window.google.maps.StreetViewPanorama(container1, {
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
    });

    if (container2) {
        container2.style.display = "none";
        container2.style.opacity = "0";
        container2.style.zIndex = "1";
    }

    let activePanoId = "";
    let previousNativePanoId = "";
    let latestTarget = null;
    let pauseAutoUntil = 0;
    let lastGpsLookupDistance = -1;
    let lastGpsLookupTime = 0;
    let lastCatchUpTime = 0;
    let lastNativePanoSwitchTime = -Infinity;
    let lastNativePanoSwitchDistanceMeters = -Infinity;
    let gpsLookupGeneration = 0;
    let panoLoad = null;
    let cancelReadyWait = null;
    let povAnimationFrame = null;

    bindUserInteractionPause(container1);

    function update(target) {
        if (!isStreetViewTarget(target)) return { navigation: "waiting" };
        latestTarget = target;

        if (Date.now() < pauseAutoUntil) {
            return { navigation: "user-paused" };
        }

        if (isPanoLoading()) {
            return { navigation: "pano-loading", pano: panoLoad.pano };
        }

        const route = target.route;
        const currentDistanceMeters = target.distanceMeters;
        const hasRouteContext = hasRoute(route) && Number.isFinite(currentDistanceMeters);
        const forwardLink = hasRouteContext
            ? findRouteAlignedNativeLink(target.heading)
            : null;

        if (forwardLink) {
            if (forwardLink.pending) {
                return { navigation: "pano-waiting" };
            }
            const nativeMove = moveToNativeLinkWhenRouteCatchesUp(forwardLink, target);
            if (nativeMove) return nativeMove;
            return { navigation: "pano-waiting" };
        }

        const activePosition = readLatLng(panorama.getPosition?.());
        if (hasRouteContext
            && shouldGpsCatchUp(activePosition, target, Date.now())) {
            lastCatchUpTime = Date.now();
            lookupGpsPanorama(target, "gps-catch-up");
            return { navigation: "gps-catch-up" };
        }

        if (shouldLookupGps(target, Date.now())) {
            lookupGpsPanorama(target, activePanoId ? "gps-fallback" : "gps-initial");
            return { navigation: "gps-lookup" };
        }

        // Do not steer within a panorama. The next successful pano handoff owns
        // the one-time POV update, so route sampling cannot make the view sway.
        return { navigation: "pano-waiting" };
    }

    function bindUserInteractionPause(container) {
        if (!container) return;
        const pause = () => {
            pauseAutoUntil = Date.now() + USER_INTERACTION_PAUSE_MS;
            cancelPovAnimation();
            trace("user-pause", "用户交互后暂缓自动更新");
        };
        container.addEventListener("pointerdown", pause);
        container.addEventListener("wheel", pause, { passive: true });
        container.addEventListener("touchstart", pause, { passive: true });
        cleanupFns.push(() => {
            container.removeEventListener("pointerdown", pause);
            container.removeEventListener("wheel", pause);
            container.removeEventListener("touchstart", pause);
        });
    }

    function findRouteAlignedNativeLink(routeHeading) {
        const currentPanoId = panorama.getPano?.() || activePanoId;
        if (!currentPanoId) return null;
        const link = chooseRouteAlignedLink(
            panorama.getLinks?.() ?? [],
            routeHeading,
            currentPanoId,
            previousNativePanoId ? [previousNativePanoId] : []
        );
        if (!link) return null;

        const cached = nativeLinkCache.get(link.pano);
        if (cached?.position) return { ...link, position: cached.position };
        if (!cached?.pending) {
            preloadNativePano(link.pano, routeHeading, previousNativePanoId, getNativeLookaheadHopCount(latestTarget?.speedKph));
        }
        return { pending: true };
    }

    function preloadNativePano(panoId, routeHeading, blockedPanoId, remainingHops) {
        const existing = nativeLinkCache.get(panoId);
        if (existing?.pending || existing?.position) return;

        nativeLinkCache.set(panoId, { pending: true });
        requestPanorama({ pano: panoId }, (data, status) => {
            if (status !== window.google.maps.StreetViewStatus.OK || !data?.location?.latLng) {
                nativeLinkCache.delete(panoId);
                return;
            }
            const entry = {
                position: readLatLng(data.location.latLng),
                links: data.links ?? []
            };
            nativeLinkCache.set(panoId, entry);
            trace("native-link-ready", `已解析前方 pano ${panoId}`, { remainingHops });

            if (remainingHops <= 1) return;
            const nextLink = chooseRouteAlignedLink(entry.links, routeHeading, panoId, blockedPanoId ? [blockedPanoId] : []);
            if (nextLink) {
                preloadNativePano(nextLink.pano, routeHeading, panoId, remainingHops - 1);
            }
        });
    }

    function moveToNativeLinkWhenRouteCatchesUp(link, target) {
        const targetDistanceMeters = getRouteDistanceAtPosition(target.route, link.position);
        if (!Number.isFinite(targetDistanceMeters)
            || targetDistanceMeters > target.distanceMeters + NATIVE_PANO_ROUTE_LEAD_METERS) {
            trace("native-wait", "等待模拟位置追上前方 pano", {
                pano: link.pano,
                routeDistanceMeters: Math.round(target.distanceMeters),
                targetRouteDistanceMeters: Number.isFinite(targetDistanceMeters)
                    ? Math.round(targetDistanceMeters)
                    : null
            });
            return null;
        }

        const now = Date.now();
        if (shouldThrottleNativePanoSwitch({
            currentDistanceMeters: target.distanceMeters,
            lastSwitchDistanceMeters: lastNativePanoSwitchDistanceMeters,
            elapsedSinceLastSwitchMs: now - lastNativePanoSwitchTime
        })) {
            trace("native-throttled", "原生 pano 切换节流，保持当前画面", {
                pano: link.pano,
                routeDistanceMeters: Math.round(target.distanceMeters),
                distanceSinceLastSwitchMeters: Math.round(target.distanceMeters - lastNativePanoSwitchDistanceMeters),
                elapsedSinceLastSwitchMs: Math.round(now - lastNativePanoSwitchTime)
            });
            return null;
        }

        const currentPanoId = panorama.getPano?.() || activePanoId;
        previousNativePanoId = currentPanoId;
        activePanoId = link.pano;
        lastNativePanoSwitchTime = now;
        lastNativePanoSwitchDistanceMeters = target.distanceMeters;
        gpsLookupGeneration += 1;
        beginPanoLoad(link.pano, "native-link", getNativeLinkPovTarget(link, target));
        panorama.setPano(link.pano);
        waitForPanoReady(link.pano);
        trace("native-link", `原生 link 切换到 ${link.pano}`, {
            routeDistanceMeters: Math.round(target.distanceMeters),
            targetRouteDistanceMeters: Math.round(targetDistanceMeters)
        });
        return { navigation: "native-link" };
    }

    function lookupGpsPanorama(target, reason) {
        const lookupGeneration = ++gpsLookupGeneration;
        const startedAt = Date.now();
        lastGpsLookupDistance = target.distanceMeters;
        lastGpsLookupTime = startedAt;
        trace("gps-request", `GPS 查找 pano (${reason})`, { reason });

        requestPanorama({
            location: new window.google.maps.LatLng(target.latitude, target.longitude),
            radius: 50
        }, (data, status) => {
            if (lookupGeneration !== gpsLookupGeneration) {
                trace("gps-stale", "忽略已过期的 GPS 查找结果", { reason });
                return;
            }
            if (status !== window.google.maps.StreetViewStatus.OK || !data?.location?.pano) {
                trace("gps-failed", `GPS 查找失败: ${status}`, { reason, durationMs: Date.now() - startedAt });
                return;
            }

            const panoId = data.location.pano;
            if (panoId === activePanoId || panoId === panorama.getPano?.()) {
                activePanoId = panoId;
                return;
            }

            activePanoId = panoId;
            beginPanoLoad(panoId, reason, latestTarget ?? target);
            panorama.setPano(panoId);
            waitForPanoReady(panoId);
            trace("gps-ready", `GPS 查找到 pano ${panoId}`, { reason, durationMs: Date.now() - startedAt });
        });
    }

    function requestPanorama(request, callback) {
        streetViewService.getPanorama(request, callback);
    }

    function beginPanoLoad(pano, reason, handoffTarget = null) {
        cancelReadyWait?.();
        cancelReadyWait = null;
        panoLoad = { pano, reason, handoffTarget, startedAt: Date.now() };
    }

    function waitForPanoReady(expectedPanoId) {
        const finish = (source) => {
            if (!panoLoad || panoLoad.pano !== expectedPanoId) return;
            const durationMs = Date.now() - panoLoad.startedAt;
            const readyTarget = panoLoad.handoffTarget ?? latestTarget;
            const reason = panoLoad.reason;
            panoLoad = null;
            cancelReadyWait?.();
            cancelReadyWait = null;
            if (reason === "native-link") {
                easeProgrammaticPov(readyTarget);
            } else {
                setProgrammaticPov(readyTarget);
            }
            trace("pano-ready", `pano ${expectedPanoId} 已就绪`, { source, durationMs });
        };
        const listener = googleEvent.addListener(panorama, "status_changed", () => {
            if (panorama.getPano?.() === expectedPanoId && panorama.getStatus?.() === "OK") {
                finish("status");
            }
        });
        const timeoutId = window.setTimeout(() => finish("timeout"), PANO_READY_TIMEOUT_MS);
        cancelReadyWait = () => {
            googleEvent.removeListener(listener);
            window.clearTimeout(timeoutId);
        };
    }

    function setProgrammaticPov(target) {
        if (!target) return;
        cancelPovAnimation();
        panorama.setPov(toProgrammaticPov(target));
    }

    function easeProgrammaticPov(target) {
        if (!target) return;
        cancelPovAnimation();
        const to = toProgrammaticPov(target);
        const from = panorama.getPov?.() ?? to;
        const fromHeading = Number.isFinite(from.heading) ? from.heading : to.heading;
        const fromPitch = Number.isFinite(from.pitch) ? from.pitch : to.pitch;
        const durationMs = getPovTransitionDuration(fromHeading, to.heading);
        const startedAt = performance.now();

        const step = (now) => {
            const progress = Math.min(1, (now - startedAt) / durationMs);
            const eased = 1 - (1 - progress) **3;
            panorama.setPov({
                heading: interpolateHeading(fromHeading, to.heading, eased),
                pitch: fromPitch + (to.pitch - fromPitch) * eased
            });
            if (progress < 1) {
                povAnimationFrame = window.requestAnimationFrame(step);
            } else {
                povAnimationFrame = null;
            }
        };
        povAnimationFrame = window.requestAnimationFrame(step);
    }

    function getPovTransitionDuration(fromHeading, toHeading) {
        const headingDelta = angularDistanceDegrees(fromHeading, toHeading);
        return Math.max(
            PANO_POV_TRANSITION_MIN_MS,
            Math.min(PANO_POV_TRANSITION_MAX_MS, PANO_POV_TRANSITION_MIN_MS + headingDelta * 2)
        );
    }

    function getNativeLinkPovTarget(link, target) {
        return {
            ...target,
            heading: normalizeHeading(link.heading ?? target.heading)
        };
    }

    function cancelPovAnimation() {
        if (povAnimationFrame !== null) {
            window.cancelAnimationFrame(povAnimationFrame);
            povAnimationFrame = null;
        }
    }

    function isPanoLoading() {
        return panoLoad !== null;
    }

    function shouldLookupGps(target, now) {
        return lastGpsLookupDistance === -1
            || Math.abs((target.distanceMeters ?? 0) - lastGpsLookupDistance) >= GPS_LOOKUP_DISTANCE_METERS
            || now - lastGpsLookupTime >= GPS_LOOKUP_INTERVAL_MS;
    }

    function shouldGpsCatchUp(panoramaPosition, target, now) {
        if (!panoramaPosition || now - lastCatchUpTime < GPS_CATCH_UP_INTERVAL_MS) return false;
        return distanceBetweenMeters(panoramaPosition, {
            lat: target.latitude,
            lng: target.longitude
        }) >= GPS_CATCH_UP_DISTANCE_METERS;
    }

    function invalidateSize() {
        googleEvent.trigger?.(panorama, "resize");
    }

    function destroy() {
        cancelReadyWait?.();
        cancelPovAnimation();
        listeners.forEach((listener) => googleEvent.removeListener(listener));
        cleanupFns.forEach((cleanup) => cleanup());
        nativeLinkCache.clear();
        nativeLinkCache.clear();
    }

    function trace(event, message, data = {}) {
        onTrace?.({ event, message, at: Date.now(), ...data });
    }

    return { update, invalidateSize, destroy };
}

export function buildStreetViewTargetFromRoute(route, currentRecord) {
    if (!route || !currentRecord || !Number.isFinite(currentRecord.distanceKm)) return null;
    const distanceMeters = currentRecord.distanceKm * 1000;
    const state = getRouteStateAtDistance(route, distanceMeters);
    const speedKph = Number.isFinite(currentRecord.speedKph) ? currentRecord.speedKph : 25;
    const nextState = getRouteStateAtDistance(route, distanceMeters + 5);
    if (!state || !nextState) return null;

    return {
        route,
        distanceMeters,
        latitude: state.latitude,
        longitude: state.longitude,
        heading: bearingDegrees(state, nextState),
        gradePercent: state.gradePercent,
        speedKph
    };
}

function getRouteStateAtDistance(route, distanceMeters) {
    const points = route?.points ?? [];
    if (!points.length) return null;
    if (distanceMeters <= 0) return toRouteState(points[0]);
    if (distanceMeters >= route.totalDistanceMeters) return toRouteState(points.at(-1));
    const upperIndex = points.findIndex((point) => point.distanceMeters >= distanceMeters);
    const upper = points[Math.max(1, upperIndex)];
    const lower = points[Math.max(0, upperIndex - 1)];
    const ratio = (distanceMeters - lower.distanceMeters) / Math.max(1, upper.distanceMeters - lower.distanceMeters);
    return {
        latitude: lower.latitude + (upper.latitude - lower.latitude) * ratio,
        longitude: lower.longitude + (upper.longitude - lower.longitude) * ratio,
        gradePercent: (lower.gradePercent ?? 0) + ((upper.gradePercent ?? 0) - (lower.gradePercent ?? 0)) * ratio
    };
}

export function chooseRouteAlignedLink(links, routeHeading, currentPanoId = "", excludedPanoIds = []) {
    const excluded = new Set([currentPanoId, ...excludedPanoIds]);
    return (links ?? [])
        .filter((link) => link?.pano && !excluded.has(link.pano))
        .map((link) => ({ ...link, headingDelta: angularDistanceDegrees(routeHeading, link.heading ?? routeHeading) }))
        .filter((link) => link.headingDelta <= MAX_NATIVE_LINK_HEADING_DELTA_DEGREES)
        .sort((left, right) => left.headingDelta - right.headingDelta)[0] ?? null;
}

export function getRouteDistanceAtPosition(route, position) {
    const target = readLatLng(position);
    const points = route?.points ?? [];
    if (!target || !points.length) return null;
    let best = { distanceSquared: Number.POSITIVE_INFINITY, routeDistanceMeters: null };
    for (let index = 1; index < points.length; index += 1) {
        const start = toLocalMeters(points[index - 1], target);
        const end = toLocalMeters(points[index], target);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const ratio = Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / Math.max(1e-9, dx * dx + dy * dy)));
        const x = start.x + dx * ratio;
        const y = start.y + dy * ratio;
        const distanceSquared = x * x + y * y;
        if (distanceSquared < best.distanceSquared) {
            best = {
                distanceSquared,
                routeDistanceMeters: points[index - 1].distanceMeters
                    + (points[index].distanceMeters - points[index - 1].distanceMeters) * ratio
            };
        }
    }
    return best.routeDistanceMeters;
}

export function getNativeLookaheadHopCount(speedKph) {
    const speed = Math.max(0, Number(speedKph) || 0);
    if (speed >= THREE_HOP_LOOKAHEAD_SPEED_KPH) return NATIVE_LOOKAHEAD_MAX_HOPS;
    if (speed >= TWO_HOP_LOOKAHEAD_SPEED_KPH) return 2;
    return 1;
}

function createStableStreetViewController({ container1, container2, onTrace } = {}) {
    const streetViewService = new window.google.maps.StreetViewService();
    const googleEvent = window.google.maps.event;
    const options = {
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
    const containers = [container1, container2].filter(Boolean);
    const panoramas = containers.map((container) => new window.google.maps.StreetViewPanorama(container, options));
    let activeIndex = 0;
    let hasActivePanorama = false;
    let latestTarget = null;
    let pendingPano = null;
    let statusListener = null;
    let readyTimeoutId = null;
    let pauseAutoUntil = 0;
    const cleanupFns = [];

    containers.forEach((container, index) => setStableContainerVisibility(container, index === activeIndex));
    containers.forEach(bindStableUserInteractionPause);
    trace("controller-ready", "稳定展示 Street View controller 已创建", { mode: STREET_VIEW_MODES.STABLE });

    function update(target) {
        if (!isStreetViewTarget(target) || panoramas.length === 0) return { navigation: "waiting" };
        latestTarget = target;
        if (Date.now() < pauseAutoUntil) return { navigation: "user-paused" };
        if (pendingPano?.ready && shouldShowStablePano(target, pendingPano)) {
            showStablePano();
        }
        if (pendingPano) return { navigation: pendingPano.ready ? "stable-waiting" : "pano-loading" };

        const requestedTarget = buildStableLookaheadTarget(target, hasActivePanorama);
        const nextIndex = hasActivePanorama && panoramas.length > 1 ? (activeIndex + 1) % panoramas.length : activeIndex;
        const nextPanorama = panoramas[nextIndex];
        const startedAt = Date.now();
        pendingPano = {
            nextIndex,
            panorama: nextPanorama,
            target: requestedTarget,
            routeDistanceMeters: requestedTarget.distanceMeters,
            startedAt,
            ready: false
        };
        trace("stable-pano-request", "稳定展示请求下一张 pano", {
            currentDistanceMeters: Math.round(target.distanceMeters),
            targetDistanceMeters: Math.round(requestedTarget.distanceMeters),
            lookaheadMs: hasActivePanorama ? STABLE_PANO_UPDATE_INTERVAL_MS : 0
        });
        streetViewService.getPanorama({
            location: new window.google.maps.LatLng(requestedTarget.latitude, requestedTarget.longitude),
            radius: 50
        }, (data, status) => {
            const pending = pendingPano;
            if (!pending || pending.startedAt !== startedAt) return;
            if (status !== window.google.maps.StreetViewStatus.OK || !data?.location?.pano) {
                pendingPano = null;
                trace("stable-pano-failed", "稳定展示查询 pano 失败", { status, durationMs: Date.now() - startedAt });
                return;
            }
            const panoId = data.location.pano;
            const activePanorama = panoramas[activeIndex];
            if (hasActivePanorama && panoId === activePanorama.getPano?.()) {
                activePanorama.setPov(toProgrammaticPov(requestedTarget));
                pendingPano = null;
                return;
            }
            clearPendingReady();
            nextPanorama.setPano(panoId);
            nextPanorama.setPov(toProgrammaticPov(requestedTarget));
            statusListener = googleEvent.addListener(nextPanorama, "status_changed", () => {
                if (nextPanorama.getPano?.() !== panoId || nextPanorama.getStatus?.() !== "OK") return;
                clearPendingReady();
                // Street View has no public tile-complete event. Keep the next
                // panorama hidden briefly after status=OK so its first imagery
                // pass can settle before we perform a direct cut.
                readyTimeoutId = window.setTimeout(() => {
                    readyTimeoutId = null;
                    if (!pendingPano || pendingPano.startedAt !== startedAt) return;
                    pendingPano.ready = true;
                    pendingPano.panoId = panoId;
                    trace("stable-pano-ready", "稳定展示后台 pano 已就绪", {
                        pano: panoId,
                        durationMs: Date.now() - startedAt,
                        renderSettleMs: STABLE_PANO_RENDER_SETTLE_MS
                    });
                    if (latestTarget && shouldShowStablePano(latestTarget, pendingPano)) {
                        showStablePano();
                    }
                }, STABLE_PANO_RENDER_SETTLE_MS);
            });
            readyTimeoutId = window.setTimeout(() => {
                clearPendingReady();
                pendingPano = null;
                trace("stable-pano-timeout", "稳定展示 pano 等待超时", { pano: panoId });
            }, PANO_READY_TIMEOUT_MS);
        });
        return { navigation: "stable-lookup" };
    }

    function showStablePano() {
        const pending = pendingPano;
        if (!pending) return;
        setStableContainerVisibility(containers[pending.nextIndex], true);
        if (hasActivePanorama && pending.nextIndex !== activeIndex) {
            setStableContainerVisibility(containers[activeIndex], false);
        }
        activeIndex = pending.nextIndex;
        hasActivePanorama = true;
        pendingPano = null;
        trace("stable-pano-switch", "稳定展示切换到已预渲染 pano", {
            pano: pending.panoId,
            targetDistanceMeters: Math.round(pending.routeDistanceMeters),
            currentDistanceMeters: Math.round(latestTarget?.distanceMeters ?? 0)
        });
    }

    function invalidateSize() {
        panoramas.forEach((panorama) => googleEvent.trigger?.(panorama, "resize"));
    }

    function destroy() {
        clearPendingReady();
        cleanupFns.forEach((cleanup) => cleanup());
    }

    function bindStableUserInteractionPause(container) {
        if (!container) return;
        const pause = () => {
            pauseAutoUntil = Date.now() + USER_INTERACTION_PAUSE_MS;
            trace("user-pause", "用户交互后暂停稳定街景更新", { mode: STREET_VIEW_MODES.STABLE });
        };
        container.addEventListener("pointerdown", pause);
        container.addEventListener("wheel", pause, { passive: true });
        container.addEventListener("touchstart", pause, { passive: true });
        cleanupFns.push(() => {
            container.removeEventListener("pointerdown", pause);
            container.removeEventListener("wheel", pause);
            container.removeEventListener("touchstart", pause);
        });
    }

    function clearPendingReady() {
        if (statusListener) googleEvent.removeListener(statusListener);
        if (readyTimeoutId !== null) window.clearTimeout(readyTimeoutId);
        statusListener = null;
        readyTimeoutId = null;
    }

    function trace(event, message, data = {}) {
        onTrace?.({ event, message, at: Date.now(), ...data });
    }

    return { update, invalidateSize, destroy };
}

function buildStableLookaheadTarget(target, shouldLookAhead) {
    if (!shouldLookAhead || !hasRoute(target.route)) return target;
    const speedMetersPerSecond = Math.max(0, Number(target.speedKph) || 0) / 3.6;
    const futureDistanceMeters = Math.min(
        target.route.totalDistanceMeters,
        target.distanceMeters + speedMetersPerSecond * (STABLE_PANO_UPDATE_INTERVAL_MS / 1000)
    );
    const state = getRouteStateAtDistance(target.route, futureDistanceMeters);
    const nextState = getRouteStateAtDistance(target.route, futureDistanceMeters + 5);
    if (!state || !nextState) return target;
    return {
        ...target,
        distanceMeters: futureDistanceMeters,
        latitude: state.latitude,
        longitude: state.longitude,
        gradePercent: state.gradePercent,
        heading: bearingDegrees(state, nextState)
    };
}

function shouldShowStablePano(target, pending) {
    return !pending
        ? false
        : !Number.isFinite(pending.routeDistanceMeters)
            || target.distanceMeters >= pending.routeDistanceMeters - STABLE_PANO_SWITCH_LEAD_METERS;
}

function setStableContainerVisibility(container, visible) {
    if (!container) return;
    container.style.display = "";
    container.style.transition = "none";
    container.style.opacity = visible ? "1" : "0";
    container.style.zIndex = visible ? "2" : "1";
}

export function shouldThrottleNativePanoSwitch({
    currentDistanceMeters,
    lastSwitchDistanceMeters,
    elapsedSinceLastSwitchMs,
    minIntervalMs = NATIVE_PANO_MIN_SWITCH_INTERVAL_MS,
    minDistanceMeters = NATIVE_PANO_MIN_SWITCH_DISTANCE_METERS
} = {}) {
    if (!Number.isFinite(currentDistanceMeters)
        || !Number.isFinite(lastSwitchDistanceMeters)
        || !Number.isFinite(elapsedSinceLastSwitchMs)) {
        return false;
    }

    return elapsedSinceLastSwitchMs < minIntervalMs
        || currentDistanceMeters - lastSwitchDistanceMeters < minDistanceMeters;
}

export function interpolateHeading(fromHeading, toHeading, progress) {
    const delta = ((toHeading - fromHeading + 540) % 360) - 180;
    return normalizeHeading(fromHeading + delta * Math.max(0, Math.min(1, progress)));
}

function hasRoute(route) {
    return Array.isArray(route?.points) && route.points.length > 1;
}

function isStreetViewTarget(target) {
    return Number.isFinite(target?.latitude)
        && Number.isFinite(target?.longitude)
        && Number.isFinite(target?.heading);
}

function toRouteState(point) {
    return Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
        ? { latitude: point.latitude, longitude: point.longitude, gradePercent: point.gradePercent ?? 0 }
        : null;
}

function readLatLng(value) {
    if (!value) return null;
    const lat = typeof value.lat === "function" ? value.lat() : value.lat;
    const lng = typeof value.lng === "function" ? value.lng() : value.lng;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function toLocalMeters(point, origin) {
    const lat = point.latitude ?? point.lat;
    const lng = point.longitude ?? point.lng;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(origin.lat * Math.PI / 180);
    return { x: (lng - origin.lng) * metersPerDegreeLng, y: (lat - origin.lat) * metersPerDegreeLat };
}

function distanceBetweenMeters(left, right) {
    const a = toLocalMeters(left, right);
    return Math.hypot(a.x, a.y);
}

function bearingDegrees(from, to) {
    const lat1 = from.latitude * Math.PI / 180;
    const lat2 = to.latitude * Math.PI / 180;
    const deltaLng = (to.longitude - from.longitude) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function angularDistanceDegrees(left, right) {
    return Math.abs(((left - right + 540) % 360) - 180);
}

function normalizeHeading(value) {
    return ((value % 360) + 360) % 360;
}

function toProgrammaticPov(target) {
    return {
        heading: normalizeHeading(target.heading),
        pitch: Math.atan((target.gradePercent ?? 0) / 100) * 180 / Math.PI
    };
}
