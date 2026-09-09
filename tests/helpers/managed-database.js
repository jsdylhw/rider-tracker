import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonExecutable } from "../../scripts/python-runtime.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let templatePath = null;

export function initializeManagedTestDatabase(target) {
    ensureTemplate();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(templatePath, target);
    return target;
}

function ensureTemplate() {
    if (templatePath && fs.existsSync(templatePath)) return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rider-managed-db-template-"));
    templatePath = path.join(directory, "rider-tracker.db");
    const python = resolvePythonExecutable(projectRoot, {});
    const result = spawnSync(python, [
        path.join(projectRoot, "scripts", "database-tool.py"),
        "init", "--database", templatePath,
    ], { cwd: projectRoot, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`Python database migration failed: ${result.stderr || result.stdout}`);
    }
}
