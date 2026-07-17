export const SAN_FRANCISCO_CENTER = { lat: 37.7749, lng: -122.4194 };
export const UJI_CENTER = { lat: 34.8898, lng: 135.8104 };
export const DEFAULT_CENTER = SAN_FRANCISCO_CENTER;
export const WEB_MERCATOR_MAX_LAT = 85.05112878;
export const NETWORK_SIZE_KM = 10;
export const SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL = "./fixtures/san-francisco-road-network.json";
export const UJI_ROAD_NETWORK_CACHE_URL = "./fixtures/uji-road-network.json";
export const ROAD_NETWORK_PRESETS = [
    {
        id: "san-francisco",
        label: "旧金山",
        center: SAN_FRANCISCO_CENTER,
        cacheUrl: SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL
    },
    {
        id: "uji",
        label: "宇治",
        center: UJI_CENTER,
        cacheUrl: UJI_ROAD_NETWORK_CACHE_URL
    }
];
export const OVERPASS_REQUEST_TIMEOUT_MS = 8000;
export const OVERPASS_TOTAL_TIMEOUT_MS = 20000;
export const INTERSECTIONS_PER_SEGMENT = 1;
export const ALLOWED_HIGHWAY_PATTERN = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$";

export function normalizeLatLng(point) {
    return {
        lat: clamp(point.lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        lng: normalizeLongitude(point.lng)
    };
}

export function normalizeLongitude(longitude) {
    return ((longitude + 540) % 360) - 180;
}

export function buildBoundsAroundCenter(center, sizeKm = NETWORK_SIZE_KM) {
    const halfMeters = sizeKm * 500;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(toRadians(center.lat));
    return {
        south: clamp(center.lat - halfMeters / metersPerDegreeLat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        west: clampLongitude(center.lng - halfMeters / metersPerDegreeLng),
        north: clamp(center.lat + halfMeters / metersPerDegreeLat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT),
        east: clampLongitude(center.lng + halfMeters / metersPerDegreeLng)
    };
}

export function buildOverpassQuery(bounds) {
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    return `
        [out:json][timeout:25];
        (
          way["highway"~"${ALLOWED_HIGHWAY_PATTERN}"](${bbox});
        );
        out body;
        >;
        out skel qt;
    `;
}

export function isPointInsideBounds(point, bounds) {
    return point.lat >= bounds.south
        && point.lat <= bounds.north
        && point.lng >= bounds.west
        && point.lng <= bounds.east;
}

function clampLongitude(longitude) {
    return clamp(longitude, -180, 180);
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
