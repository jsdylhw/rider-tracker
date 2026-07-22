export function createRouteOperationCoordinator({ store }) {
    let latestRequestId = 0;

    function ensureRouteEditingAllowed() {
        if (!store.getState().liveRide?.isActive) {
            return true;
        }
        store.setState((state) => ({
            ...state,
            statusText: "骑行进行中，路线已锁定。请先结束本次骑行后再修改。"
        }));
        return false;
    }

    function invalidateRequests() {
        latestRequestId += 1;
        return latestRequestId;
    }

    function isCurrent(requestId) {
        return requestId === latestRequestId;
    }

    function beginRouteRequest(statusText) {
        const requestId = invalidateRequests();
        let loadingRoute = null;
        store.setState((state) => {
            if (!state.route) {
                return { ...state, statusText };
            }
            loadingRoute = { ...state.route, isLoading: true };
            return { ...state, route: loadingRoute, statusText };
        });
        return { requestId, route: loadingRoute };
    }

    function clearRouteLoading(statusText = null) {
        store.setState((state) => {
            if (state.route?.isLoading !== true) {
                return statusText === null ? state : { ...state, statusText };
            }
            return {
                ...state,
                route: { ...state.route, isLoading: false },
                ...(statusText === null ? {} : { statusText })
            };
        });
    }

    function discardAfterRideStart(statusText) {
        if (!store.getState().liveRide?.isActive) {
            return false;
        }
        clearRouteLoading(statusText);
        return true;
    }

    function commitRoute(route, statusText) {
        store.setState((state) => ({ ...state, route, statusText }));
    }

    return {
        ensureRouteEditingAllowed,
        invalidateRequests,
        isCurrent,
        beginRouteRequest,
        clearRouteLoading,
        discardAfterRideStart,
        commitRoute
    };
}
