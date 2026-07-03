import {
    INTERSECTIONS_PER_SEGMENT,
    NETWORK_SIZE_KM,
    SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL,
    WEB_MERCATOR_MAX_LAT,
    buildBoundsAroundCenter,
    buildOverpassQuery,
    normalizeLatLng
} from "./road-network-core.js";
import { readFile } from "node:fs/promises";

const tests = [
    {
        name: "normalizes repeated-world Leaflet longitudes before Overpass",
        run() {
            const point = normalizeLatLng({ lat: 36.676902, lng: -222.796971 });

            assertApprox(point.lat, 36.676902, 0.000001);
            assertApprox(point.lng, 137.203029, 0.000001);
            assertGreaterThan(point.lng, -180);
            assertLessThan(point.lng, 180);
        }
    },
    {
        name: "clamps clicked latitude to the visible OSM tile range",
        run() {
            const north = normalizeLatLng({ lat: 91, lng: 120 });
            const south = normalizeLatLng({ lat: -91, lng: 120 });

            assertEqual(north.lat, WEB_MERCATOR_MAX_LAT);
            assertEqual(south.lat, -WEB_MERCATOR_MAX_LAT);
        }
    },
    {
        name: "builds a 10km bbox around the selected route center",
        run() {
            const bounds = buildBoundsAroundCenter({ lat: 37.7749, lng: -122.4194 });

            assertEqual(NETWORK_SIZE_KM, 10);
            assertApprox(bounds.north - bounds.south, 10 / 111.32, 0.002);
            assertGreaterThan(bounds.west, -180);
            assertLessThan(bounds.east, 180);
            assert(bounds.south < 37.7749 && bounds.north > 37.7749, "bbox should contain center latitude");
            assert(bounds.west < -122.4194 && bounds.east > -122.4194, "bbox should contain center longitude");
        }
    },
    {
        name: "builds Overpass query with the computed bbox and road filters",
        run() {
            const bounds = buildBoundsAroundCenter({ lat: 37.7749, lng: -122.4194 });
            const query = buildOverpassQuery(bounds);
            const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;

            assert(query.includes("[out:json][timeout:25]"));
            assert(query.includes(`(${bbox})`));
            assert(query.includes('way["highway"~'));
            assert(query.includes("residential"));
        }
    },
    {
        name: "plans to the next decision intersection only",
        run() {
            assertEqual(INTERSECTIONS_PER_SEGMENT, 1);
        }
    },
    {
        name: "has a reusable San Francisco road-network cache fixture",
        async run() {
            const cacheUrl = new URL(SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL, import.meta.url);
            const cache = JSON.parse(await readFile(cacheUrl, "utf8"));

            assertEqual(cache.cacheMetadata?.sizeKm, NETWORK_SIZE_KM);
            assert(cache.cacheMetadata?.bounds, "cache should include bounds metadata");
            assertGreaterThan(cache.elements?.length ?? 0, 1000);
            assert(cache.elements.some((element) => element.type === "way"), "cache should include OSM ways");
            assert(cache.elements.some((element) => element.type === "node"), "cache should include OSM nodes");
        }
    }
];

let passed = 0;
for (const test of tests) {
    try {
        await test.run();
        passed += 1;
        console.log(`PASS ${test.name}`);
    } catch (error) {
        console.error(`FAIL ${test.name}`);
        console.error(error.stack ?? error.message);
        process.exit(1);
    }
}

console.log(`\nPassed ${passed} / ${tests.length} osm-road-network-demo tests`);

function assert(condition, message = "Assertion failed") {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message ?? `Expected ${expected} but received ${actual}`);
    }
}

function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(message ?? `Expected ${actual} to be within ${tolerance} of ${expected}`);
    }
}

function assertGreaterThan(actual, threshold, message) {
    if (!(actual > threshold)) {
        throw new Error(message ?? `Expected ${actual} to be greater than ${threshold}`);
    }
}

function assertLessThan(actual, threshold, message) {
    if (!(actual < threshold)) {
        throw new Error(message ?? `Expected ${actual} to be less than ${threshold}`);
    }
}
