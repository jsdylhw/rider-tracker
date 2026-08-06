export function createGoogleMapsRideActions({
    elements,
    visuals,
    streetViewDebugEnabled,
    onRequestRouteElevation,
    requestGoogleMapsApiKey,
    onRefresh,
    onEnterDebugFallback,
    onStreetViewFailure
}) {
    let actionState = { streetViewLoading: false, elevationLoading: false, forceKeyPrompt: false };
    let debugStreetViewFallback = false;

    function bindEvents(store) {
        elements.loadStreetViewBtn?.addEventListener("click", () => void requestStreetView(store));
        elements.requestRouteElevationBtn?.addEventListener("click", () => void requestRouteElevation(store));
        elements.downloadStreetViewTraceBtn?.addEventListener("click", () => visuals.downloadStreetViewTrace?.());
    }

    function hasStreetViewPresentation() {
        return visuals.hasStreetView() || (streetViewDebugEnabled && debugStreetViewFallback);
    }

    function isDebugFallback() {
        return debugStreetViewFallback;
    }

    function syncButtons({ route, ride }) {
        const hasCoordinates = hasCoordinateRoute(route);
        const canLoadStreetView = hasCoordinates && !visuals.hasStreetView() && (ride.isActive || streetViewDebugEnabled);
        if (elements.loadStreetViewBtn) {
            elements.loadStreetViewBtn.hidden = !canLoadStreetView;
            elements.loadStreetViewBtn.disabled = actionState.streetViewLoading;
            elements.loadStreetViewBtn.textContent = actionState.streetViewLoading
                ? "正在加载街景..."
                : debugStreetViewFallback ? "重新加载街景" : "加载街景";
        }
        if (elements.downloadStreetViewTraceBtn) {
            elements.downloadStreetViewTraceBtn.hidden = !visuals.hasStreetView();
        }

        const isExplorationRoute = route?.source === "osm-exploration";
        const hasElevationData = route?.hasElevationData === true;
        const routeLoading = route?.isLoading === true;
        const canRequestElevation = isExplorationRoute && hasCoordinates && !hasElevationData && !routeLoading;
        if (elements.requestRouteElevationBtn) {
            elements.requestRouteElevationBtn.hidden = !isExplorationRoute || !hasCoordinates;
            elements.requestRouteElevationBtn.disabled = !canRequestElevation || actionState.elevationLoading || ride.isActive;
            elements.requestRouteElevationBtn.textContent = hasElevationData
                ? "探索路线海拔已加载"
                : actionState.elevationLoading
                    ? "正在请求海拔..."
                    : routeLoading
                        ? "路线处理中"
                        : ride.isActive
                            ? "骑行中不可请求海拔"
                            : "请求探索路线海拔";
        }
    }

    async function requestStreetView(store) {
        const state = store.getState();
        if (!hasCoordinateRoute(state.route)) return;
        if (!state.liveRide.isActive && !streetViewDebugEnabled) {
            alert("请先开始骑行，或使用 ?debugStreetView=1 打开街景调试模式。");
            return;
        }
        if (actionState.streetViewLoading) return;

        const apiKey = await resolveGoogleMapsApiKey("加载街景");
        if (!apiKey) return;
        actionState = { ...actionState, streetViewLoading: true };
        onRefresh();
        try {
            elements.svPano1.style.display = "";
            const result = await visuals.enableConfiguredStreetView({
                container1: elements.svPano1,
                container2: elements.svPano2
            });
            if (!result?.enabled) throw new Error("街景服务未能初始化。");

            debugStreetViewFallback = false;
            elements.streetViewContainer.classList.remove("streetview-debug-empty");
            elements.streetViewContainer.style.display = "block";
            setStatus(store, "街景已加载，可以进入沉浸街景。");
        } catch (error) {
            console.warn("街景加载失败，继续使用地图骑行模式。", error);
            actionState = { ...actionState, forceKeyPrompt: true };
            if (streetViewDebugEnabled) {
                debugStreetViewFallback = true;
                elements.svPano1.style.display = "none";
                elements.streetViewContainer.classList.add("streetview-debug-empty");
                elements.streetViewContainer.style.display = "block";
                setStatus(store, `街景调试：Google 街景未加载（${error?.message ?? "API Key 或网络错误"}），已进入黑屏预览。`);
                onEnterDebugFallback(store);
                return;
            }
            setStatus(store, `街景加载失败：${error?.message ?? "请检查 Google Maps API Key 与网络。"}`);
            onStreetViewFailure();
        } finally {
            actionState = { ...actionState, streetViewLoading: false };
            onRefresh();
        }
    }

    async function requestRouteElevation(store) {
        const state = store.getState();
        if (!hasCoordinateRoute(state.route)
            || state.route.hasElevationData
            || state.route.isLoading
            || state.liveRide.isActive
            || actionState.elevationLoading) return;

        const apiKey = await resolveGoogleMapsApiKey("请求路线海拔");
        if (!apiKey) return;
        actionState = { ...actionState, elevationLoading: true };
        onRefresh();
        try {
            await onRequestRouteElevation();
        } catch (error) {
            console.warn("路线海拔请求失败", error);
            actionState = { ...actionState, forceKeyPrompt: true };
        } finally {
            actionState = { ...actionState, elevationLoading: false };
            onRefresh();
        }
    }

    async function resolveGoogleMapsApiKey(featureLabel) {
        const apiKey = visuals.getGoogleMapsConfig?.()?.apiKey ?? "";
        const shouldPrompt = actionState.forceKeyPrompt
            || (streetViewDebugEnabled && featureLabel === "加载街景");
        if (apiKey && !shouldPrompt) return apiKey;

        const confirmedKey = await requestGoogleMapsApiKey({ featureLabel, force: shouldPrompt });
        if (confirmedKey) actionState = { ...actionState, forceKeyPrompt: false };
        return confirmedKey;
    }

    return { bindEvents, hasStreetViewPresentation, isDebugFallback, syncButtons };
}

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function setStatus(store, statusText) {
    store?.setState?.((state) => ({ ...state, statusText }));
}
