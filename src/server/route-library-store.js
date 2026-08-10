import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "rider-tracker.db");

export function createRouteLibraryStore(filePath = process.env.RIDER_TRACKER_DB_PATH || DEFAULT_DB_PATH) {
    const dbPath = path.resolve(filePath);
    let initialized = false;

    function initialize() {
        if (initialized) return;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        runSql(`
            CREATE TABLE IF NOT EXISTS saved_routes (
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
                resume_distance_meters REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_saved_routes_updated_at ON saved_routes(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_saved_routes_source ON saved_routes(source);
        `);
        ensureRouteColumns([
            { name: "resume_distance_meters", definition: "REAL NOT NULL DEFAULT 0" }
        ]);
        initialized = true;
    }

    function saveGpxRoute({ route, originalGpxText = null } = {}) {
        initialize();
        const savedRoute = normalizeGpxRoute(route, originalGpxText);
        const existing = getRouteByFingerprint(savedRoute.fingerprint);
        const now = new Date().toISOString();
        const id = existing?.id ?? crypto.randomUUID();
        const createdAt = existing?.createdAt ?? now;

        runSql(`
            INSERT INTO saved_routes (
                id, source, name, import_file_name, fingerprint, route_json, original_gpx_text,
                total_distance_meters, total_elevation_gain_meters, has_elevation_data, created_at, updated_at
            ) VALUES (
                ${sqlValue(id)}, ${sqlValue(savedRoute.source)}, ${sqlValue(savedRoute.name)}, ${sqlValue(savedRoute.importFileName)},
                ${sqlValue(savedRoute.fingerprint)}, ${sqlValue(savedRoute.routeJson)}, ${sqlValue(savedRoute.originalGpxText)},
                ${sqlValue(savedRoute.totalDistanceMeters)}, ${sqlValue(savedRoute.totalElevationGainMeters)}, ${sqlValue(savedRoute.hasElevationData ? 1 : 0)},
                ${sqlValue(createdAt)}, ${sqlValue(now)}
            )
            ON CONFLICT(fingerprint) DO UPDATE SET
                name = excluded.name,
                import_file_name = excluded.import_file_name,
                route_json = excluded.route_json,
                original_gpx_text = COALESCE(excluded.original_gpx_text, saved_routes.original_gpx_text),
                total_distance_meters = excluded.total_distance_meters,
                total_elevation_gain_meters = excluded.total_elevation_gain_meters,
                has_elevation_data = excluded.has_elevation_data,
                updated_at = excluded.updated_at;
        `);

        return { ...getRoute(id), created: !existing };
    }

    function listRoutes({ source = "gpx" } = {}) {
        initialize();
        return queryRows(`
            SELECT
                id,
                source,
                name,
                import_file_name AS importFileName,
                total_distance_meters AS totalDistanceMeters,
                total_elevation_gain_meters AS totalElevationGainMeters,
                has_elevation_data AS hasElevationData,
                resume_distance_meters AS resumeDistanceMeters,
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM saved_routes
            WHERE source = ${sqlValue(source)}
            ORDER BY updated_at DESC;
        `).map(normalizeRouteSummary);
    }

    function getRoute(id) {
        initialize();
        const row = queryRows(`
            SELECT
                id,
                source,
                name,
                import_file_name AS importFileName,
                route_json AS routeJson,
                total_distance_meters AS totalDistanceMeters,
                total_elevation_gain_meters AS totalElevationGainMeters,
                has_elevation_data AS hasElevationData,
                resume_distance_meters AS resumeDistanceMeters,
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM saved_routes
            WHERE id = ${sqlValue(id)}
            LIMIT 1;
        `)[0];
        if (!row) return null;
        const route = parseRouteJson(row.routeJson);
        return route ? { ...normalizeRouteSummary(row), route } : null;
    }

    function getRouteByFingerprint(fingerprint) {
        const row = queryRows(`
            SELECT id FROM saved_routes WHERE fingerprint = ${sqlValue(fingerprint)} LIMIT 1;
        `)[0];
        return row ? getRoute(row.id) : null;
    }

    function deleteRoute(id) {
        initialize();
        const route = getRoute(id);
        if (!route) throw new Error("Saved route not found.");
        runSql(`DELETE FROM saved_routes WHERE id = ${sqlValue(id)};`);
        return route;
    }

    function updateResumeDistance(id, distanceMeters) {
        initialize();
        const route = getRoute(id);
        if (!route) throw new Error("Saved route not found.");
        const nextDistance = clampDistance(distanceMeters, route.totalDistanceMeters);
        runSql(`
            UPDATE saved_routes
            SET resume_distance_meters = ${sqlValue(nextDistance)}, updated_at = ${sqlValue(new Date().toISOString())}
            WHERE id = ${sqlValue(id)};
        `);
        return getRoute(id);
    }

    function runSql(sql) {
        withDatabase((db) => db.exec(sql));
    }

    function queryRows(sql) {
        return withDatabase((db) => db.prepare(sql).all());
    }

    function ensureRouteColumns(columns) {
        const existingColumns = new Set(queryRows("PRAGMA table_info(saved_routes);").map((column) => column.name));
        columns.forEach((column) => {
            if (!existingColumns.has(column.name)) {
                runSql(`ALTER TABLE saved_routes ADD COLUMN ${column.name} ${column.definition};`);
            }
        });
    }

    function withDatabase(callback) {
        const db = new DatabaseSync(dbPath);
        try {
            return callback(db);
        } finally {
            db.close();
        }
    }

    return {
        filePath: dbPath,
        initialize,
        saveGpxRoute,
        listRoutes,
        getRoute,
        updateResumeDistance,
        deleteRoute
    };
}

