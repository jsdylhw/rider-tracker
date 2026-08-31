import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createActivityStore } from "../../src/server/activity-store.js";
import { assertEqual } from "../helpers/test-harness.js";
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
            name: "stores fit file metadata on activities",
            run() {
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rider-tracker-db-"));
                const dbPath = path.join(tempDir, "activities.db");
                const store = createActivityStore(initializeManagedTestDatabase(dbPath));
                const saved = seedActivity(dbPath);

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
                const dbPath = initializeManagedTestDatabase(path.join(tempDir, "activities.db"));
                const store = createActivityStore(dbPath);
                const saved = seedActivity(dbPath);

                const linked = store.updateActivityRoute(saved.id, {
                    savedRouteId: "route-1",
                    routeStartDistanceMeters: 3200,
                    routeEndDistanceMeters: 15540
                });

                assertEqual(linked.savedRouteId, "route-1");
                assertEqual(linked.routeStartDistanceMeters, 3200);
                assertEqual(store.getActivity(saved.id).routeEndDistanceMeters, 15540);
            }
        }
    ]
};

function seedActivity(dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
        db.prepare(`
            INSERT INTO activities (
                id, source, sport_type, name, raw_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            "activity-1", "rider-tracker", "Ride", "Test Ride", "{}",
            "2026-04-29T10:00:00Z", "2026-04-29T10:00:00Z"
        );
        return { id: "activity-1" };
    } finally {
        db.close();
    }
}
