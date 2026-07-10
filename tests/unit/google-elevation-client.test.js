import { enrichTrackPointsWithGoogleElevation } from "../../src/adapters/maps/google-elevation-client.js";
import { assertEqual, assertGreaterThan } from "../helpers/test-harness.js";

export const suite = {
    name: "google-elevation-client",
    tests: [
        {
            name: "batches elevation requests and calculates route grades",
            async run() {
                const storage = createMemoryStorage();
                const elevationRequests = [];
                const points = createPoints();
                const elevationService = createFakeElevationService(elevationRequests);

                const result = await enrichTrackPointsWithGoogleElevation(points, {
                    storage,
                    elevationService
                });

                assertEqual(elevationRequests.length, 1);
                assertEqual(elevationRequests[0].length, points.length);
                assertEqual(result.hasElevationData, true);
                assertGreaterThan(result.points[1].elevationMeters, result.points[0].elevationMeters);
                assertGreaterThan(result.points[1].gradePercent, 0);
            }
        },
        {
            name: "uses cached elevation points on repeated enrichment",
            async run() {
                const storage = createMemoryStorage();
                const elevationRequests = [];
                const elevationService = createFakeElevationService(elevationRequests);

                await enrichTrackPointsWithGoogleElevation(createPoints(), { storage, elevationService });
                const result = await enrichTrackPointsWithGoogleElevation(createPoints(), { storage, elevationService });

                assertEqual(elevationRequests.length, 1);
                assertGreaterThan(result.summary.cacheHits, 0);
                assertEqual(result.summary.requests, 0);
            }
        },
        {
            name: "stops requests when local quota cap is reached",
            async run() {
                const storage = createMemoryStorage();
                const elevationRequests = [];
                const result = await enrichTrackPointsWithGoogleElevation(createPoints(), {
                    storage,
                    elevationService: createFakeElevationService(elevationRequests),
                    dailyRequestCap: 0,
                    monthlyRequestCap: 0
                });

                assertEqual(elevationRequests.length, 0);
                assertEqual(result.summary.skippedByQuota, true);
                assertEqual(result.hasElevationData, false);
            }
        }
    ]
};

function createPoints() {
    return [
        { latitude: 37.0, longitude: -122.0, distanceMeters: 0, elevationMeters: 0, gradePercent: 0 },
        { latitude: 37.0, longitude: -121.999, distanceMeters: 50, elevationMeters: 0, gradePercent: 0 },
        { latitude: 37.0, longitude: -121.998, distanceMeters: 100, elevationMeters: 0, gradePercent: 0 }
    ];
}

function createFakeElevationService(elevationRequests) {
    return {
        getElevationForLocations(request, callback) {
            elevationRequests.push(request.locations);
            callback(
                request.locations.map((location, index) => ({
                    elevation: 10 + index * 5 + Math.abs(location.lng)
                })),
                "OK"
            );
        }
    };
}

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.get(key) ?? null;
        },
        setItem(key, value) {
            values.set(key, value);
        }
    };
}
