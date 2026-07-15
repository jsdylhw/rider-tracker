import {
    INTERSECTIONS_PER_SEGMENT,
    NETWORK_SIZE_KM,
    SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL,
    WEB_MERCATOR_MAX_LAT,
    buildBoundsAroundCenter,
    buildOverpassQuery,
    normalizeLatLng
} from "./road-network-core.js";
import { createRouteElevationController } from "./elevation-controller.js";
import { createStreetViewController } from "./street-view-controller.js";
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
        name: "extends free-ride routes one decision intersection at a time",
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
    },
    {
        name: "keeps a single Street View panorama visible",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });

                controller.update(createStreetViewRoute(), { distanceKm: 0, speedKph: 20 });

                assertEqual(panoramaInstances.length, 1);
                assertEqual(container1.style.opacity, "1");
                assertEqual(container1.style.zIndex, "2");
                assertEqual(container2.style.opacity, "0");
                assertEqual(container2.style.zIndex, "1");
                runTimers();

                assertGreaterThan(panoramaInstances[0].povCalls.length, 0);
                controller.destroy();
            });
        }
    },
    {
        name: "updates Street View POV on movement ticks without duplicate panorama lookup",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, panoramaRequests, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 20 });
                runTimers();
                const requestCountAfterFirstUpdate = panoramaRequests.length;
                const activePovCountAfterFirstUpdate = panoramaInstances[0].povCalls.length;

                controller.update(route, { distanceKm: 0.001, speedKph: 20 });

                assertEqual(panoramaRequests.length, requestCountAfterFirstUpdate);
                assertGreaterThan(panoramaInstances[0].povCalls.length, activePovCountAfterFirstUpdate);
                controller.destroy();
            });
        }
    },
    {
        name: "requests initial route elevation in one batched call",
        async run() {
            await withFakeGoogleMaps(async ({ elevationRequests }) => {
                const storage = createMemoryStorage();
                const route = createStreetViewRoute();
                const controller = createRouteElevationController({ storage });

                const summary = await controller.enrichRoute(route, { mode: "initial" });

                assertEqual(elevationRequests.length, 1);
                assertEqual(elevationRequests[0].locations.length, route.points.length);
                assertEqual(summary.requests, 1);
                assertGreaterThan(route.points[1].elevationMeters, route.points[0].elevationMeters);
                assertGreaterThan(route.points[1].gradePercent, 0);
            });
        }
    },
    {
        name: "requests only new elevation points after route extension",
        async run() {
            await withFakeGoogleMaps(async ({ elevationRequests }) => {
                const storage = createMemoryStorage();
                const controller = createRouteElevationController({ storage });

                await controller.enrichRoute(createStreetViewRoute(), { mode: "initial" });
                const extendedRoute = createExtendedStreetViewRoute();
                const summary = await controller.enrichRoute(extendedRoute, { mode: "incremental" });

                assertEqual(elevationRequests.length, 2);
                assertEqual(elevationRequests[1].locations.length, 2);
                assertEqual(summary.requests, 1);
                assertGreaterThan(summary.cacheHits, 0);
            });
        }
    },
    {
        name: "stops elevation requests at the demo quota cap",
        async run() {
            await withFakeGoogleMaps(async ({ elevationRequests }) => {
                const storage = createMemoryStorage();
                const controller = createRouteElevationController({
                    storage,
                    dailyRequestCap: 0,
                    monthlyRequestCap: 0
                });

                const summary = await controller.enrichRoute(createStreetViewRoute(), { mode: "initial" });

                assertEqual(elevationRequests.length, 0);
                assertEqual(summary.skippedByQuota, true);
            });
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

async function withFakeGoogleMaps(run) {
    const previousWindow = globalThis.window;
    const fake = createFakeGoogleMapsWindow();
    globalThis.window = fake.window;
    try {
        await run(fake);
    } finally {
        if (previousWindow) {
            globalThis.window = previousWindow;
        } else {
            delete globalThis.window;
        }
    }
}

function createFakeGoogleMapsWindow() {
    const panoramaInstances = [];
    const panoramaRequests = [];
    const elevationRequests = [];
    const timers = new Map();
    let nextTimerId = 1;

    class LatLng {
        constructor(lat, lng) {
            this.lat = lat;
            this.lng = lng;
        }
    }

    class StreetViewService {
        getPanorama(request, callback) {
            panoramaRequests.push(request);
            const lat = Number(request.location.lat);
            const lng = Number(request.location.lng);
            callback({ location: { pano: `${lat.toFixed(4)},${lng.toFixed(4)}` } }, "OK");
        }
    }

    class StreetViewPanorama {
        constructor() {
            this.pano = "";
            this.status = "";
            this.povCalls = [];
            panoramaInstances.push(this);
        }

        getPano() {
            return this.pano;
        }

        setPano(pano) {
            this.pano = pano;
            this.status = "OK";
        }

        getStatus() {
            return this.status;
        }

        setPov(pov) {
            this.povCalls.push(pov);
        }
    }

    class ElevationService {
        getElevationForLocations(request, callback) {
            elevationRequests.push(request);
            callback(request.locations.map((location, index) => ({
                elevation: index * 5 + Number(location.lat) * 0.01
            })), "OK");
        }
    }

    return {
        panoramaInstances,
        panoramaRequests,
        elevationRequests,
        runTimers() {
            const dueTimers = [...timers.entries()];
            timers.clear();
            dueTimers.forEach(([, timer]) => timer.handler());
        },
        window: {
            setTimeout(handler) {
                const id = nextTimerId;
                nextTimerId += 1;
                timers.set(id, { handler });
                return id;
            },
            clearTimeout(id) {
                timers.delete(id);
            },
            google: {
                maps: {
                    StreetViewStatus: { OK: "OK" },
                    StreetViewService,
                    StreetViewPanorama,
                    ElevationService,
                    LatLng,
                    event: {
                        addListener(target, eventName, handler) {
                            return { target, eventName, handler };
                        },
                        removeListener() {}
                    },
                    geometry: {
                        spherical: {
                            computeHeading(from, to) {
                                return (Number(to.lng) - Number(from.lng)) >= 0 ? 90 : 270;
                            }
                        }
                    }
                }
            }
        }
    };
}

function createPanoramaContainers() {
    const container1 = createContainer();
    const container2 = createContainer();
    const parentElement = {
        querySelector(selector) {
            if (selector === "#svPano1") return container1;
            if (selector === "#svPano2") return container2;
            return null;
        }
    };
    container1.parentElement = parentElement;
    container2.parentElement = parentElement;
    return { container1, container2 };
}

function createContainer() {
    return {
        style: {},
        addEventListener() {},
        removeEventListener() {}
    };
}

function createStreetViewRoute() {
    return {
        totalDistanceMeters: 100,
        points: [
            { latitude: 37.7749, longitude: -122.4194, distanceMeters: 0, gradePercent: 0 },
            { latitude: 37.775, longitude: -122.418, distanceMeters: 50, gradePercent: 0 },
            { latitude: 37.7755, longitude: -122.417, distanceMeters: 100, gradePercent: 0 }
        ]
    };
}

function createExtendedStreetViewRoute() {
    return {
        totalDistanceMeters: 150,
        points: [
            { latitude: 37.7749, longitude: -122.4194, distanceMeters: 0, gradePercent: 0 },
            { latitude: 37.775, longitude: -122.418, distanceMeters: 50, gradePercent: 0 },
            { latitude: 37.7755, longitude: -122.417, distanceMeters: 100, gradePercent: 0 },
            { latitude: 37.776, longitude: -122.416, distanceMeters: 125, gradePercent: 0 },
            { latitude: 37.7765, longitude: -122.415, distanceMeters: 150, gradePercent: 0 }
        ]
    };
}

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}
