const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";

export async function fetchGoogleBicycleRoute({
    apiKey,
    waypoints,
    fetchImpl = globalThis.fetch
}) {
    if (!apiKey) {
        throw new Error("请先填写 Google Maps API Key。");
    }
    if (typeof fetchImpl !== "function") {
        throw new Error("当前浏览器不支持 Google Routes 请求。");
    }

    const points = normalizeWaypoints(waypoints);
    if (points.length < 2) {
        throw new Error("请至少在地图上选择两个不同的点。");
    }

    const bicycleRoute = await requestRoute({
        apiKey,
        points,
        travelMode: "BICYCLE",
        fetchImpl
    });
    const plannedRoute = bicycleRoute ?? await requestRoute({
        apiKey,
        points,
        travelMode: "DRIVE",
        fetchImpl
    });
    if (!plannedRoute) {
        throw new Error("Google Routes 未找到可用的骑行或道路路线。所选区域的骑行路线覆盖可能不足，请调整选点后重试。");
    }

    const path = decodePolyline(plannedRoute.encodedPolyline);
    if (path.length < 2) {
        throw new Error("Google Routes API 返回的路线点不足。");
    }

    return {
        path,
        distanceMeters: Number(plannedRoute.distanceMeters) || null,
        estimatedDuration: plannedRoute.duration ?? null,
        travelMode: plannedRoute.travelMode
    };
}

async function requestRoute({ apiKey, points, travelMode, fetchImpl }) {
    const response = await fetchImpl(ROUTES_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": FIELD_MASK
        },
        body: JSON.stringify({
            origin: toWaypoint(points[0]),
            destination: toWaypoint(points.at(-1)),
            intermediates: points.slice(1, -1).map(toWaypoint),
            travelMode,
            computeAlternativeRoutes: false,
            languageCode: "zh-CN",
            units: "METRIC",
            polylineQuality: "HIGH_QUALITY",
            ...(travelMode === "DRIVE" ? {
                routeModifiers: { avoidHighways: true }
            } : {})
        })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Google Routes API HTTP ${response.status}：${formatApiError(data)}`);
    }

    const route = data?.routes?.find((candidate) => candidate?.polyline?.encodedPolyline);
    if (!route) return null;
    return {
        encodedPolyline: route.polyline.encodedPolyline,
        distanceMeters: route.distanceMeters,
        duration: route.duration,
        travelMode
    };
}

export function decodePolyline(encoded) {
    let index = 0;
    let latitude = 0;
    let longitude = 0;
    const coordinates = [];

    while (index < encoded.length) {
        const nextLatitude = decodePolylineValue(encoded, index);
        index = nextLatitude.nextIndex;
        latitude += nextLatitude.delta;
        const nextLongitude = decodePolylineValue(encoded, index);
        index = nextLongitude.nextIndex;
        longitude += nextLongitude.delta;
        coordinates.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
    }

    return coordinates;
}

function decodePolylineValue(encoded, startIndex) {
    let result = 0;
    let shift = 0;
    let index = startIndex;
    let byte = 0;
    do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return {
        delta: (result & 1) ? ~(result >> 1) : (result >> 1),
        nextIndex: index
    };
}

function normalizeWaypoints(waypoints) {
    return (waypoints ?? []).map((point) => {
        const lat = Number(point?.lat ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            throw new Error("地图选点坐标无效。");
        }
        return { lat, lng };
    });
}

function toWaypoint(point) {
    return {
        location: {
            latLng: {
                latitude: point.lat,
                longitude: point.lng
            }
        }
    };
}

function formatApiError(data) {
    return data?.error?.message ?? "请确认已启用 Routes API、Key 限制和配额设置。";
}
