// Resolve Python exactly as npm start does; Python owns the diagnostic checks.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPythonRuntime, validatePython } from './python-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
function fail(id, message) {
    const result = { schemaVersion: 1, ok: false, checks: [{ id, status: 'error', message }] };
    console.log(json ? JSON.stringify(result) : `[ERROR] ${id}: ${message}`);
    process.exitCode = 1;
}
try {
    const selected = loadPythonRuntime(root);
    let runtime;
    try { runtime = validatePython(selected, root); }
    catch (error) { fail('python', error.message); process.exit(1); }
    const { env } = runtime;
    env.RIDER_DOCTOR_PYTHON_SOURCE = runtime.source;
    env.RIDER_DOCTOR_NODE_VERSION = process.versions.node;
    const child = spawn(runtime.executable, [path.join(root, 'scripts/doctor.py'), ...process.argv.slice(2)], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let failed = false;
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // A failed interpreter may echo configuration or source lines; use safe summaries.
    child.stderr.on('data', () => {});
    child.once('error', () => {
        failed = true;
        fail('python', 'Python could not start. Check PYTHON_EXECUTABLE or run npm run setup:agent.');
    });
    child.once('close', code => {
        if (failed) return;
        if (!output.trim()) {
            fail('python', 'Python exited without a diagnostic report. Check PYTHON_EXECUTABLE, Python 3.12+ and Windows application aliases.');
            return;
        }
        process.stdout.write(output);
        process.exitCode = code ?? 1;
    });
} catch {
    // Parser errors can include lines containing credentials; never print them.
    fail('config', 'Configuration could not be loaded. Check YAML syntax and file permissions.');
}
