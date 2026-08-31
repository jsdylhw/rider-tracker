import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { assertManagedDatabaseSchema } from "../src/server/managed-database.js";

const REQUIRED_TABLES = [
    "activities", "activity_reports", "activity_facts", "activity_artifacts",
    "athlete_profiles", "analysis_navigation", "analysis_results", "route_plans",
    "route_plan_revisions", "saved_routes", "route_progress", "chat_sessions"
];

export function ensureManagedDatabase({
    python,
    projectRoot,
    env = process.env,
    spawnImpl = spawnSync,
    databaseReadyImpl = isManagedDatabaseReady
}) {
    const databasePath = env.RIDER_TRACKER_DB_PATH || path.join(projectRoot, "data", "rider-tracker.db");
    if (databaseReadyImpl(databasePath)) return;
    const result = spawnImpl(python, [
        path.join(projectRoot, "scripts", "database-tool.py"),
        "ensure",
        "--quiet"
    ], {
        cwd: projectRoot,
        env,
        encoding: "utf8"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "数据库预检失败。只会在首次启动或结构升级时迁移。").trim();
        throw new Error(detail);
    }
}

function isManagedDatabaseReady(databasePath) {
    if (!fs.existsSync(databasePath)) return false;
    let database;
    try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        assertManagedDatabaseSchema(database, { tables: REQUIRED_TABLES });
        return true;
    } catch {
        return false;
    } finally {
        database?.close();
    }
}
