import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "rider-tracker.db");
const ROUTE_SOURCES = new Set(["gpx", "agent", "map-draw", "exploration", "manual", "imported"]);

export function createRouteLibraryStore(filePath = process.env.RIDER_TRACKER_DB_PATH || DEFAULT_DB_PATH) {
    const dbPath = path.resolve(filePath);
    let initialized = false;

    function initialize() {
        if (initialized) return;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        if (isManagedDatabase()) {
            withDatabase((db) => assertManagedSchema(db));
        } else {
            withDatabase((db) => createStandaloneSchema(db));
        }
        initialized = true;
    }

    function saveRoute(input = {}) {
        initialize();
        const normalized = normalizeSavedRoute(input);
        return withDatabase((db) => {
            const existing = db.prepare(`
                SELECT id, created_at, agent_plan_id, agent_candidate_id, metadata_json
                FROM saved_routes WHERE fingerprint = ?
            `).get(normalized.fingerprint);
            const now = new Date().toISOString();
            const id = String(existing?.id || crypto.randomUUID());
            const createdAt = String(existing?.created_at || now);
            const agentPlanId = normalized.agentPlanId || existing?.agent_plan_id || null;
            const agentCandidateId = normalized.agentCandidateId || existing?.agent_candidate_id || null;
            const metadata = {
                ...parseObject(existing?.metadata_json),
                ...normalized.metadata
            };
            db.prepare(`
                INSERT INTO saved_routes (
                    id, source, name, import_file_name, fingerprint, route_json,
                    original_gpx_text, total_distance_meters,
                    total_elevation_gain_meters, has_elevation_data,
                    agent_plan_id, agent_candidate_id, metadata_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    source = excluded.source,
                    name = excluded.name,
                    import_file_name = COALESCE(excluded.import_file_name, saved_routes.import_file_name),
                    route_json = excluded.route_json,
                    original_gpx_text = COALESCE(excluded.original_gpx_text, saved_routes.original_gpx_text),
                    total_distance_meters = excluded.total_distance_meters,
                    total_elevation_gain_meters = excluded.total_elevation_gain_meters,
                    has_elevation_data = excluded.has_elevation_data,
                    agent_plan_id = COALESCE(excluded.agent_plan_id, saved_routes.agent_plan_id),
                    agent_candidate_id = COALESCE(excluded.agent_candidate_id, saved_routes.agent_candidate_id),
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
            `).run(
                id, normalized.source, normalized.name, normalized.importFileName,
                normalized.fingerprint, JSON.stringify(normalized.route), normalized.originalGpxText,
                normalized.totalDistanceMeters, normalized.totalElevationGainMeters,
                normalized.hasElevationData ? 1 : 0, agentPlanId,
                agentCandidateId, JSON.stringify(metadata), createdAt, now
            );
            return { ...readRoute(db, id), created: !existing };
        });
    }

    function listRoutes({ source = "" } = {}) {
        initialize();
        return withDatabase((db) => {
            const rows = source
                ? db.prepare(`${ROUTE_SUMMARY_SQL} WHERE r.source = ? ORDER BY r.updated_at DESC`).all(normalizeSource(source))
                : db.prepare(`${ROUTE_SUMMARY_SQL} ORDER BY r.updated_at DESC`).all();
            return rows.map(normalizeRouteRow);
        });
    }

    function getRoute(id) {
        initialize();
        return withDatabase((db) => readRoute(db, normalizeId(id)));
    }

    function renameRoute(id, name) {
        initialize();
        const routeId = normalizeId(id);
        const nextName = normalizeText(name, "", 160);
        if (!nextName) throw new Error("Route name is required.");
        return withDatabase((db) => {
            const result = db.prepare("UPDATE saved_routes SET name = ?, updated_at = ? WHERE id = ?")
                .run(nextName, new Date().toISOString(), routeId);
            if (result.changes === 0) throw new Error("Saved route not found.");
            return readRoute(db, routeId);
        });
    }

    function deleteRoute(id) {
        initialize();
        const routeId = normalizeId(id);
        return withDatabase((db) => {
            const route = readRoute(db, routeId);
            if (!route) throw new Error("Saved route not found.");
            db.prepare("DELETE FROM saved_routes WHERE id = ?").run(routeId);
            return route;
        });
    }

    function saveProgress(id, { resumeDistanceMeters, lastActivityId = null, startedAt = null } = {}) {
        initialize();
        const routeId = normalizeId(id);
        return withDatabase((db) => {
            const route = readRoute(db, routeId);
            if (!route) throw new Error("Saved route not found.");
            const distance = clampDistance(resumeDistanceMeters, route.totalDistanceMeters);
            if (distance <= 0 || distance >= route.totalDistanceMeters - 10) {
                db.prepare("DELETE FROM route_progress WHERE route_id = ?").run(routeId);
                return readRoute(db, routeId);
            }
            const now = new Date().toISOString();
            db.prepare(`
                INSERT INTO route_progress (
                    route_id, resume_distance_meters, last_activity_id,
                    status, started_at, updated_at
                ) VALUES (?, ?, ?, 'paused', ?, ?)
                ON CONFLICT(route_id) DO UPDATE SET
                    resume_distance_meters = excluded.resume_distance_meters,
                    last_activity_id = excluded.last_activity_id,
                    status = excluded.status,
                    started_at = COALESCE(excluded.started_at, route_progress.started_at),
                    updated_at = excluded.updated_at
            `).run(routeId, distance, normalizeOptionalText(lastActivityId), normalizeOptionalText(startedAt), now);
            return readRoute(db, routeId);
        });
    }

    function clearProgress(id) {
        initialize();
        const routeId = normalizeId(id);
        return withDatabase((db) => {
            if (!readRoute(db, routeId)) throw new Error("Saved route not found.");
            db.prepare("DELETE FROM route_progress WHERE route_id = ?").run(routeId);
            return readRoute(db, routeId);
        });
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
        saveRoute,
        listRoutes,
        getRoute,
        renameRoute,
        deleteRoute,
        saveProgress,
        clearProgress
    };
}

