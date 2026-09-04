import { spawnSync } from "node:child_process";
import path from "node:path";

export function ensureManagedDatabase({
    python,
    projectRoot,
    env = process.env,
    spawnImpl = spawnSync
}) {
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
