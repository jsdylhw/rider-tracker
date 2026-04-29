export function createActivityDetailView({
    onSetUiMode,
    onConnectStrava,
    onUploadActivityFit
}) {
    const elements = {
        viewActivityDetail: document.getElementById("view-activity-detail"),
        activityDetailContent: document.getElementById("activityDetailContent"),
        activityDetailBackBtn: document.getElementById("activityDetailBackBtn")
    };

    bind(elements.activityDetailBackBtn, "click", () => onSetUiMode("home"));
    bind(elements.activityDetailContent, "click", (event) => {
        const action = event.target?.dataset?.activityPageAction;
        if (!action) {
            return;
        }

        if (action === "connect-strava") {
            onConnectStrava();
        }
        if (action === "upload-strava") {
            onUploadActivityFit();
        }
    });

    return { elements };
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}