const ROUTE_SUMMARY_SQL = `
    SELECT r.id, r.source, r.name, r.import_file_name AS importFileName,
           r.total_distance_meters AS totalDistanceMeters,
           r.total_elevation_gain_meters AS totalElevationGainMeters,
           r.has_elevation_data AS hasElevationData,
           r.agent_plan_id AS agentPlanId,
           r.agent_candidate_id AS agentCandidateId,
           r.metadata_json AS metadataJson,
           r.created_at AS createdAt, r.updated_at AS updatedAt,
           p.resume_distance_meters AS resumeDistanceMeters,
           p.last_activity_id AS lastActivityId,
           p.status AS progressStatus, p.started_at AS progressStartedAt,
           p.updated_at AS progressUpdatedAt
    FROM saved_routes AS r
    LEFT JOIN route_progress AS p ON p.route_id = r.id
`;

function readRoute(db, id) {
    const row = db.prepare(`
        SELECT r.id, r.source, r.name, r.import_file_name AS importFileName,
               r.total_distance_meters AS totalDistanceMeters,
               r.total_elevation_gain_meters AS totalElevationGainMeters,
               r.has_elevation_data AS hasElevationData,
               r.agent_plan_id AS agentPlanId,
               r.agent_candidate_id AS agentCandidateId,
               r.metadata_json AS metadataJson,
               r.created_at AS createdAt, r.updated_at AS updatedAt,
               r.route_json AS routeJson, r.original_gpx_text AS originalGpxText,
               p.resume_distance_meters AS resumeDistanceMeters,
               p.last_activity_id AS lastActivityId,
               p.status AS progressStatus, p.started_at AS progressStartedAt,
               p.updated_at AS progressUpdatedAt
        FROM saved_routes AS r
        LEFT JOIN route_progress AS p ON p.route_id = r.id
        WHERE r.id = ? LIMIT 1
    `)
        .get(id);
    if (!row) return null;
    const route = parseObject(row.routeJson);
    return route ? {
        ...normalizeRouteRow(row),
        route: { ...route, source: restoreDomainSource(route.source, row.source) },
        originalGpxText: row.originalGpxText ?? null
    } : null;
}

function normalizeSavedRoute({ route, source, name, originalGpxText = null, agentPlanId = null, agentCandidateId = null, metadata = {} }) {
    if (!route || !Array.isArray(route.points) || route.points.length < 2) {
        throw new Error("A route with at least two coordinate points is required.");
    }
    const points = route.points.filter((point) => validCoordinate(point));
    if (points.length < 2) throw new Error("Route has no usable coordinates.");
    const totalDistanceMeters = finiteOrZero(route.totalDistanceMeters);
    if (totalDistanceMeters <= 0) throw new Error("Route has no usable distance.");
    const resolvedSource = normalizeSource(source || route.source);
    const cleanRoute = JSON.parse(JSON.stringify({
        ...route,
        source: restoreDomainSource(route.source, resolvedSource),
        points,
        isDraft: false,
        continuation: null,
        savedRouteId: undefined,
        routeLibraryResumeDistanceMeters: undefined
    }));
    return {
        source: resolvedSource,
        name: normalizeText(name || route.name, "保存的路线", 160),
        importFileName: normalizeOptionalText(route.importFileName),
        fingerprint: buildRouteFingerprint(points),
        route: cleanRoute,
        originalGpxText: typeof originalGpxText === "string" ? originalGpxText : null,
        totalDistanceMeters,
        totalElevationGainMeters: finiteOrZero(route.totalElevationGainMeters),
        hasElevationData: route.hasElevationData === true,
        agentPlanId: normalizeOptionalText(agentPlanId || route.agentPlanId),
        agentCandidateId: normalizeOptionalText(agentCandidateId || route.agentCandidateId),
        metadata: isObject(metadata) ? metadata : {}
    };
}

