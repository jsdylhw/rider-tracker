import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActivityStore } from "../../src/server/activity-store.js";
import { assert, assertApprox, assertEqual } from "../helpers/test-harness.js";

export const suite = {
    name: "activity-store",
    tests: [
        {
            name: "saves rider sessions into sqlite activity history",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(dbPath);
                const session = buildVirtualRideSession();

                const saved = store.saveRiderSession(session);
                const activities = store.listActivities();
                const summary = store.getSummary();

                assert(fs.existsSync(dbPath), "database file should be created");
                assertEqual(saved.source, "rider-tracker");
                assertEqual(saved.sportType, "VirtualRide");
                assertEqual(saved.name, "Test Virtual Ride");
                assertApprox(saved.distanceKm, 12.34, 0.0001);
                assertEqual(saved.elapsedSeconds, 1800);
                assertEqual(saved.averagePower, 205);
                assertEqual(activities.length, 1);
                assertEqual(activities[0].id, saved.id);
                assertEqual(summary.activityCount, 1);
                assertApprox(summary.totalDistanceKm, 12.34, 0.0001);
                assertEqual(summary.totalAscentMeters, 256);
                const detail = store.getActivityDetail(saved.id);
                assertEqual(detail.rawSession.exportMetadata.activityName, "Test Virtual Ride");
                assertEqual(detail.rawSession.records.length, 2);
            }
        },
        {
            name: "renames and deletes saved activities",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(dbPath);
                const saved = store.saveRiderSession(buildVirtualRideSession());

                const renamed = store.updateActivityName(saved.id, "Renamed Virtual Ride");
                assertEqual(renamed.name, "Renamed Virtual Ride");
                assertEqual(store.listActivities()[0].name, "Renamed Virtual Ride");

                const deleted = store.deleteActivity(saved.id);
                assertEqual(deleted.id, saved.id);
                assertEqual(store.listActivities().length, 0);
                assertEqual(store.getSummary().activityCount, 0);
            }
        },
        {
            name: "stores fit file metadata on activities",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(dbPath);
                const saved = store.saveRiderSession(buildVirtualRideSession());

                const updated = store.updateActivityFitFile(saved.id, {
                    fitFilePath: "data/files/fit/test.fit",
                    fitFileSizeBytes: 128
                });
                const detail = store.getActivityDetail(saved.id);

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
                const store = createActivityStore(path.join(tempDir, "activities.db"));
                const saved = store.saveRiderSession(buildVirtualRideSession());

                const linked = store.updateActivityRoute(saved.id, {
                    savedRouteId: "route-1",
                    routeStartDistanceMeters: 3200,
                    routeEndDistanceMeters: 15540
                });

                assertEqual(linked.savedRouteId, "route-1");
                assertEqual(linked.routeStartDistanceMeters, 3200);
                assertEqual(store.getActivityDetail(saved.id).routeEndDistanceMeters, 15540);
            }
        },
        {
            name: "saves imported fit activities as compact metadata",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(dbPath);
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
                const detail = store.getActivityDetail(saved.id);

                assertEqual(saved.source, "fit-import");
                assertEqual(saved.sportType, "Ride");
                assertEqual(saved.name, "Imported FIT Ride");
                assertEqual(saved.hasGpsTrack, true);
                assertApprox(saved.distanceKm, 12.34, 0.0001);
                assertEqual(detail.rawSession.records.length, 0);
            }
        },
        {
            name: "pages and filters activity history in sqlite",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const store = createActivityStore(path.join(tempDir, "activities.db"));
                store.saveRiderSession(buildVirtualRideSession("virtual-new", "2026-05-03T10:00:00.000Z"), {
                    source: "rider-tracker",
                    sportType: "VirtualRide"
                });
                store.saveRiderSession(buildVirtualRideSession("outdoor", "2026-05-02T10:00:00.000Z"), {
                    source: "fit-import",
                    sportType: "Ride"
                });
                store.saveRiderSession(buildVirtualRideSession("virtual-old", "2026-05-01T10:00:00.000Z"), {
                    source: "rider-tracker",
                    sportType: "VirtualRide"
                });

                const firstPage = store.listActivities({ limit: 1, offset: 0 });
                const secondPage = store.listActivities({ limit: 1, offset: 1 });
                const virtualRides = store.listActivities({ sportType: "VirtualRide" });
                const fitImports = store.listActivities({ source: "fit-import" });
                const history = store.getActivityHistory({ limit: 1, sportType: "VirtualRide" });

                assertEqual(store.countActivities(), 3);
                assertEqual(firstPage[0].id, "virtual-new");
                assertEqual(secondPage[0].id, "outdoor");
                assertEqual(virtualRides.length, 2);
                assertEqual(fitImports.length, 1);
                assertEqual(fitImports[0].id, "outdoor");
                assertEqual(history.total, 2);
                assertEqual(history.activities.length, 1);
                assertEqual(history.activities[0].id, "virtual-new");
                assertEqual(history.summary.activityCount, 3);
            }
        }
    ]
};

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
