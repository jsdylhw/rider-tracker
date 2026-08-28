// Mirrored from Python storage.database.SCHEMA_VERSION. The Python
// architecture test fails if these values drift; Python remains DDL owner.
export const MANAGED_DATABASE_SCHEMA_VERSION = 9;

export function assertManagedDatabaseSchema(db, requirements = {}) {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    const expectedVersion = Number(requirements.schemaVersion ?? MANAGED_DATABASE_SCHEMA_VERSION);
    if (!Number.isInteger(version) || version !== expectedVersion) {
        throw schemaError(`user_version ${version}; expected ${expectedVersion}`);
    }
    for (const table of requirements.tables ?? []) {
        const exists = db.prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table);
        if (!exists) throw schemaError(`missing table ${table}`);
    }
    for (const [table, requiredColumns] of Object.entries(requirements.columns ?? {})) {
        const available = new Set(db.prepare(`PRAGMA table_info(${safeIdentifier(table)})`).all()
            .map((row) => String(row.name)));
        const missing = requiredColumns.filter((name) => !available.has(name));
        if (missing.length) throw schemaError(`missing ${table} columns: ${missing.join(", ")}`);
    }
    return version;
}

function safeIdentifier(value) {
    const identifier = String(value);
    if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) throw new Error("invalid schema identifier");
    return identifier;
}

function schemaError(reason) {
    return new Error(`Unified database schema is unavailable (${reason}). Run npm run db:migrate.`);
}
