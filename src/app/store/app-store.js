export function createStore(initialState) {
    let state = structuredClone(initialState);
    const listeners = new Set();

    function getState() {
        return state;
    }

    function setState(updater) {
        const nextState = typeof updater === "function" ? updater(state) : { ...state, ...updater };
        state = nextState;
        listeners.forEach((listener) => listener(state));
        return state;
    }

    function subscribe(listener) {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
    }

    return {
        getState,
        setState,
        subscribe
    };
}
