import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouteLibraryStore } from "../../src/server/route-library-store.js";
import { assertEqual } from "../helpers/test-harness.js";
import { initializeManagedTestDatabase } from "../helpers/managed-database.js";

export const suite = {
    name: "route-library-store",
    tests: [
        {
            name: "saves all route sources and deduplicates normalized geometry",
            run() {
                const store = createTestStore();
                const first = store.saveRoute({
                    route: buildRoute("agent-planned"),
                    source: "agent",
                    agentPlanId: "plan-1",
                    agentCandidateId: "candidate-1",
                    metadata: { provider: "google" }
                });
                const duplicate = store.saveRoute({
                    route: { ...buildRoute("agent-planned"), name: "Renamed" },
                    source: "agent"
                });

                assertEqual(first.created, true);
                assertEqual(duplicate.created, false);
                assertEqual(first.id, duplicate.id);
                assertEqual(store.listRoutes().length, 1);
                assertEqual(store.getRoute(first.id).agentPlanId, "plan-1");
                assertEqual(store.getRoute(first.id).metadata.provider, "google");
                assertEqual(store.getRoute(first.id).route.source, "agent-planned");
            }
        },
        {
            name: "stores continuation progress separately and clears it at completion",
            run() {
                const store = createTestStore();
                const saved = store.saveRoute({ route: buildRoute("gpx"), source: "gpx" });

                const paused = store.saveProgress(saved.id, {
                    resumeDistanceMeters: 420,
                    startedAt: "2026-08-24T08:00:00Z"
                });
                assertEqual(paused.resumeDistanceMeters, 420);
                assertEqual(paused.progressStatus, "paused");

                const completed = store.saveProgress(saved.id, { resumeDistanceMeters: 1000 });
                assertEqual(completed.resumeDistanceMeters, 0);
                assertEqual(completed.progressStatus, null);
            }
        },
        {
            name: "renames and deletes routes with their progress",
            run() {
                const store = createTestStore();
                const saved = store.saveRoute({ route: buildRoute("map-drawn"), source: "map-draw" });
                store.saveProgress(saved.id, { resumeDistanceMeters: 200 });

                assertEqual(store.renameRoute(saved.id, "New name").name, "New name");
                assertEqual(store.deleteRoute(saved.id).id, saved.id);
                assertEqual(store.listRoutes().length, 0);
            }
        },
        {
            name: "restores Rider domain sources for legacy normalized route json",
            run() {
                const store = createTestStore();
                const saved = store.saveRoute({
                    route: { ...buildRoute("map-drawn"), source: "map-draw" },
                    source: "map-draw"
                });
                assertEqual(store.getRoute(saved.id).route.source, "map-drawn");
            }
        }
    ]
};

function createTestStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rider-route-library-"));
    const database = initializeManagedTestDatabase(path.join(directory, "routes.db"));
    return createRouteLibraryStore(database);
}

function buildRoute(source) {
    return {
        source,
        name: "Test route",
        totalDistanceMeters: 1000,
        totalElevationGainMeters: source === "gpx" ? 80 : 0,
        hasElevationData: source === "gpx",
        points: [
            { latitude: 31.1, longitude: 121.1, distanceMeters: 0, elevationMeters: 10 },
            { latitude: 31.2, longitude: 121.2, distanceMeters: 1000, elevationMeters: 90 }
        ]
    };
}
