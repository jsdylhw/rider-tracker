import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createActivityStore } from "../../src/server/activity-store.js";
import { assert, assertApprox, assertEqual } from "../helpers/test-harness.js";
import { initializeManagedTestDatabase } from "../helpers/managed-database.js";

export const suite = {
    name: "activity-store",
    tests: [
        {
            name: "refuses to create an unmanaged database schema",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "missing.db");
                const store = createActivityStore(dbPath);
                let error = null;
                try {
                    store.initialize();
                } catch (caught) {
                    error = caught;
                }
                assertEqual(error?.message.includes("npm run db:init"), true);
                assertEqual(fs.existsSync(dbPath), false);
            }
        },
        {
            name: "rejects stale and future database schema versions",
            run() {
                for (const version of [8, 10]) {
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-version-"));
                    const dbPath = initializeManagedTestDatabase(path.join(tempDir, `schema-${version}.db`));
                    const db = new DatabaseSync(dbPath);
                    db.exec(`PRAGMA user_version = ${version}`);
                    db.close();
                    let error = null;
                    try {
                        createActivityStore(dbPath).initialize();
                    } catch (caught) {
                        error = caught;
                    }
                    assertEqual(error?.message.includes(`user_version ${version}; expected 9`), true);
                }
            }
        },
        {
            name: "saves rider sessions into sqlite activity history",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(initializeManagedTestDatabase(dbPath));
                const session = buildVirtualRideSession();

                const saved = store.saveRiderSession(session);
                const storedSession = readRawSession(dbPath, saved.id);

                assert(fs.existsSync(dbPath), "database file should be created");
                assertEqual(saved.source, "rider-tracker");
                assertEqual(saved.sportType, "VirtualRide");
                assertEqual(saved.name, "Test Virtual Ride");
                assertApprox(saved.distanceKm, 12.34, 0.0001);
                assertEqual(saved.elapsedSeconds, 1800);
                assertEqual(saved.averagePower, 205);
                assertEqual(storedSession.exportMetadata.activityName, "Test Virtual Ride");
                assertEqual(storedSession.records.length, 2);
            }
        },
        {
            name: "stores fit file metadata on activities",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(initializeManagedTestDatabase(dbPath));
                const saved = store.saveRiderSession(buildVirtualRideSession());

                const updated = store.updateActivityFitFile(saved.id, {
                    fitFilePath: "data/files/fit/test.fit",
                    fitFileSizeBytes: 128
                });
                const detail = store.getActivity(saved.id);

                assertEqual(updated.fitFilePath, "data/files/fit/test.fit");
                assertEqual(updated.fitFileSizeBytes, 128);
                assertEqual(detail.fitFilePath, "data/files/fit/test.fit");
                assertEqual(detail.fitFileSizeBytes, 128);
            }
        },
        {
            name: "links a completed activity to a saved route distance window",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const store = createActivityStore(initializeManagedTestDatabase(path.join(tempDir, "activities.db")));
                const saved = store.saveRiderSession(buildVirtualRideSession());

                const linked = store.updateActivityRoute(saved.id, {
                    savedRouteId: "route-1",
                    routeStartDistanceMeters: 3200,
                    routeEndDistanceMeters: 15540
                });

                assertEqual(linked.savedRouteId, "route-1");
                assertEqual(linked.routeStartDistanceMeters, 3200);
                assertEqual(store.getActivity(saved.id).routeEndDistanceMeters, 15540);
            }
        },
        {
            name: "saves imported fit activities as compact metadata",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(initializeManagedTestDatabase(dbPath));
                const session = {
                    ...buildVirtualRideSession(),
                    source: "fit-import",
                    exportMetadata: {
                        activityName: "Imported FIT Ride",
                        markVirtualActivity: false
                    },
                    hasGpsTrack: true,
                    records: []
                };

                const saved = store.saveRiderSession(session, {
                    sportType: "Ride",
                    source: "fit-import"
                });
                const storedSession = readRawSession(dbPath, saved.id);

                assertEqual(saved.source, "fit-import");
                assertEqual(saved.sportType, "Ride");
                assertEqual(saved.name, "Imported FIT Ride");
                assertEqual(saved.hasGpsTrack, true);
                assertApprox(saved.distanceKm, 12.34, 0.0001);
                assertEqual(storedSession.records.length, 0);
            }
        }
    ]
};

function readRawSession(dbPath, activityId) {
    const db = new DatabaseSync(dbPath);
    try {
        const row = db.prepare("SELECT raw_json FROM activities WHERE id = ?").get(activityId);
        return JSON.parse(row.raw_json);
    } finally {
        db.close();
    }
}

function buildVirtualRideSession(id, createdAt) {
    return {
        id,
        createdAt: createdAt ?? "2026-04-29T10:00:00.000Z",
        finishedAt: "2026-04-29T10:30:00.000Z",
        exportMetadata: {
            activityName: "Test Virtual Ride",
            markVirtualActivity: true
        },
        summary: {
            metrics: {
                ride: {
                    elapsedSeconds: 1800,
                    distanceKm: 12.34,
                    ascentMeters: 256
                },
                power: {
                    averageWatts: 205,
                    normalizedPowerWatts: 218
                },
                heartRate: {
                    averageBpm: 146
                },
                load: {
                    estimatedTss: 41.5
                }
            }
        },
        records: [
            {
                elapsedSeconds: 0,
                distanceKm: 0,
                power: 190
            },
            {
                elapsedSeconds: 1800,
                distanceKm: 12.34,
                power: 220
            }
        ]
    };
}
