import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { assertManagedDatabaseSchema } from "./managed-database.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "rider-tracker.db");

export function createActivityStore(filePath = process.env.RIDER_TRACKER_DB_PATH || DEFAULT_DB_PATH) {
    const dbPath = path.resolve(filePath);
    let initialized = false;

    function initialize() {
        if (initialized) {
            return;
        }
        if (!fs.existsSync(dbPath)) {
            throw new Error("Unified database does not exist. Run npm run db:init.");
        }
        withDatabase((db) => assertManagedDatabaseSchema(db, {
            tables: ["activities"],
            columns: { activities: [
                "id", "source", "sport_type", "name", "raw_json",
                "fit_file_path", "fit_file_size_bytes", "fit_file_created_at",
                "saved_route_id", "route_start_distance_meters", "route_end_distance_meters",
            ] }
        }));
        initialized = true;
    }

    function getActivity(id) {
        initialize();
        const rows = queryJson(`
            SELECT
                id,
                source,
                sport_type AS sportType,
                name,
                started_at AS startedAt,
                finished_at AS finishedAt,
                elapsed_seconds AS elapsedSeconds,
                distance_km AS distanceKm,
                ascent_meters AS ascentMeters,
                average_power AS averagePower,
                normalized_power AS normalizedPower,
                average_hr AS averageHr,
                estimated_tss AS estimatedTss,
                has_gps_track AS hasGpsTrack,
                fit_file_path AS fitFilePath,
                fit_file_size_bytes AS fitFileSizeBytes,
                fit_file_created_at AS fitFileCreatedAt,
                saved_route_id AS savedRouteId,
                route_start_distance_meters AS routeStartDistanceMeters,
                route_end_distance_meters AS routeEndDistanceMeters,
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM activities
            WHERE id = ${sqlValue(id)}
            LIMIT 1;
        `);
        return rows[0] ? normalizeActivityRow(rows[0]) : null;
    }

    function updateActivityFitFile(id, {
        fitFilePath,
        fitFileSizeBytes,
        fitFileCreatedAt = new Date().toISOString()
    } = {}) {
        initialize();
        if (!id || !fitFilePath) {
            throw new Error("Activity id and FIT file path are required.");
        }

        runSql(`
            UPDATE activities
            SET
                fit_file_path = ${sqlValue(fitFilePath)},
                fit_file_size_bytes = ${sqlValue(fitFileSizeBytes)},
                fit_file_created_at = ${sqlValue(fitFileCreatedAt)},
                updated_at = ${sqlValue(new Date().toISOString())}
            WHERE id = ${sqlValue(id)};
        `);

        const activity = getActivity(id);
        if (!activity) {
            throw new Error("Activity not found.");
        }
        return activity;
    }

    function updateActivityRoute(id, {
        savedRouteId,
        routeStartDistanceMeters = 0,
        routeEndDistanceMeters = 0
    } = {}) {
        initialize();
        if (!id) throw new Error("Activity id is required.");
        const normalizedRouteId = normalizeOptionalText(savedRouteId, 128);
        runSql(`
            UPDATE activities
            SET
                saved_route_id = ${sqlValue(normalizedRouteId)},
                route_start_distance_meters = ${sqlValue(finiteOrNull(routeStartDistanceMeters))},
                route_end_distance_meters = ${sqlValue(finiteOrNull(routeEndDistanceMeters))},
                updated_at = ${sqlValue(new Date().toISOString())}
            WHERE id = ${sqlValue(id)};
        `);
        const activity = getActivity(id);
        if (!activity) throw new Error("Activity not found.");
        return activity;
    }

    function runSql(sql) {
        withDatabase((db) => {
            db.exec(sql);
        });
    }

    function queryJson(sql) {
        return withDatabase((db) => db.prepare(sql).all());
    }

    function withDatabase(callback) {
        const db = new DatabaseSync(dbPath);
        try {
            db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;");
            return callback(db);
        } finally {
            db.close();
        }
    }

    return {
        filePath: dbPath,
        initialize,
        getActivity,
        updateActivityFitFile,
        updateActivityRoute
    };
}

function normalizeActivityRow(row) {
    return {
        ...row,
        elapsedSeconds: finiteOrNull(row.elapsedSeconds),
        distanceKm: finiteOrNull(row.distanceKm),
        ascentMeters: finiteOrNull(row.ascentMeters),
        averagePower: finiteOrNull(row.averagePower),
        normalizedPower: finiteOrNull(row.normalizedPower),
        averageHr: finiteOrNull(row.averageHr),
        estimatedTss: finiteOrNull(row.estimatedTss),
        hasGpsTrack: Boolean(row.hasGpsTrack),
        fitFileSizeBytes: finiteOrNull(row.fitFileSizeBytes),
        routeStartDistanceMeters: finiteOrNull(row.routeStartDistanceMeters),
        routeEndDistanceMeters: finiteOrNull(row.routeEndDistanceMeters)
    };
}

function sqlValue(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "NULL";
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : "NULL";
    }
    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }
    return `'${String(value).replaceAll("'", "''")}'`;
}

function finiteOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOptionalText(value, maxLength) {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? text.slice(0, maxLength) : null;
}