function normalizeGpxRoute(route, originalGpxText) {
    if (route?.source !== "gpx" || !Array.isArray(route?.points) || route.points.length < 2) {
        throw new Error("A parsed GPX route with at least two points is required.");
    }
    const points = route.points.filter((point) => (
        Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
    ));
    if (points.length < 2) throw new Error("GPX route has no valid coordinates.");

    const totalDistanceMeters = finiteOrZero(route.totalDistanceMeters);
    if (totalDistanceMeters <= 0) throw new Error("GPX route has no usable distance.");

    const cleanRoute = JSON.parse(JSON.stringify({
        ...route,
        source: "gpx",
        points
    }));
    return {
        source: "gpx",
        name: normalizeText(route.name, "GPX 路线", 160),
        importFileName: normalizeText(route.importFileName, "", 200) || null,
        fingerprint: buildRouteFingerprint(points),
        routeJson: JSON.stringify(cleanRoute),
        originalGpxText: typeof originalGpxText === "string" ? originalGpxText : null,
        totalDistanceMeters,
        totalElevationGainMeters: finiteOrZero(route.totalElevationGainMeters),
        hasElevationData: route.hasElevationData === true
    };
}

function buildRouteFingerprint(points) {
    const geometry = points.map((point) => [
        Number(point.latitude).toFixed(6),
        Number(point.longitude).toFixed(6)
    ]);
    return crypto.createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
}

function parseRouteJson(value) {
    try {
        const route = JSON.parse(value);
        return route?.source === "gpx" && Array.isArray(route.points) ? route : null;
    } catch (_error) {
        return null;
    }
}

function normalizeRouteSummary(row) {
    return {
        ...row,
        totalDistanceMeters: finiteOrZero(row.totalDistanceMeters),
        totalElevationGainMeters: finiteOrZero(row.totalElevationGainMeters),
        resumeDistanceMeters: finiteOrZero(row.resumeDistanceMeters),
        hasElevationData: Boolean(row.hasElevationData)
    };
}

function clampDistance(value, totalDistanceMeters) {
    return Math.min(Math.max(0, finiteOrZero(value)), finiteOrZero(totalDistanceMeters));
}

function normalizeText(value, fallback, maxLength) {
    const text = String(value ?? "").trim().slice(0, maxLength);
    return text || fallback;
}

function finiteOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function sqlValue(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    return `'${String(value).replaceAll("'", "''")}'`;
}
