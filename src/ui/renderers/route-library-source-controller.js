export function createRouteLibrarySourceController({
    elements,
    onShowLocalRoutes = () => {},
    onShowStravaRoutes = () => {}
}) {
    let source = "local";

    function bindEvents() {
        elements.routeLibraryLocalTabBtn?.addEventListener("click", () => setSource("local"));
        elements.routeLibraryStravaTabBtn?.addEventListener("click", () => setSource("strava"));
        elements.routeLibraryGpxTabBtn?.addEventListener("click", () => setSource("gpx"));
        render();
    }

    function setSource(nextSource) {
        if (!["local", "strava", "gpx"].includes(nextSource)) return;
        source = nextSource;
        render();
        if (source === "local") void onShowLocalRoutes();
        if (source === "strava") void onShowStravaRoutes();
    }

    function render() {
        setVisible(elements.routeLibraryLocalPanel, source === "local");
        setVisible(elements.routeLibraryStravaPanel, source === "strava");
        setVisible(elements.routeLibraryGpxPanel, source === "gpx");
        setActive(elements.routeLibraryLocalTabBtn, source === "local");
        setActive(elements.routeLibraryStravaTabBtn, source === "strava");
        setActive(elements.routeLibraryGpxTabBtn, source === "gpx");
    }

    return { bindEvents, setSource, getSource: () => source };
}

function setVisible(element, visible) {
    if (element) element.hidden = !visible;
}

function setActive(element, active) {
    element?.classList?.toggle("active", active);
}
