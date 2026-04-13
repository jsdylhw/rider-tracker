export function createUiService({ store }) {
    function setUiMode(mode) {
        store.setState((state) => ({
            ...state,
            uiMode: mode
        }));
    }

    function updatePipConfig(key, checked) {
        store.setState((state) => ({
            ...state,
            pipConfig: {
                ...state.pipConfig,
                [key]: checked
            }
        }));
    }

    return {
        setUiMode,
        updatePipConfig
    };
}