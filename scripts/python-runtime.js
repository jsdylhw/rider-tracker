import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { loadUnifiedConfig } from "./local-config.js";

export function loadPythonRuntime(projectRoot, supplied = process.env) {
    const env = { ...supplied };
    dotenv.config({ path: env.RIDER_ENV_PATH || path.join(projectRoot, ".env"), processEnv: env, quiet: true });
    let values;
    try { ({ values } = loadUnifiedConfig(projectRoot, env)); }
    catch { throw new Error("Configuration could not be loaded. Check YAML syntax and permissions."); }
    const configured = String(values.training_agent?.python_executable || "").trim();
    let source = env.PYTHON_EXECUTABLE?.trim() ? "PYTHON_EXECUTABLE" : configured ? "config" : null;
    if (source) env.PYTHON_EXECUTABLE = source === "config" ? configured : env.PYTHON_EXECUTABLE.trim();
    else delete env.PYTHON_EXECUTABLE;
    let executable = resolvePythonExecutable(projectRoot, env);
    if (source && (executable.includes("/") || executable.includes("\\"))) {
        executable = path.resolve(projectRoot, executable);
        env.PYTHON_EXECUTABLE = executable;
    }
    source ||= executable === "python" || executable === "python3" ? "PATH" : "project .venv";
    return { executable, source, env, values, explicit: source === "config" || source === "PYTHON_EXECUTABLE" };
}

export function validatePython(runtime, projectRoot, run = spawnSync) {
    const result = run(runtime.executable, ["-c", "import sys,json; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))"], {
        cwd: projectRoot, env: runtime.env, encoding: "utf8", timeout: 10000, windowsHide: true
    });
    let info;
    try { info = JSON.parse(result.stdout || ""); } catch { /* Safe error below. */ }
    if (result.error || result.status !== 0 || !info?.executable || !Array.isArray(info.version)) {
        throw new Error(`Python from ${runtime.source} could not run. Check the interpreter path and Windows application aliases; no fallback was attempted.`);
    }
    if (info.version[0] < 3 || (info.version[0] === 3 && info.version[1] < 12)) {
        throw new Error(`Python ${info.version.join(".")} from ${runtime.source} is unsupported; Python 3.12+ is required.`);
    }
    return { ...runtime, executable: info.executable, version: info.version.join(".") };
}

export function reportPython(runtime) {
    console.error(`[rider] Python: ${runtime.executable} (${runtime.version}; source: ${runtime.source})`);
}


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

export function pythonInstallationTarget(runtime, projectRoot, venv) {
    if (runtime.explicit && !venv) return { runtime, venvRoot: null };
    const venvRoot = venv ? path.resolve(projectRoot, venv) : path.join(trainingAgentRoot(projectRoot), ".venv");
    return { venvRoot, runtime: { ...runtime,
        executable: path.join(venvRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        source: "installation .venv"
    } };
}
