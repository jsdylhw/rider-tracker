import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPythonRuntime, validatePython, pythonInstallationTarget } from "../../scripts/python-runtime.js";
import { assertEqual, assert } from "../helpers/test-harness.js";
function fixture(run) {
    const root = mkdtempSync(path.join(os.tmpdir(), "rider-python-test-"));
    try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
export const suite = { name: "python-runtime", tests: [
    { name: "setup and test commands actually use the configured interpreter", run() { fixture(root => {
        const project = fileURLToPath(new URL("../../", import.meta.url));
        const executable = path.join(root, "configured-python");
        const config = path.join(root, "config.yaml");
        const callsFile = path.join(root, "calls.json");
        const preload = path.join(root, "mock-python.cjs");
        writeFileSync(config, JSON.stringify({ training_agent: { python_executable: executable } }));
        writeFileSync(preload, `
            const fs = require('node:fs');
            const calls = [];
            require('node:child_process').spawnSync = (command, args) => {
                calls.push({command, args});
                fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
                return {status:0, stdout:JSON.stringify({executable:${JSON.stringify(executable)}, version:[3,13,9]})};
            };
            require('node:module').syncBuiltinESMExports();
        `);
        for (const [script, module] of [["setup-agent.js", "pip"], ["run-agent-tests.js", "pytest"]]) {
            const env = { ...process.env, RIDER_CONFIG_PATH: config, RIDER_ENV_PATH: path.join(root, "absent.env"), NODE_OPTIONS: "" };
            delete env.PYTHON_EXECUTABLE;
            const result = spawnSync(process.execPath, ["--require", preload, path.join(project, "scripts", script)], { env, encoding: "utf8" });
            assertEqual(result.status, 0, result.stderr);
            const calls = JSON.parse(readFileSync(callsFile, "utf8"));
            assert(calls.every(call => call.command === executable));
            assert(calls.some(call => call.args[0] === "-m" && call.args[1] === module));
            assertEqual(calls.some(call => call.args.includes("venv")), false);
        }
    }); } },
    { name: "setup targets explicit interpreter or isolated venv without changing startup selection", run() { fixture(root => {
        const selected = { executable: "conda-python", explicit: true, source: "config", env: {} };
        assertEqual(pythonInstallationTarget(selected, root).runtime.executable, "conda-python");
        assertEqual(pythonInstallationTarget(selected, root).venvRoot, null);
        const isolated = pythonInstallationTarget(selected, root, "scratch");
        assertEqual(isolated.venvRoot, path.join(root, "scratch"));
        assert(isolated.runtime.executable.startsWith(isolated.venvRoot));
        const defaultTarget = pythonInstallationTarget({ ...selected, explicit: false }, root);
        assertEqual(defaultTarget.venvRoot, path.join(root, "services/training-agent/.venv"));
        assertEqual(selected.executable, "conda-python");
    }); } },
    { name: "Python selection honors env then config then project venv then PATH", run() { fixture(root => {
        assertEqual(loadPythonRuntime(root, {}).source, "PATH");
        const local = path.join(root, "services/training-agent/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        mkdirSync(path.dirname(local), { recursive: true }); writeFileSync(local, "");
        assertEqual(loadPythonRuntime(root, {}).executable, local);
        writeFileSync(path.join(root, "config.yaml"), 'training_agent:\n  python_executable: ./custom/python\n');
        assertEqual(loadPythonRuntime(root, {}).executable, path.resolve(root, "custom/python"));
        assertEqual(loadPythonRuntime(root, { PYTHON_EXECUTABLE: "override" }).executable, "override");
    }); } },
    { name: "dotenv override is shared without mutating caller environment", run() { fixture(root => {
        writeFileSync(path.join(root, ".env"), "PYTHON_EXECUTABLE=from-dotenv\n");
        const env = {};
        assertEqual(loadPythonRuntime(root, env).executable, "from-dotenv");
        assertEqual(env.PYTHON_EXECUTABLE, undefined);
        assertEqual(loadPythonRuntime(root, { PYTHON_EXECUTABLE: "from-shell" }).executable, "from-shell");
    }); } },
    { name: "explicit broken or unsupported Python never falls back", run() {
        const runtime = { executable: "missing", source: "config", env: {} };
        for (const result of [{ status: 1, stdout: "" }, { status: 0, stdout: JSON.stringify({ executable: "old", version: [3,11,9] }) }, { status: null, error: new Error("timeout") }]) {
            let failed = false, calls = 0;
            try { validatePython(runtime, process.cwd(), () => { calls++; return result; }); } catch { failed = true; }
            assert(failed); assertEqual(calls, 1);
        }
        const valid = validatePython(runtime, process.cwd(), () => ({ status: 0, stdout: JSON.stringify({ executable: "/actual/python", version: [3,13,9] }) }));
        assertEqual(valid.executable, "/actual/python");
    } }
] };
