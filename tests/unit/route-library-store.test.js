import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRouteLibraryStore } from "../../src/server/route-library-store.js";
import { assert, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "route-library-store",
    tests: [
        {
            name: "saves, reloads, and deletes a parsed GPX route",
            run() {
                const store = createTestStore();
                const saved = store.saveGpxRoute({ route: buildGpxRoute(), originalGpxText: "<gpx />" });

                assert(saved.created, "first save should create a route");
                assertEqual(store.listRoutes().length, 1);
                assertEqual(store.listRoutes()[0].name, "Kyoto Climb");
                assertEqual(store.getRoute(saved.id).route.points.length, 3);

                const progressed = store.updateResumeDistance(saved.id, 700);
                assertEqual(progressed.resumeDistanceMeters, 700);

                const deleted = store.deleteRoute(saved.id);
                assertEqual(deleted.id, saved.id);
                assertEqual(store.listRoutes().length, 0);
            }
        },
        {
            name: "deduplicates matching GPX geometry while refreshing route data",
            run() {
                const store = createTestStore();
                const first = store.saveGpxRoute({ route: buildGpxRoute({ name: "Old name", hasElevationData: false }) });
                const second = store.saveGpxRoute({ route: buildGpxRoute({ name: "New name", hasElevationData: true }) });

                assertEqual(second.created, false);
                assertEqual(second.id, first.id);
                assertEqual(store.listRoutes().length, 1);
                assertEqual(store.getRoute(first.id).name, "New name");
                assertEqual(store.getRoute(first.id).hasElevationData, true);
            }
        },
        {
            name: "rejects routes without valid GPX geometry",
            run() {
                const store = createTestStore();
                let error = null;
                try {
                    store.saveGpxRoute({ route: { source: "gpx", points: [] } });
                } catch (caught) {
                    error = caught;
                }
                assert(error instanceof Error, "invalid route should be rejected");
            }
        },
        {
            name: "migrates existing route libraries with a resume distance column",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-route-library-"));
                const dbPath = path.join(tempDir, "routes.db");
                const db = new DatabaseSync(dbPath);
                db.exec(`
                    CREATE TABLE saved_routes (
                        id TEXT PRIMARY KEY,
                        source TEXT NOT NULL,
                        name TEXT NOT NULL,
                        import_file_name TEXT,
                        fingerprint TEXT NOT NULL UNIQUE,
                        route_json TEXT NOT NULL,
                        original_gpx_text TEXT,
                        total_distance_meters REAL NOT NULL,
                        total_elevation_gain_meters REAL NOT NULL DEFAULT 0,
                        has_elevation_data INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                `);
                db.close();

                const store = createRouteLibraryStore(dbPath);
                store.initialize();

                const migrated = new DatabaseSync(dbPath);
                const columns = migrated.prepare("PRAGMA table_info(saved_routes);").all().map((column) => column.name);
                migrated.close();
                assert(columns.includes("resume_distance_meters"), "existing route library should gain resume progress storage");
            }
        }
    ]
};

function createTestStore() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-route-library-"));
    return createRouteLibraryStore(path.join(tempDir, "routes.db"));
}

function buildGpxRoute({ name = "Kyoto Climb", hasElevationData = true } = {}) {
    return {
        source: "gpx",
        name,
        importFileName: "kyoto-climb",
        totalDistanceMeters: 1400,
        totalElevationGainMeters: hasElevationData ? 120 : 0,
        hasElevationData,
        points: [
            { latitude: 35.01, longitude: 135.71, distanceMeters: 0, elevationMeters: 40, gradePercent: 0 },
            { latitude: 35.011, longitude: 135.712, distanceMeters: 700, elevationMeters: 90, gradePercent: 7.1 },
            { latitude: 35.012, longitude: 135.714, distanceMeters: 1400, elevationMeters: 160, gradePercent: 10 }
        ],
        segments: [{ name: "GPX 全程", distanceMeters: 1400, gradePercent: 8.5 }]
    };
}
