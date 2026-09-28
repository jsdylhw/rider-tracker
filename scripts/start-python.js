// npm convenience entry; Python owns configuration and companion processes.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadUnifiedConfig } from './local-config.js';
import { resolvePythonExecutable } from './python-runtime.js';
import { openBrowser, shouldOpenBrowser } from './browser-launcher.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: process.env.RIDER_ENV_PATH || path.join(root, '.env'), quiet: true });
const { values } = loadUnifiedConfig(root);
const env = { ...process.env };
if (!env.PYTHON_EXECUTABLE && values.training_agent?.python_executable) {
    env.PYTHON_EXECUTABLE = String(values.training_agent.python_executable);
}
const child = spawn(resolvePythonExecutable(root, env), [
    path.join(root, 'scripts/start-rider.py'), '--public-entry', '--parent-stdin', ...process.argv.slice(2)
], { cwd: root, env, stdio: ['pipe', 'pipe', 'inherit'] });
// Closing this pipe also works on Windows; SIGTERM would force-kill Python there.
const stop = () => child.stdin.end();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.stdin.on('error', () => {}); // Child exit may close the control pipe first.
child.once('error', (error) => {
    console.error(`[rider] Python 启动失败（${error.code || 'unknown'}）；请检查 Python 环境或 PYTHON_EXECUTABLE。`);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
let opened = false;
createInterface({ input: child.stdout }).on('line', (line) => {
    console.log(line);
    const match = line.match(/^\[rider\] Python browser entry: (http:\/\/[^;\s]+)/);
    if (!opened && match && shouldOpenBrowser(env.RIDER_OPEN_BROWSER ?? values.rider?.open_browser)) {
        opened = true;
        // Preserve the public origin used by existing OAuth callbacks and cookies.
        const url = env.APP_BASE_URL || values.rider?.app_base_url || match[1].replace('://127.0.0.1:', '://localhost:');
        const result = openBrowser(url, { env });
        if (!result.opened) console.log(`[rider] 请手动打开 ${url}`);
    }
});
