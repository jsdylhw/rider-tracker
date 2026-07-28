import {
    INTERSECTIONS_PER_SEGMENT,
    INITIAL_ROUTE_NETWORK_SIZE_ATTEMPTS_KM,
    INITIAL_ROUTE_NETWORK_SIZE_KM,
    NETWORK_SIZE_KM,
    SAN_FRANCISCO_ROAD_NETWORK_CACHE_URL,
    UJI_CENTER,
    UJI_ROAD_NETWORK_CACHE_URL,
    WEB_MERCATOR_MAX_LAT,
    buildBoundsAroundCenter,
    buildBoundsAroundRoute,
    buildOverpassQuery,
    normalizeLatLng
} from "./road-network-core.js";
import { createRouteElevationController } from "./elevation-controller.js";
import {
    chooseRouteAlignedLink,
    createStreetViewController,
    getNativeLinkMoveDistanceMeters,
    getNativeLinkMoveIntervalMs,
    getNativeLookaheadHopCount,
    getRouteDistanceAtPosition,
    shouldResyncToRoutePano
} from "./street-view-controller.js";
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
        name: "starts uncached route requests at 4km and includes 3km then 2km fallbacks",
        run() {
            const bounds = buildBoundsAroundCenter({ lat: 34.65804, lng: 135.49400 }, INITIAL_ROUTE_NETWORK_SIZE_KM);

            assertEqual(INITIAL_ROUTE_NETWORK_SIZE_KM, 4);
            assertEqual(INITIAL_ROUTE_NETWORK_SIZE_ATTEMPTS_KM.join(","), "4,3,2");
            assertApprox(bounds.north - bounds.south, 4 / 111.32, 0.002);
            assert(bounds.south < 34.65804 && bounds.north > 34.65804, "initial request bounds should contain the route center");
        }
    },
    {
        name: "expands the initial route bbox when two selected points need more than the minimum size",
        run() {
            const start = { lat: 34.65804, lng: 135.49400 };
            const destination = { lat: 34.71000, lng: 135.54600 };
            const bounds = buildBoundsAroundRoute(start, destination, { minSizeKm: INITIAL_ROUTE_NETWORK_SIZE_KM });

            assert(bounds.sizeKm > INITIAL_ROUTE_NETWORK_SIZE_KM, "long diagonal selection should expand beyond the minimum bbox");
            assert(bounds.south <= start.lat && bounds.north >= start.lat, "bbox should contain start latitude");
            assert(bounds.south <= destination.lat && bounds.north >= destination.lat, "bbox should contain destination latitude");
            assert(bounds.west <= start.lng && bounds.east >= start.lng, "bbox should contain start longitude");
            assert(bounds.west <= destination.lng && bounds.east >= destination.lng, "bbox should contain destination longitude");
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
        name: "has a reusable Uji road-network cache fixture",
        async run() {
            const cacheUrl = new URL(UJI_ROAD_NETWORK_CACHE_URL, import.meta.url);
            const cache = JSON.parse(await readFile(cacheUrl, "utf8"));

            assertEqual(cache.cacheMetadata?.presetId, "uji");
            assertApprox(cache.cacheMetadata?.center?.lat, UJI_CENTER.lat, 0.000001);
            assertApprox(cache.cacheMetadata?.center?.lng, UJI_CENTER.lng, 0.000001);
            assertEqual(cache.cacheMetadata?.sizeKm, NETWORK_SIZE_KM);
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
                const trace = [];
                const controller = createStreetViewController({
                    container1,
                    container2,
                    onTrace: (entry) => trace.push(entry)
                });

                controller.update(createStreetViewRoute(), { distanceKm: 0, speedKph: 20 });

                assertEqual(panoramaInstances.length, 1);
                assertEqual(trace[0]?.event, "controller-ready");
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
        name: "holds Street View POV when no route-aligned pano is available",
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
                assertEqual(panoramaInstances[0].povCalls.length, activePovCountAfterFirstUpdate);
                controller.destroy();
            });
        }
    },
    {
        name: "does not pause auto movement for a delayed Street View POV event",
        async run() {
            await withFakeGoogleMaps(({ emitGoogleEvent, panoramaInstances, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 20 });
                runTimers();
                emitGoogleEvent(panoramaInstances[0], "pov_changed");

                const result = controller.update(route, { distanceKm: 0.001, speedKph: 20 });

                assertEqual(result.navigation, "pano-waiting");
                controller.destroy();
            });
        }
    },
    {
        name: "does not treat an asynchronous pano change event as user interaction",
        async run() {
            await withFakeGoogleMaps(({ emitGoogleEvent, panoramaInstances, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 20 });
                runTimers();
                panoramaInstances[0].setPano("late-programmatic-pano");
                emitGoogleEvent(panoramaInstances[0], "pano_changed");

                const result = controller.update(route, { distanceKm: 0.001, speedKph: 20 });

                assert(result.navigation !== "paused");
                controller.destroy();
            });
        }
    },
    {
        name: "uses a rate-limited GPS catch-up when the active pano falls behind the route",
        async run() {
            const originalNow = Date.now;
            let now = 10000;
            Date.now = () => now;
            try {
                await withFakeGoogleMaps(({ panoramaInstances, runTimers }) => {
                    const { container1, container2 } = createPanoramaContainers();
                    const controller = createStreetViewController({ container1, container2 });
                    const route = createStreetViewRoute();

                    controller.update(route, { distanceKm: 0, speedKph: 30 });
                    runTimers();
                    panoramaInstances[0].position = { lat: 37.77, lng: -122.4194 };

                    const result = controller.update(route, { distanceKm: 0.02, speedKph: 30 });

                    assertEqual(result.navigation, "gps-catch-up");
                    controller.destroy();
                });
            } finally {
                Date.now = originalNow;
            }
        }
    },
    {
        name: "prefers the route-aligned native Street View link before another GPS lookup",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, panoramaRequests, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 20 });
                runTimers();
                const locationRequestCountAfterInitialLookup = panoramaRequests.filter((request) => request.location).length;
                panoramaInstances[0].links = [
                    { pano: "backward", heading: 270 },
                    { pano: "forward", heading: 90 }
                ];

                const result = controller.update(route, { distanceKm: 0.02, speedKph: 20 });

                assertEqual(panoramaInstances[0].getPano(), "forward");
                assertEqual(
                    panoramaRequests.filter((request) => request.location).length,
                    locationRequestCountAfterInitialLookup
                );
                assertEqual(result.navigation, "native-link");
                controller.destroy();
            });
        }
    },
    {
        name: "does not run periodic GPS lookup while a route-aligned native link is available",
        async run() {
            const originalNow = Date.now;
            let now = 10000;
            Date.now = () => now;
            try {
                await withFakeGoogleMaps(({ panoramaInstances, panoramaRequests, runTimers }) => {
                    const { container1, container2 } = createPanoramaContainers();
                    const controller = createStreetViewController({ container1, container2 });
                    const route = createStreetViewRoute();

                    controller.update(route, { distanceKm: 0, speedKph: 20 });
                    runTimers();
                    panoramaInstances[0].links = [{ pano: "first", heading: 90 }];
                    controller.update(route, { distanceKm: 0.02, speedKph: 20 });
                    runTimers();
                    panoramaInstances[0].links = [{ pano: "second", heading: 90 }];
                    const locationRequestCount = panoramaRequests.filter((request) => request.location).length;
                    now += 1100;

                    const result = controller.update(route, { distanceKm: 0.021, speedKph: 20 });

                    assertEqual(result.navigation, "pov-only");
                    assertEqual(panoramaRequests.filter((request) => request.location).length, locationRequestCount);
                    controller.destroy();
                });
            } finally {
                Date.now = originalNow;
            }
        }
    },
    {
        name: "ignores a delayed GPS lookup after native pano navigation advances",
        async run() {
            await withFakeGoogleMaps(({ deferLocationPanoramaResponses, panoramaInstances, releaseLocationPanoramaResponses, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const trace = [];
                const controller = createStreetViewController({
                    container1,
                    container2,
                    onTrace: (entry) => trace.push(entry)
                });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 20 });
                runTimers();
                deferLocationPanoramaResponses();
                controller.update(route, { distanceKm: 0.02, speedKph: 20 });
                panoramaInstances[0].links = [{ pano: "forward", heading: 90 }];
                controller.update(route, { distanceKm: 0.03, speedKph: 20 });
                releaseLocationPanoramaResponses();

                assertEqual(panoramaInstances[0].getPano(), "forward");
                assert(trace.some((entry) => entry.event === "gps-stale"));
                controller.destroy();
            });
        }
    },
    {
        name: "waits for the active pano to become ready before the next native link switch",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 30 });
                runTimers();
                panoramaInstances[0].links = [{ pano: "first", heading: 90 }];
                controller.update(route, { distanceKm: 0.02, speedKph: 30 });

                const result = controller.update(route, { distanceKm: 0.04, speedKph: 30 });

                assertEqual(result.navigation, "pano-loading");
                controller.destroy();
            });
        }
    },
    {
        name: "keeps the latest route POV when a pano finishes loading",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, runTimers }) => {
                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();
                route.points[1].gradePercent = 10;

                controller.update(route, { distanceKm: 0, speedKph: 30 });
                runTimers();
                panoramaInstances[0].links = [{ pano: "uphill", heading: 90 }];
                controller.update(route, { distanceKm: 0.02, speedKph: 30 });
                controller.update(route, { distanceKm: 0.04, speedKph: 30 });
                runTimers();

                const latestPov = panoramaInstances[0].povCalls.at(-1);
                assertApprox(latestPov.pitch, Math.atan(8 / 100) * (180 / Math.PI), 0.01);
                controller.destroy();
            });
        }
    },
    {
        name: "rejects native links that point too far away from the route heading",
        run() {
            const link = chooseRouteAlignedLink([
                { pano: "backward", heading: 270 },
                { pano: "side-road", heading: 180 }
            ], 90, "current");

            assertEqual(link, null);
        }
    },
    {
        name: "does not choose the pano that was just left as the next native link",
        run() {
            const link = chooseRouteAlignedLink([
                { pano: "previous", heading: 90 },
                { pano: "forward", heading: 90 }
            ], 90, "current", ["previous"]);

            assertEqual(link.pano, "forward");
        }
    },
    {
        name: "uses a faster native pano cadence at higher simulated speeds",
        run() {
            assertApprox(getNativeLinkMoveDistanceMeters(22), 2.045, 0.01);
            assertEqual(getNativeLinkMoveDistanceMeters(30), 1.5);
            assertEqual(getNativeLinkMoveDistanceMeters(80), 1.2);
            assertGreaterThan(getNativeLinkMoveIntervalMs(22), getNativeLinkMoveIntervalMs(30));
            assertGreaterThan(getNativeLinkMoveIntervalMs(30), getNativeLinkMoveIntervalMs(60));
            assertEqual(getNativeLookaheadHopCount(22), 1);
            assertEqual(getNativeLookaheadHopCount(30), 2);
            assertEqual(getNativeLookaheadHopCount(45), 3);
        }
    },
    {
        name: "projects a Street View pano position onto route distance before advancing",
        run() {
            const route = {
                points: [
                    { latitude: 35, longitude: 135, distanceMeters: 0 },
                    { latitude: 35.0008983, longitude: 135, distanceMeters: 100 }
                ]
            };

            const distanceMeters = getRouteDistanceAtPosition(route, { lat: 35.00044915, lng: 135 });

            assertApprox(distanceMeters, 50, 0.2);
        }
    },
    {
        name: "uses pre-read pano metadata while rendering only the next route-aligned pano",
        async run() {
            await withFakeGoogleMaps(({ panoramaInstances, panoMetadataById, runTimers }) => {
                panoMetadataById.set("first", {
                    location: { pano: "first", latLng: { lat: 37.7750, lng: -122.4188 } },
                    links: [{ pano: "second", heading: 90 }]
                });
                panoMetadataById.set("second", {
                    location: { pano: "second", latLng: { lat: 37.7751, lng: -122.4185 } },
                    links: [{ pano: "third", heading: 90 }]
                });

                const { container1, container2 } = createPanoramaContainers();
                const controller = createStreetViewController({ container1, container2 });
                const route = createStreetViewRoute();

                controller.update(route, { distanceKm: 0, speedKph: 30 });
                runTimers();
                panoramaInstances[0].links = [{ pano: "first", heading: 90 }];
                const povCountBeforeWaiting = panoramaInstances[0].povCalls.length;

                const waitingResult = controller.update(route, { distanceKm: 0.01, speedKph: 30 });
                assertEqual(waitingResult.navigation, "pano-waiting");
                assertEqual(panoramaInstances[0].povCalls.length, povCountBeforeWaiting);

                const result = controller.update(route, { distanceKm: 0.035, speedKph: 30 });

                assertEqual(result.navigation, "native-link");
                assertEqual(result.nativeLinkHops, 1);
                assertEqual(panoramaInstances[0].getPano(), "first");
                controller.destroy();
            });
        }
    },
    {
        name: "uses the configured rider speed when deciding whether to advance a native pano link",
        async run() {
            const originalNow = Date.now;
            let now = 10000;
            Date.now = () => now;
            try {
                await withFakeGoogleMaps(({ panoramaInstances, runTimers }) => {
                    const route = createStreetViewRoute();
                    const slowContainers = createPanoramaContainers();
                    const slowController = createStreetViewController(slowContainers);
                    slowController.update(route, { distanceKm: 0, speedKph: 22 });
                    runTimers();
                    panoramaInstances[0].links = [{ pano: "slow-first", heading: 90 }];
                    slowController.update(route, { distanceKm: 0, speedKph: 22 });
                    runTimers();
                    panoramaInstances[0].links = [{ pano: "slow-forward", heading: 90 }];
                    now += 500;

                    const slowResult = slowController.update(route, { distanceKm: 0.002, speedKph: 22 });
                    assertEqual(slowResult.navigation, "pov-only");
                    slowController.destroy();

                    const fastContainers = createPanoramaContainers();
                    const fastController = createStreetViewController(fastContainers);
                    fastController.update(route, { distanceKm: 0, speedKph: 30 });
                    runTimers();
                    panoramaInstances[1].links = [{ pano: "fast-first", heading: 90 }];
                    fastController.update(route, { distanceKm: 0, speedKph: 30 });
                    runTimers();
                    panoramaInstances[1].links = [{ pano: "fast-forward", heading: 90 }];
                    now += 500;

                    const fastResult = fastController.update(route, { distanceKm: 0.002, speedKph: 30 });
                    assertEqual(fastResult.navigation, "native-link");
                    assertEqual(panoramaInstances[1].getPano(), "fast-forward");
                    fastController.destroy();
                });
            } finally {
                Date.now = originalNow;
            }
        }
    },
    {
        name: "re-syncs a manually changed pano only after it moves materially away from the route",
        run() {
            const routePosition = { lat: 37.7749, lng: -122.4194 };

            assertEqual(shouldResyncToRoutePano({ lat: 37.7750, lng: -122.4194 }, routePosition), false);
            assertEqual(shouldResyncToRoutePano({ lat: 37.7755, lng: -122.4194 }, routePosition), true);
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
    const panoMetadataById = new Map();
    const googleEventListeners = new Map();
    const pendingLocationPanoramaResponses = [];
    let deferLocationPanoramaResponses = false;
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
            if (request.pano) {
                callback(
                    panoMetadataById.get(request.pano) ?? { location: { pano: request.pano }, links: [] },
                    "OK"
                );
                return;
            }
            if (deferLocationPanoramaResponses) {
                pendingLocationPanoramaResponses.push({ request, callback });
                return;
            }
            respondToLocationPanoramaRequest(request, callback);
        }
    }

    function respondToLocationPanoramaRequest(request, callback) {
        const lat = Number(request.location.lat);
        const lng = Number(request.location.lng);
        callback({ location: { pano: `${lat.toFixed(4)},${lng.toFixed(4)}` } }, "OK");
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

        getLinks() {
            return this.links ?? [];
        }

        getStatus() {
            return this.status;
        }

        getPosition() {
            return this.position ?? null;
        }

        getPov() {
            return this.pov ?? null;
        }

        setPov(pov) {
            this.pov = pov;
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
        panoMetadataById,
        deferLocationPanoramaResponses() {
            deferLocationPanoramaResponses = true;
        },
        releaseLocationPanoramaResponses() {
            deferLocationPanoramaResponses = false;
            const pending = pendingLocationPanoramaResponses.splice(0);
            pending.forEach(({ request, callback }) => respondToLocationPanoramaRequest(request, callback));
        },
        emitGoogleEvent(target, eventName) {
            const listeners = googleEventListeners.get(target)?.get(eventName) ?? [];
            listeners.forEach((handler) => handler());
        },
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
                            if (!googleEventListeners.has(target)) {
                                googleEventListeners.set(target, new Map());
                            }
                            const listeners = googleEventListeners.get(target);
                            const handlers = listeners.get(eventName) ?? [];
                            handlers.push(handler);
                            listeners.set(eventName, handlers);
                            return { target, eventName, handler };
                        },
                        removeListener(listener) {
                            const handlers = googleEventListeners.get(listener.target)?.get(listener.eventName);
                            if (!handlers) return;
                            const index = handlers.indexOf(listener.handler);
                            if (index >= 0) handlers.splice(index, 1);
                        }
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
