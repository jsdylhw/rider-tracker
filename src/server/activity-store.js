import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "rider-tracker.db");
const SQLITE_BIN = process.env.SQLITE_BIN || "sqlite3";

export function createActivityStore(filePath = process.env.RIDER_TRACKER_DB_PATH || DEFAULT_DB_PATH) {
    const dbPath = path.resolve(filePath);

    function initialize() {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        runSql(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS activities (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                sport_type TEXT NOT NULL,
                name TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                elapsed_seconds REAL,
                distance_km REAL,
                ascent_meters REAL,
                average_power REAL,
                normalized_power REAL,
                average_hr REAL,
                estimated_tss REAL,
                has_gps_track INTEGER NOT NULL DEFAULT 0,
                fit_file_path TEXT,
                fit_file_size_bytes INTEGER,
                fit_file_created_at TEXT,
                raw_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_activities_started_at ON activities(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_source ON activities(source);
            CREATE INDEX IF NOT EXISTS idx_activities_sport_type ON activities(sport_type);
        `);
        ensureActivityColumns([
            { name: "fit_file_path", definition: "TEXT" },
            { name: "fit_file_size_bytes", definition: "INTEGER" },
            { name: "fit_file_created_at", definition: "TEXT" }
        ]);
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

    function listActivities({ limit = 50 } = {}) {
        initialize();
        const safeLimit = clampInteger(limit, 1, 200, 50);
        return queryJson(`
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
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM activities
            ORDER BY COALESCE(started_at, created_at) DESC
            LIMIT ${safeLimit};
        `).map(normalizeActivityRow);
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
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM activities
            WHERE id = ${sqlValue(id)}
            LIMIT 1;
        `);
        return rows[0] ? normalizeActivityRow(rows[0]) : null;
    }

    function getActivityDetail(id) {
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
                raw_json AS rawJson,
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM activities
            WHERE id = ${sqlValue(id)}
            LIMIT 1;
        `);

        if (!rows[0]) {
            return null;
        }

        const activity = normalizeActivityRow(rows[0]);
        return {
            ...activity,
            rawSession: parseRawSession(rows[0].rawJson)
        };
    }

    function updateActivityName(id, name) {
        initialize();
        const normalizedName = normalizeText(name, "", 120);
        if (!id || !normalizedName) {
            throw new Error("Activity id and name are required.");
        }

        runSql(`
            UPDATE activities
            SET
                name = ${sqlValue(normalizedName)},
                updated_at = ${sqlValue(new Date().toISOString())}
            WHERE id = ${sqlValue(id)};
        `);

        const activity = getActivity(id);
        if (!activity) {
            throw new Error("Activity not found.");
        }
        return activity;
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

    function deleteActivity(id) {
        initialize();
        if (!id) {
            throw new Error("Activity id is required.");
        }

        const activity = getActivity(id);
        if (!activity) {
            throw new Error("Activity not found.");
        }

        runSql(`DELETE FROM activities WHERE id = ${sqlValue(id)};`);
        return activity;
    }

    function getSummary() {
        initialize();
        const rows = queryJson(`
            SELECT
                COUNT(*) AS activityCount,
                COALESCE(SUM(distance_km), 0) AS totalDistanceKm,
                COALESCE(SUM(elapsed_seconds), 0) AS totalElapsedSeconds,
                COALESCE(SUM(estimated_tss), 0) AS totalEstimatedTss
            FROM activities;
        `);
        return rows[0] ?? {
            activityCount: 0,
            totalDistanceKm: 0,
            totalElapsedSeconds: 0,
            totalEstimatedTss: 0
        };
    }

    function runSql(sql) {
        runSqliteWithSqlFile([], sql);
    }

    function queryJson(sql) {
        const output = runSqliteWithSqlFile(["-json"], sql).trim();
        return output ? JSON.parse(output) : [];
    }

    function ensureActivityColumns(columns) {
        const existingColumns = new Set(queryJson("PRAGMA table_info(activities);").map((column) => column.name));
        columns.forEach((column) => {
            if (!existingColumns.has(column.name)) {
                runSql(`ALTER TABLE activities ADD COLUMN ${column.name} ${column.definition};`);
            }
        });
    }

    function runSqliteWithSqlFile(extraArgs, sql) {
        const tempDir = fs.mkdtempSync(path.join(osTmpDir(), "rider-tracker-sql-"));
        const sqlPath = path.join(tempDir, "query.sql");
        fs.writeFileSync(sqlPath, sql, "utf8");

        try {
            const result = spawnSync(SQLITE_BIN, [
                "-batch",
                ...extraArgs,
                dbPath,
                `.read ${sqlPath}`
            ], {
                encoding: "utf8"
            });

            if (result.status !== 0) {
                throw new Error(result.stderr || result.error?.message || "sqlite3 command failed.");
            }

            return result.stdout || "";
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    return {
        filePath: dbPath,
        initialize,
        saveRiderSession,
        listActivities,
        getActivity,
        getActivityDetail,
        updateActivityName,
        updateActivityFitFile,
        deleteActivity,
        getSummary
    };
}

function parseRawSession(rawJson) {
    try {
        return rawJson ? JSON.parse(rawJson) : null;
    } catch (_error) {
        return null;
    }
}

function osTmpDir() {
    return process.env.TMPDIR || "/tmp";
}

export function normalizeRiderSession(session, options = {}) {
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
        source: "rider-tracker",
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
        hasGpsTrack: sessionHasGpsTrack(session),
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
        fitFileSizeBytes: finiteOrNull(row.fitFileSizeBytes)
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

function clampInteger(value, min, max, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
}

function normalizeText(value, fallback, maxLength) {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, maxLength);
}
