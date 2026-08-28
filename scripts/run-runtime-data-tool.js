import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildRuntimeEnv, loadUnifiedConfig } from "./local-config.js";
import { resolvePythonExecutable } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
const runtimeEnv = buildRuntimeEnv(projectRoot, loadUnifiedConfig(projectRoot), process.env);
const python = resolvePythonExecutable(projectRoot, runtimeEnv);
const operation = process.argv[2] || "audit";
const result = spawnSync(python, [path.join(projectRoot, "scripts", "runtime-data-tool.py"), operation], {
    cwd: projectRoot,
    env: runtimeEnv,
    stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status || 0);
