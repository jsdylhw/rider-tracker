import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePythonExecutable(projectRoot, env = process.env) {
    if (env.PYTHON_EXECUTABLE) return env.PYTHON_EXECUTABLE;

    const agentRoot = path.join(projectRoot, "services", "training-agent");
    const localPython = process.platform === "win32"
        ? path.join(agentRoot, ".venv", "Scripts", "python.exe")
        : path.join(agentRoot, ".venv", "bin", "python");
    if (existsSync(localPython)) return localPython;
    return process.platform === "win32" ? "python" : "python3";
}

export function trainingAgentRoot(projectRoot) {
    return path.join(projectRoot, "services", "training-agent");
}
