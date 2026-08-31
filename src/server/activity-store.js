import crypto from "node:crypto";
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

    function saveRiderSession(session, options = {}) {
        initialize();

        const activity = normalizeRiderSession(session, options);
        runSql(`
            INSERT INTO activities (
                id,
                source,
                sport_type,
                name,
                started_at,
                finished_at,
                elapsed_seconds,
                distance_km,
                ascent_meters,
                average_power,
                normalized_power,
                average_hr,
                estimated_tss,
                has_gps_track,
                raw_json,
                created_at,
                updated_at
            ) VALUES (
                ${sqlValue(activity.id)},
                ${sqlValue(activity.source)},
                ${sqlValue(activity.sportType)},
                ${sqlValue(activity.name)},
                ${sqlValue(activity.startedAt)},
                ${sqlValue(activity.finishedAt)},
                ${sqlValue(activity.elapsedSeconds)},
                ${sqlValue(activity.distanceKm)},
                ${sqlValue(activity.ascentMeters)},
                ${sqlValue(activity.averagePower)},
                ${sqlValue(activity.normalizedPower)},
                ${sqlValue(activity.averageHr)},
                ${sqlValue(activity.estimatedTss)},
                ${sqlValue(activity.hasGpsTrack ? 1 : 0)},
                ${sqlValue(JSON.stringify(session))},
                ${sqlValue(activity.createdAt)},
                ${sqlValue(activity.updatedAt)}
            )
            ON CONFLICT(id) DO UPDATE SET
                source = excluded.source,
                sport_type = excluded.sport_type,
                name = excluded.name,
                finished_at = excluded.finished_at,
                elapsed_seconds = excluded.elapsed_seconds,
                distance_km = excluded.distance_km,
                ascent_meters = excluded.ascent_meters,
                average_power = excluded.average_power,
                normalized_power = excluded.normalized_power,
                average_hr = excluded.average_hr,
                estimated_tss = excluded.estimated_tss,
                has_gps_track = excluded.has_gps_track,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at;
        `);

        return getActivity(activity.id);
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
        saveRiderSession,
        getActivity,
        updateActivityFitFile,
        updateActivityRoute
    };
}

function normalizeRiderSession(session, options = {}) {
    if (!session || typeof session !== "object") {
        throw new Error("Rider session payload is required.");
    }

    const metrics = session.summary?.metrics ?? {};
    const ride = metrics.ride ?? {};
    const power = metrics.power ?? {};
    const heartRate = metrics.heartRate ?? {};
    const load = metrics.load ?? {};
    const now = new Date().toISOString();
    const startedAt = session.startedAt ?? session.createdAt ?? now;
    const id = options.id || session.activityId || session.id || buildStableSessionId(session, startedAt);
    const name = normalizeText(
        options.name || session.exportMetadata?.activityName || session.name,
        "Rider Tracker Virtual Ride",
        120
    );

    return {
        id,
        source: options.source || session.source || "rider-tracker",
        sportType: options.sportType || inferSportType(session),
        name,
        startedAt,
        finishedAt: session.finishedAt ?? session.completedAt ?? null,
        elapsedSeconds: finiteOrNull(ride.elapsedSeconds ?? session.summary?.elapsedSeconds),
        distanceKm: finiteOrNull(ride.distanceKm ?? session.summary?.distanceKm),
        ascentMeters: finiteOrNull(ride.ascentMeters ?? session.summary?.ascentMeters),
        averagePower: finiteOrNull(power.averageWatts ?? session.summary?.averagePower),
        normalizedPower: finiteOrNull(power.normalizedPowerWatts),
        averageHr: finiteOrNull(heartRate.averageBpm ?? session.summary?.averageHeartRate),
        estimatedTss: finiteOrNull(load.estimatedTss),
        hasGpsTrack: Boolean(session.hasGpsTrack) || sessionHasGpsTrack(session),
        createdAt: now,
        updatedAt: now
    };
}

function buildStableSessionId(session, startedAt) {
    const fingerprint = [
        "rider-tracker",
        startedAt,
        session.finishedAt ?? "",
        session.summary?.metrics?.ride?.distanceKm ?? session.summary?.distanceKm ?? "",
        session.records?.length ?? 0
    ].join(":");
    return `rt-${crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)}`;
}

function inferSportType(session) {
    if (session.exportMetadata?.markVirtualActivity === false && sessionHasGpsTrack(session)) {
        return "Ride";
    }
    return "VirtualRide";
}

function sessionHasGpsTrack(session) {
    return Array.isArray(session?.records) && session.records.some((record) => (
        Number.isFinite(record?.lat) ||
        Number.isFinite(record?.latitude) ||
        (
            Number.isFinite(record?.positionLat) &&
            Number.isFinite(record?.positionLong)
        ) ||
        Array.isArray(record?.latlng)
    ));
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

function normalizeText(value, fallback, maxLength) {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, maxLength);
}

function normalizeOptionalText(value, maxLength) {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? text.slice(0, maxLength) : null;
}
