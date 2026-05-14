export function sendFitBeacon({
    fitBytes,
    filename,
    session,
    name = session?.exportMetadata?.activityName,
    sportType = "VirtualRide",
    serverUrl = globalThis.location?.origin || ""
} = {}) {
    if (!fitBytes || !session || !serverUrl) {
        return false;
    }

    const nav = globalThis.navigator;
    if (!nav || typeof nav.sendBeacon !== "function") {
        return false;
    }

    const payload = fitBytes instanceof Uint8Array ? fitBytes : new Uint8Array(fitBytes);
    const fitBlob = new Blob([payload], { type: "application/vnd.ant.fit" });
    const formData = new FormData();
    formData.append("file", fitBlob, filename || "activity.fit");
    formData.append("session", JSON.stringify(session));
    if (name) formData.append("name", name);
    if (sportType) formData.append("sportType", sportType);

    return nav.sendBeacon(`${serverUrl}/api/activities/fit-beacon`, formData);
}