function buildRouteFingerprint(points) {
    const geometry = points.map((point) => [
        Number(point.latitude ?? point.lat).toFixed(6),
        Number(point.longitude ?? point.lng).toFixed(6)
    ]);
    return crypto.createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
}

function normalizeRouteRow(row) {
    return {
        id: String(row.id),
        source: String(row.source),
        name: String(row.name),
        importFileName: row.importFileName ?? null,
        totalDistanceMeters: finiteOrZero(row.totalDistanceMeters),
        totalElevationGainMeters: finiteOrZero(row.totalElevationGainMeters),
        hasElevationData: Boolean(row.hasElevationData),
        agentPlanId: row.agentPlanId ?? null,
        agentCandidateId: row.agentCandidateId ?? null,
        metadata: parseObject(row.metadataJson),
        resumeDistanceMeters: finiteOrZero(row.resumeDistanceMeters),
        lastActivityId: row.lastActivityId ?? null,
        progressStatus: row.progressStatus ?? null,
        progressStartedAt: row.progressStartedAt ?? null,
        progressUpdatedAt: row.progressUpdatedAt ?? null,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt)
    };
}

function createStandaloneSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS saved_routes (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL,
            import_file_name TEXT, fingerprint TEXT NOT NULL UNIQUE,
            route_json TEXT NOT NULL, original_gpx_text TEXT,
            total_distance_meters REAL NOT NULL,
            total_elevation_gain_meters REAL NOT NULL DEFAULT 0,
            has_elevation_data INTEGER NOT NULL DEFAULT 0,
            agent_plan_id TEXT, agent_candidate_id TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS route_progress (
            route_id TEXT PRIMARY KEY, resume_distance_meters REAL NOT NULL DEFAULT 0,
            last_activity_id TEXT, status TEXT NOT NULL DEFAULT 'paused',
            started_at TEXT, updated_at TEXT NOT NULL,
            FOREIGN KEY(route_id) REFERENCES saved_routes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_saved_routes_updated_at ON saved_routes(updated_at DESC);
    `);
}

function assertManagedSchema(db) {
    for (const table of ["saved_routes", "route_progress"]) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!exists) throw new Error("Unified route database is not initialized. Run npm run db:migrate.");
    }
    const columns = new Set(db.prepare("PRAGMA table_info(saved_routes)").all().map((row) => row.name));
    for (const required of ["agent_plan_id", "agent_candidate_id", "metadata_json"]) {
        if (!columns.has(required)) throw new Error("Unified route database is outdated. Run npm run db:migrate.");
    }
}

function normalizeSource(value) {
    const source = String(value || "").trim().toLowerCase();
    const aliases = {
        "agent-planned": "agent",
        "map-drawn": "map-draw",
        "osm-exploration": "exploration"
    };
    const normalized = aliases[source] || source;
    if (!ROUTE_SOURCES.has(normalized)) throw new Error(`Unsupported route source: ${value}`);
    return normalized;
}

function restoreDomainSource(value, storedSource) {
    const source = String(value || "").trim().toLowerCase();
    if (["agent-planned", "map-drawn", "osm-exploration", "gpx", "manual"].includes(source)) {
        return source;
    }
    const normalized = normalizeSource(storedSource || value);
    return {
        agent: "agent-planned",
        "map-draw": "map-drawn",
        exploration: "osm-exploration"
    }[normalized] || normalized;
}

function normalizeId(value) {
    const id = String(value || "").trim();
    if (!id || id.length > 128) throw new Error("Route id is required.");
    return id;
}

function validCoordinate(point) {
    const latitude = Number(point?.latitude ?? point?.lat);
    const longitude = Number(point?.longitude ?? point?.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
        && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function clampDistance(value, total) {
    return Math.min(Math.max(0, finiteOrZero(value)), finiteOrZero(total));
}

function finiteOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function normalizeText(value, fallback, maxLength) {
    return String(value ?? "").trim().slice(0, maxLength) || fallback;
}

function normalizeOptionalText(value) {
    const text = String(value ?? "").trim();
    return text || null;
}

function parseObject(value) {
    if (isObject(value)) return value;
    try {
        const parsed = JSON.parse(String(value || "{}"));
        return isObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isManagedDatabase() {
    return ["1", "true", "yes", "on"].includes(
        String(process.env.RIDER_DATABASE_MANAGED || "").trim().toLowerCase()
    );
}
