import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPythonRuntime, validatePython, reportPython, trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
let runtime;
try { runtime = validatePython(loadPythonRuntime(projectRoot), projectRoot); }
catch (error) { console.error(`[rider] ${error.message}`); process.exit(1); }
reportPython(runtime);
const python = runtime.executable;
const result = spawnSync(python, ["-m", "pytest", "-q"], {
    cwd: agentRoot,
    stdio: "inherit",
    env: { ...runtime.env, PYTHONPATH: agentRoot }
});

if (result.error) console.error("[rider] Python tests could not start.");
process.exit(result.error ? 1 : result.status ?? 1);
