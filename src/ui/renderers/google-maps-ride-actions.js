import { capabilityMessage } from "../../domain/agent/agent-capabilities.js";

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
    let actionState = { streetViewLoading: false, elevationLoading: false };
    let debugStreetViewFallback = false;
    let streetViewRequestGeneration = 0;

    function bindEvents(store) {
        elements.loadStreetViewBtn?.addEventListener("click", () => void requestStreetView(store));
        elements.requestRouteElevationBtn?.addEventListener("click", () => void requestRouteElevation(store));
    }

    function hasStreetViewPresentation() {
        return visuals.hasStreetView() || (streetViewDebugEnabled && debugStreetViewFallback);
    }

    function isDebugFallback() {
        return debugStreetViewFallback;
    }

    function syncButtons({ route, ride, agentCapabilities }) {
        const hasCoordinates = hasCoordinateRoute(route);
        const streetViewAvailable = isCapabilityAvailable(agentCapabilities, "street_view");
        const canLoadStreetView = streetViewAvailable
            && hasCoordinates
            && !visuals.hasStreetView()
            && (ride.isActive || streetViewDebugEnabled);
        if (elements.loadStreetViewBtn) {
            elements.loadStreetViewBtn.hidden = !hasCoordinates || visuals.hasStreetView();
            elements.loadStreetViewBtn.disabled = !canLoadStreetView || actionState.streetViewLoading;
            elements.loadStreetViewBtn.title = streetViewAvailable
                ? ""
                : capabilityMessage(agentCapabilities, "street_view");
            elements.loadStreetViewBtn.textContent = actionState.streetViewLoading
                ? "正在加载街景..."
                : debugStreetViewFallback ? "重新加载街景" : "加载街景";
        }

        const isExplorationRoute = route?.source === "osm-exploration";
        const hasElevationData = route?.hasElevationData === true;
        const routeLoading = route?.isLoading === true;
        const elevationAvailable = isCapabilityAvailable(agentCapabilities, "google_elevation_reference");
        const canRequestElevation = elevationAvailable
            && isExplorationRoute
            && hasCoordinates
            && !hasElevationData
            && !routeLoading;
        if (elements.requestRouteElevationBtn) {
            elements.requestRouteElevationBtn.hidden = !isExplorationRoute || !hasCoordinates;
            elements.requestRouteElevationBtn.disabled = !canRequestElevation || actionState.elevationLoading || ride.isActive;
            elements.requestRouteElevationBtn.title = elevationAvailable
                ? "Google 估算海拔仅用于路线参考，不能启用坡度模拟。"
                : capabilityMessage(agentCapabilities, "google_elevation_reference");
            elements.requestRouteElevationBtn.textContent = hasElevationData
                ? "参考海拔已加载"
                : actionState.elevationLoading
                    ? "正在请求参考海拔..."
                    : routeLoading
                        ? "路线处理中"
                        : ride.isActive
                            ? "骑行中不可请求参考海拔"
                            : "请求参考海拔";
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

        const requestGeneration = ++streetViewRequestGeneration;
        const apiKey = await resolveGoogleMapsApiKey("加载街景");
        if (!apiKey || requestGeneration !== streetViewRequestGeneration) return;
        actionState = { ...actionState, streetViewLoading: true };
        onRefresh();
        try {
            elements.svPano1.style.display = "";
            const result = await enableStreetView();
            if (requestGeneration !== streetViewRequestGeneration) return;

            debugStreetViewFallback = false;
            elements.streetViewContainer.classList.remove("streetview-debug-empty");
            elements.streetViewContainer.style.display = "block";
            setStatus(store, "街景已加载，可以进入沉浸街景。");
        } catch (error) {
            if (requestGeneration !== streetViewRequestGeneration) return;
            console.warn("街景加载失败，继续使用地图骑行模式。", error);
            if (streetViewDebugEnabled) {
                debugStreetViewFallback = true;
                elements.svPano1.style.display = "none";
                elements.streetViewContainer.classList.add("streetview-debug-empty");
                elements.streetViewContainer.style.display = "block";
                setStatus(store, `街景调试：Google 街景未加载（${error?.message ?? "API Key 或网络错误"}），已进入黑屏预览。`);
                onEnterDebugFallback(store);
                return;
            }
            setStatus(store, `街景加载失败：${error?.message ?? "请检查 config.yaml 中的 Google API 与网络。"}`);
            onStreetViewFailure();
        } finally {
            if (requestGeneration === streetViewRequestGeneration) {
                actionState = { ...actionState, streetViewLoading: false };
                onRefresh();
            }
        }

        async function enableStreetView() {
            const result = await visuals.enableConfiguredStreetView({
                container1: elements.svPano1,
                container2: elements.svPano2
            });
            if (!result?.enabled) throw new Error("街景服务未能初始化。");
            return result;
        }
    }

    function resetStreetViewPresentation() {
        streetViewRequestGeneration += 1;
        actionState = { ...actionState, streetViewLoading: false };
        debugStreetViewFallback = false;
        elements.streetViewContainer?.classList.remove("streetview-debug-empty");
        if (elements.streetViewContainer) elements.streetViewContainer.style.display = "none";
        if (elements.svPano1) elements.svPano1.style.display = "";
        if (elements.svPano2) elements.svPano2.style.display = "";
    }

    async function requestRouteElevation(store) {
        const state = store.getState();
        if (!hasCoordinateRoute(state.route)
            || state.route.hasElevationData
            || state.route.isLoading
            || state.liveRide.isActive
            || actionState.elevationLoading) return;

        const apiKey = await resolveGoogleMapsApiKey("请求路线参考海拔");
        if (!apiKey) return;
        actionState = { ...actionState, elevationLoading: true };
        onRefresh();
        try {
            await onRequestRouteElevation();
        } catch (error) {
            console.warn("路线海拔请求失败", error);
        } finally {
            actionState = { ...actionState, elevationLoading: false };
            onRefresh();
        }
    }

    async function resolveGoogleMapsApiKey(featureLabel) {
        const apiKey = visuals.getGoogleMapsConfig?.()?.apiKey ?? "";
        if (apiKey) return apiKey;
        return requestGoogleMapsApiKey({ featureLabel });
    }

    return { bindEvents, hasStreetViewPresentation, isDebugFallback, resetStreetViewPresentation, syncButtons };
}

function isCapabilityAvailable(agentCapabilities, capability) {
    return agentCapabilities === undefined
        || agentCapabilities?.capabilities?.[capability] === true;
}

function hasCoordinateRoute(route) {
    return Array.isArray(route?.points)
        && route.points.some((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

function setStatus(store, statusText) {
    store?.setState?.((state) => ({ ...state, statusText }));
}
