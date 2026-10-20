import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { trainingAgentRoot, loadPythonRuntime, validatePython, reportPython, pythonInstallationTarget } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
const { values } = parseArgs({ options: { venv: { type: "string" } } });
// A separate destination lets the installation smoke test exercise this exact flow.
let runtime;
try { runtime = validatePython(loadPythonRuntime(projectRoot), projectRoot); }
catch (error) { console.error(`[rider] ${error.message}`); process.exit(1); }
reportPython(runtime);
const { runtime: target, venvRoot } = pythonInstallationTarget(runtime, projectRoot, values.venv);
if (venvRoot && !existsSync(venvRoot)) {
    run(runtime.executable, ["-m", "venv", venvRoot], projectRoot);
}
let python;
try { python = validatePython(target, projectRoot).executable; }
catch (error) { console.error(`[rider] ${error.message}`); process.exit(1); }
console.log(`[rider] Installing dependencies into: ${python}`);
run(python, ["-m", "pip", "install", "-e", ".[test]"], agentRoot);
console.log("[rider-tracker] Training Agent Python environment is ready.");

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, env: runtime.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
