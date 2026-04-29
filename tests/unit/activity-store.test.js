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
        }
    ]
};

function buildVirtualRideSession() {
    return {
        createdAt: "2026-04-29T10:00:00.000Z",
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
