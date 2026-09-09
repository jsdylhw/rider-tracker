import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trainingAgentRoot } from "./python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const agentRoot = trainingAgentRoot(projectRoot);
const venvRoot = path.join(agentRoot, ".venv");
const bootstrapPython = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");

if (!existsSync(venvRoot)) {
    run(bootstrapPython, ["-m", "venv", venvRoot], projectRoot);
}

const python = process.platform === "win32"
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");
run(python, ["-m", "pip", "install", "-e", ".", "pytest"], agentRoot);
console.log("[rider-tracker] Training Agent Python environment is ready.");

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
