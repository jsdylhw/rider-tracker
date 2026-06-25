export function isStreetViewDebugEnabled() {
    if (typeof window === "undefined") return false;

    try {
        const params = new URLSearchParams(window.location?.search ?? "");
        if (params.get("debugStreetView") === "1" || params.get("streetViewDebug") === "1") {
            return true;
        }
        return window.localStorage?.getItem("riderTrackerDebugStreetView") === "1";
    } catch {
        return false;
    }
}
