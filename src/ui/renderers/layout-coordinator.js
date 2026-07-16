export function createLayoutCoordinator({ elements }) {
    function render(state) {
        const mode = state.uiMode;

        if (elements.viewHome) elements.viewHome.hidden = mode !== "home";
        if (elements.viewLive) elements.viewLive.hidden = mode !== "live";
        if (elements.viewActivityDetail) elements.viewActivityDetail.hidden = mode !== "activity-detail";

    }

    return {
        render
    };
}
