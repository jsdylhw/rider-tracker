const GPX_MIME_TYPE = "application/gpx+xml;charset=utf-8";

export function canExportRouteAsGpx(route) {
    return route?.isLoading !== true
        && Number(route?.totalDistanceMeters) > 0
        && exportablePoints(route).length >= 2;
}

export function serializeRouteToGpx(route) {
    const points = exportablePoints(route);
    if (route?.isLoading === true) {
        throw new Error("路线仍在处理中，请等待完成后再导出。");
    }
    if (!(Number(route?.totalDistanceMeters) > 0) || points.length < 2) {
        throw new Error("当前路线没有可导出的坐标轨迹。");
    }

    const name = normalizedRouteName(route?.name);
    const includeElevation = route?.hasElevationData === true;
    const trackPoints = points.map((point) => {
        const elevation = Number(point.elevationMeters);
        const elevationXml = includeElevation && Number.isFinite(elevation)
            ? `\n        <ele>${formatElevation(elevation)}</ele>`
            : "";
        return `      <trkpt lat="${formatCoordinate(point.latitude)}" lon="${formatCoordinate(point.longitude)}">${elevationXml}\n      </trkpt>`;
    }).join("\n");

    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<gpx version=\"1.1\" creator=\"Rider Tracker\" xmlns=\"http://www.topografix.com/GPX/1/1\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd\">",
        "  <metadata>",
        `    <name>${escapeXml(name)}</name>`,
        "  </metadata>",
        "  <trk>",
        `    <name>${escapeXml(name)}</name>`,
        "    <type>cycling</type>",
        "    <trkseg>",
        trackPoints,
        "    </trkseg>",
        "  </trk>",
        "</gpx>",
        ""
    ].join("\n");
}

export function routeGpxFileName(route) {
    const safeName = normalizedRouteName(route?.name)
        .replace(/[\\/:*?"<>|%]/g, "-")
        .replace(/[.\s]+$/g, "")
        .trim()
        .slice(0, 120);
    return `${safeName || "Rider-Tracker-Route"}.gpx`;
}

export { GPX_MIME_TYPE };

function exportablePoints(route) {
    if (!Array.isArray(route?.points)) return [];
    return route.points
        .map((point) => ({
            ...point,
            latitude: Number(point?.latitude ?? point?.lat),
            longitude: Number(point?.longitude ?? point?.lng)
        }))
        .filter((point) => Number.isFinite(point.latitude)
            && point.latitude >= -90 && point.latitude <= 90
            && Number.isFinite(point.longitude)
            && point.longitude >= -180 && point.longitude <= 180);
}

function normalizedRouteName(value) {
    const name = String(value ?? "").trim();
    return name || "Rider Tracker Route";
}

function formatCoordinate(value) {
    return Number(value).toFixed(6);
}

function formatElevation(value) {
    return Number(value).toFixed(1);
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
