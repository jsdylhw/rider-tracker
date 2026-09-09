import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonExecutable, trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
const python = resolvePythonExecutable(projectRoot);
const result = spawnSync(python, ["-m", "pytest", "-q"], {
    cwd: agentRoot,
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: agentRoot }
});

if (result.error) throw result.error;
process.exit(result.status || 0);
